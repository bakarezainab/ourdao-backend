# API Documentation

## Server-Sent Events (SSE) Stream

The `/api/stream` endpoint provides real-time notifications for DAO state changes via Server-Sent Events (SSE), an HTTP-based push protocol built into browsers through the `EventSource` API.

### Connection

```
GET /api/stream
```

**Query Parameters:**

- `channels` (optional): Comma-separated list of channel names to subscribe to. If omitted, subscribes to all channels.

**Response:**

- Status: `200 OK`
- `Content-Type: text/event-stream`
- `Cache-Control: no-store`
- Connection remains open indefinitely

### Event Channels

The stream broadcasts lightweight change signals—not full payloads. Clients refetch what they need via the corresponding REST endpoints.

| Channel              | Description               | Trigger Events                                                         |
| -------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `members`            | Member state changes      | Member joined, exited, claimed yield, stake changes, name registration |
| `loan_proposals`     | Loan proposal updates     | New proposals, votes, status changes (approved/rejected)               |
| `loans`              | Loan lifecycle events     | Disbursements, repayments, defaults                                    |
| `treasury_proposals` | Treasury proposal updates | New treasury proposals, votes, executions                              |
| `interest`           | Interest distributions    | Interest collected and distributed to members                          |
| `documents`          | Document attachment history | A document attached to a loan or treasury proposal (`doc_attn`)      |

**Example: Subscribe to specific channels**

```
GET /api/stream?channels=loans,loan_proposals
```

### Message Format

Every message follows the SSE protocol:

```
event: <event-type>
id: <ledger-sequence>
data: <json-payload>

```

Each message ends with a blank line. The `id:` field is the highest ledger sequence number this connection has seen a change for—it's monotonic and only advances when a real change occurs.

### Message Types

#### 1. Heartbeat

Sent every 30 seconds to keep the connection alive. No actual state change occurred.

```
event: heartbeat
id: 512045
data: {"type":"heartbeat","timestamp":1729015234567}

```

#### 2. Notification

A state change occurred in a subscribed channel.

```
event: message
id: 512046
data: {"type":"notification","channel":"loans","payload":{"ledger":512046},"timestamp":1729015240123}

```

**Fields:**

- `type`: Always `"notification"` for state changes
- `channel`: One of the channel names listed above
- `payload`: Object containing at minimum a `ledger` field (the ledger sequence where the change occurred)
- `timestamp`: Unix timestamp in milliseconds when the message was sent

**Sub-case: `disconnect` payload.** When the server's shared Postgres LISTEN connection drops (the shared listener's connection `error` handler in `src/api/stream.ts`), every connected client is sent a `notification` whose payload is a disconnect signal rather than a data change:

```
event: message
id: 512046
data: {"type":"notification","channel":"loans","payload":{"type":"disconnect","reason":"database_connection_lost","message":"Database connection lost, please reconnect"},"timestamp":1729015241000}

```

The payload has no `ledger` field and no `channel` of its own; the outer `channel` only reflects which subscribed channel it was delivered on (one copy per subscribed channel), so do not treat it as a change on that channel. Clients should log it and rely on `EventSource`'s native reconnect, then refetch as for a `resync` with `missed: true`.

#### 3. Resync

Sent to reconnecting clients who provide a `Last-Event-ID` header. Tells the client whether they missed changes while disconnected.

```
event: message
id: 512047
data: {"type":"resync","payload":{"missed":true,"lastKnownLedger":512045},"timestamp":1729015245678}

```

**Fields:**

- `missed`: `true` if at least one change happened while disconnected; `false` if caught up
- `lastKnownLedger`: The ledger the server knew about when the client reconnected

Fresh connections (no `Last-Event-ID`) receive no `resync` event.

#### 4. Error

Sent when an error occurs on the server side (rare—connection usually closes instead).

```
event: message
id: 512048
data: {"type":"error","payload":{"message":"internal error"},"timestamp":1729015250123}

```

### Reconnection and Missed Changes

Browsers implementing `EventSource` automatically reconnect after disconnections (network hiccup, server restart, etc.) and send the last `id:` they saw as a `Last-Event-ID` request header.

The server compares this against the current known ledger. If changes occurred while disconnected, it sends a `resync` event with `missed: true`. This is a "you may be behind, go refetch" signal—**not event replay**. The server does not buffer or replay individual changes.

**Clients should keep their polling fallback.** Because there's no replay, a disconnected client must refetch from REST endpoints to catch up. The stream tells you _that_ you're behind, not _what_ changed. For example, a frontend polling `/api/stats` every 15 seconds should continue that poll, using the stream purely to make the common case (already caught up) near-instant instead of waiting for the next tick.

