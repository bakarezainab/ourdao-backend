# Real-Time Notifications Architecture

This document describes the Server-Sent Events (SSE) and Postgres LISTEN/NOTIFY architecture that enables real-time updates from the indexer to connected frontend clients.

## Overview

The notification system couples the indexer worker and API processes through Postgres as a message bus, using LISTEN/NOTIFY to fan out lightweight change signals to connected clients over SSE. This is a fundamentally different topology from the request/response API documented in the README—it's message-passing between processes, with Postgres as the channel.

```
┌──────────────┐
│   Indexer    │
│  (worker.ts) │
└──────┬───────┘
       │
       │ 1. Fold events into derived tables
       │    (transaction)
       │
       ▼
┌──────────────────────────────────────────┐
│            Postgres                      │
│                                          │
│  ┌────────────┐    ┌─────────────────┐  │
│  │  Derived   │    │ LISTEN/NOTIFY   │  │
│  │   Tables   │    │   Channels      │  │
│  └────────────┘    └────────┬────────┘  │
│                              │           │
└──────────────────────────────┼───────────┘
                               │
       2. NOTIFY fires        │
          (after commit)       │
                               │
       ┌───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│      API Process             │
│     (index.ts)               │
│                              │
│  ┌────────────────────────┐  │
│  │  Shared LISTEN Client  │  │
│  │   (one per process)    │  │
│  └──────────┬─────────────┘  │
│             │                │
│             │ 3. Fan out     │
│             ▼                │
│  ┌──────────────────────┐   │
│  │ Connected SSE Clients│   │
│  │ (many per process)   │   │
│  └──────────┬───────────┘   │
└─────────────┼────────────────┘
              │
              │ 4. Clients receive notification
              │    and refetch via REST API
              ▼
        ┌──────────┐
        │ Frontend │
        └──────────┘
```

## The Notification Path End-to-End

### 1. Indexer folds an event

The indexer (`src/indexer/poller.ts`) polls Stellar RPC for new contract events and folds each page of events into derived tables (`members`, `loans`, `loan_proposals`, etc.) inside a single database transaction.

### 2. Transaction commits, NOTIFY fires

After the fold transaction commits successfully, the indexer calls `notifyStreamClientsAfterCommit()` (`src/api/stream.ts`) to send a Postgres NOTIFY with the channel name (e.g., `loan_proposals_changed`) and a JSON payload containing the ledger number.

**Critical detail:** The NOTIFY runs on a **separate connection** checked out from the shared request pool, entirely after the fold transaction has already committed. This means a NOTIFY failure cannot roll back or poison the fold—it's purely a delivery problem for connected stream clients (issue #169).

### 3. Listeners receive and fan out