### JavaScript Client Example

```javascript
// Basic connection to all channels
const eventSource = new EventSource("/api/stream");

eventSource.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  switch (message.type) {
    case "heartbeat":
      console.log("Connection alive");
      break;

    case "notification":
      if (message.payload.type === "disconnect") {
        // Server lost its database connection; not a data change.
        // EventSource reconnects on its own and a resync follows.
        console.warn("Stream disconnect:", message.payload.reason);
        break;
      }
      console.log(
        `Change on ${message.channel} at ledger ${message.payload.ledger}`,
      );
      // Refetch the relevant data from REST endpoints
      if (message.channel === "loans") {
        fetchLoans(); // Your refetch function
      }
      break;

    case "resync":
      if (message.payload.missed) {
        console.log("Missed changes while disconnected, refetching...");
        refetchAll(); // Your full refetch function
      }
      break;

    case "error":
      console.error("Stream error:", message.payload.message);
      break;
  }
});

eventSource.addEventListener("error", (event) => {
  if (eventSource.readyState === EventSource.CLOSED) {
    console.log("Connection closed");
  } else {
    console.log("Connection error, will reconnect...");
  }
});

// Subscribe to specific channels only
const loansEventSource = new EventSource(
  "/api/stream?channels=loans,loan_proposals",
);
```

### Connection Limits and Capacity

- **Per-process limit:** `STREAM_MAX_CONNECTIONS` (default 100)
- **Per-IP limit:** `STREAM_MAX_CONNECTIONS_PER_IP` (default 10)
- **Idle timeout:** `STREAM_IDLE_TIMEOUT_MS` (default 60 seconds); heartbeats keep healthy connections alive

When limits are exceeded, the server returns:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 30
```

Clients should honor the `Retry-After` header and not retry immediately.

### Backpressure and Client Health

The server monitors each client's ability to consume messages:

- **Queue bound:** Each client can buffer up to 200 pending messages. A client further behind is disconnected rather than buffered indefinitely.
- **Stall timeout:** If a write has been backpressured (waiting for the client to drain) for 30+ seconds with no progress, the client is disconnected even if under the queue limit.
- **Heartbeat retries:** When a heartbeat lands while the client is backpressured, it's retried with exponential backoff (1s → 2s → 4s → … → 16s max) instead of being skipped. This handles brief mobile network hiccups without prematurely dropping the connection.

These bounds ensure one slow client cannot degrade service for others.

### Security and Privacy

- **Unauthenticated by design:** Any client can connect without authentication.
- **DAO-wide state only:** Every channel broadcasts state already public via corresponding `GET` endpoints (members list, proposals, loans).
- **No per-member data:** Member-specific notifications (loan amounts, defaults, private votes) are never broadcast here. Clients must poll the authenticated `GET /api/notifications` endpoint instead.

This design ensures no sensitive data leaks over the unauthenticated stream.

### Rate Limiting

The initial SSE handshake counts as a request toward the global rate limit (`RATE_LIMIT_MAX`). Long-lived open connections do not count as ongoing requests—they're bounded separately by the connection limits above.

### Implementation Notes

- **Multiple API instances:** Each instance maintains its own shared listener connection to Postgres (`LISTEN/NOTIFY`). Notifications propagate correctly across instances with no coordination needed.
- **Connection cost:** One Postgres connection per API process (shared across all connected clients), not one per client. Issue #152 resolved the per-client connection cost.
- **PgBouncer incompatibility:** Postgres `LISTEN/NOTIFY` requires a dedicated session connection and does not work through PgBouncer's transaction pooling mode. See `docs/REALTIME-NOTIFICATIONS.md` for details.

### Troubleshooting

**Connection closes immediately:**

- Check that your client sets `Accept: text/event-stream`
- Ensure no aggressive proxy/firewall is closing long-lived connections
- Verify the server is reachable and `/health` returns `200`

**No messages received:**

- Confirm state changes are actually occurring (check `/api/stats`)
- Verify you're subscribed to the right channels
- Check browser console for errors

**Frequent disconnects:**

- Your client may not be consuming messages fast enough (see backpressure above)
- Network conditions may be poor (mobile, VPN, etc.)
- Ensure polling fallback is active—don't rely solely on the stream

**Missed changes not catching up:**

- Remember: `resync` with `missed: true` means refetch from REST endpoints
- The stream only tells you _that_ you're behind, not what changed
- Poll the relevant endpoints to recover (e.g., `/api/loans`, `/api/stats`)

### References

- [Server-Sent Events specification (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [EventSource API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
- Implementation: `src/api/stream.ts`
- Real-time notifications architecture: `docs/REALTIME-NOTIFICATIONS.md`