Each running API process maintains exactly **one shared Postgres LISTEN connection** for the life of the process (issue #152). This connection subscribes to all notification channels (`members_changed`, `loan_proposals_changed`, `loans_changed`, `treasury_proposals_changed`, `interest_changed`, `documents_changed`).

When a NOTIFY arrives on any channel, the shared listener's `dispatchStreamNotification()` function fans it out in-process to every `StreamClient` instance subscribed to that channel. Ten concurrent SSE clients, a hundred, or a thousand all cost the same one Postgres connection.

### 4. Clients refetch via REST API

Each SSE client receives a lightweight change signal like:

```json
{
  "type": "notification",
  "channel": "loan_proposals_changed",
  "payload": { "ledger": 12345 },
  "timestamp": 1690000000000
}
```

The frontend uses this as a hint to refetch the affected resource via the normal REST endpoints (`GET /api/proposals/loan`, `GET /api/loans`, etc.). The notification carries only metadata—the full state comes from the existing read API, which is the same path served to clients that don't use SSE at all.

## Delivery Guarantees

**NOTIFY is fire-and-forget.** Postgres NOTIFY has no delivery acknowledgment, no persistence, and no replay. A notification is delivered only to clients connected and subscribed at the moment the NOTIFY fires.

**Consequences:**
- A client that is **not connected** when a change occurs receives nothing
- A client that **disconnects and reconnects** may miss notifications sent while it was away
- A client whose **socket is stalled** (suspended mobile browser, sleeping laptop, dead network link) receives nothing until it reconnects

**Why clients must still poll:** The SSE stream is a performance optimization—it lets a connected client learn about changes instantly instead of polling every few seconds—but it is **not a reliable event log**. Clients must poll as a fallback:
- On reconnect after any disconnect
- On a `resync` event (issue #155)
- Periodically as a backstop (the frontend polls `/api/stats` every 15 seconds regardless of SSE)

The `Last-Event-ID` mechanism (issue #155) tells a reconnecting client whether it may have missed changes, but does not retransmit them—the client must refetch to catch up.

## Connection Cost Per Client

### Before Issue #152 (per-client connection model)
Each SSE client held its own dedicated Postgres connection for the life of the stream. The default `node-postgres` pool size is 10, so **ten concurrent SSE clients consumed all available connections**, hanging every other request (including `/ready`) indefinitely.

### After Issue #152 (shared listener model)
Each API process maintains **exactly one shared LISTEN connection** regardless of the number of connected SSE clients. Ten clients, a hundred, or a thousand all cost the same one connection.

**Resource bounds:**
- **Database connections:** 1 per API process (the shared listener), not 1 per client
- **Memory:** ~100-200 bytes per client for the `StreamClient` bookkeeping object
- **File descriptors:** 1 socket per client (same as any HTTP connection)
- **Connection cap:** `STREAM_MAX_CONNECTIONS` (global, default 1000) and `STREAM_MAX_CONNECTIONS_PER_IP` (per-source, default 10) enforce ceiling independent of database connections (issue #156)

When over the cap, new connection attempts receive `503 Too many concurrent stream connections` with a `Retry-After` header.

## PgBouncer Incompatibility

**Postgres LISTEN/NOTIFY does not survive transaction-pooling connection poolers like PgBouncer.**

PgBouncer in **transaction pooling mode** (the mode `docs/DEPLOYMENT.md` recommends for scaling) assigns a different backend Postgres connection to every transaction. LISTEN is per-connection state, so a LISTEN issued on connection A does not receive NOTIFYs sent when the application's next transaction runs on connection B.

**Consequences:**
- If the application connects to PgBouncer in transaction pooling mode, the shared listener's LISTEN subscriptions are **silently lost** as soon as the connection is reassigned
- Notifications are never delivered to SSE clients
- No error is raised—the stream appears healthy, but clients receive only heartbeats, never change notifications

**Workarounds:**
1. **Session pooling mode** (not transaction pooling): PgBouncer holds one backend connection per client session for its lifetime, so LISTEN/NOTIFY works. This sacrifices PgBouncer's primary scaling benefit (connection reuse across transactions), but the shared listener model (issue #152) already removes the per-client connection cost, so PgBouncer's value here is limited to isolating the listener from the request pool's lifecycle.
2. **Direct connection for the shared listener**: Point `DATABASE_URL` at Postgres directly for the API process, bypassing PgBouncer entirely. The indexer can still go through PgBouncer (it doesn't use LISTEN/NOTIFY). This is the recommended deployment if using PgBouncer.
3. **Polling fallback only**: Deploy without SSE entirely—clients poll instead. The REST API still works through PgBouncer in transaction mode without restriction.

The deployment guide's PgBouncer recommendation predates the SSE stream (issue #63) and should be updated to call out this incompatibility explicitly.

## Why This Design

**Why Postgres as a message bus, not Redis/RabbitMQ/etc.?**  
The service already requires Postgres and has zero other runtime dependencies. Adding a second system for messages (Redis pub/sub, a message queue) means:
- Another failure mode (message bus down separately from database)
- More operational complexity (deploy, monitor, scale, secure a second stateful system)
- Postgres LISTEN/NOTIFY is sufficient for the fanout here—low-volume change signals to a modest number of concurrent clients, not high-throughput event processing

**Why SSE, not WebSockets?**  
SSE is strictly server-to-client (no bidirectional messaging needed), uses standard HTTP/2 (no protocol upgrade), and is simpler to deploy (works through most reverse proxies and CDNs without special config). The frontend doesn't send anything back over the stream—it only receives notifications and refetches via REST.

**Why lightweight notifications, not full payloads?**  
The REST API is already the authoritative read path, with caching, rate limits, and access control. Duplicating response serialization in NOTIFY payloads would:
- Exceed Postgres NOTIFY's 8000-byte payload limit for anything but trivial changes
- Duplicate the authorization logic (SSE is unauthenticated; REST enforces access per endpoint)
- Risk drift between the two serialization paths

Clients refetch instead, using the same code path regardless of whether they learned about the change from SSE or from polling.

## Unauthenticated Stream, Private Data

**The `/api/stream` endpoint is unauthenticated** (issue #160). It broadcasts DAO-wide state changes—loan proposals, loans, treasury proposals, interest distributions—which are public to every member anyway.

**Per-member private data** (like notifications) is **not broadcast** over SSE. The `notifications_changed` channel was deliberately excluded from `STREAM_CHANNELS` to prevent a future per-member NOTIFY from accidentally leaking to all connected clients. Members poll their own notification feed via the authenticated `GET /api/notifications` endpoint instead.

## Related Issues

- **#63**: Original SSE implementation
- **#152**: Shared listener (one connection per process, not per client)
- **#153**: NOTIFY payload size guard and parameterized `pg_notify()`
- **#154**: Malformed NOTIFY payload guard (prevents process crash)
- **#155**: `Last-Event-ID` and ledger tracking for reconnect hints
- **#156**: Connection cap enforcement (`STREAM_MAX_CONNECTIONS`, `STREAM_MAX_CONNECTIONS_PER_IP`)
- **#157**: Backpressure and queue overflow handling
- **#158**: Route registration and rate-limiting integration
- **#159**: Idempotent close with concurrent-call safety
- **#160**: Channel subscription and unauthenticated stream privacy model
- **#169**: NOTIFY failure counter and separate connection for post-commit delivery

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `STREAM_MAX_CONNECTIONS` | 1000 | Global cap on concurrent SSE clients per API process |
| `STREAM_MAX_CONNECTIONS_PER_IP` | 10 | Per-source IP cap |
| `STREAM_IDLE_TIMEOUT_MS` | 60000 | Socket idle timeout (closed by Node if no reads/writes) |
| `STREAM_RETRY_AFTER_SECONDS` | 30 | `Retry-After` header value when over cap |

## Operational Notes

- **Monitoring**: Track `connectedStreams` in `/api/stats` (issue #156) and `notificationFailures` (issue #169)
- **Load balancing**: Each API instance maintains its own shared listener and fans out to its own clients—no coordination needed across instances
- **Graceful shutdown**: The shared listener's standalone connection is closed explicitly in `src/index.ts` before `pool.end()`, ensuring a clean shutdown
- **Cold start**: The shared listener seeds `knownLedger.value` from `indexer_cursor.last_ledger` on first connect; before that, `resync` events are skipped (nothing meaningful to compare against)
- **Heartbeats**: Sent every 30 seconds to keep connections alive and detect stalled sockets

## See Also

- `src/api/stream.ts` — Implementation
- `src/indexer/handlers.ts` — Where `notifyStreamClientsAfterCommit()` is called
- `README.md` "API reference" — `/api/stream` endpoint documentation
- `docs/DEPLOYMENT.md` "PgBouncer and LISTEN/NOTIFY incompatibility" — why the shared listener needs a direct (non-transaction-pooled) Postgres connection
