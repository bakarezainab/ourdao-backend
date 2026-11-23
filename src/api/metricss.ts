import { Gauge, register } from 'prom-client';
import { getIndexerStats } from '../indexer/stats'; // adjust path

// Scrape-time cache so the 3 gauges share one query per scrape.
let inflight: ReturnType<typeof getIndexerStats> | null = null;
function statsForThisScrape() {
  if (!inflight) {
    inflight = getIndexerStats().finally(() => {
      // release after the current event-loop turn so all 3 collects share it
      setImmediate(() => { inflight = null; });
    });
  }
  return inflight;
}

new Gauge({
  name: 'indexer_ledgers_behind',
  help: 'Number of ledgers the indexer is behind the network tip',
  registers: [register],
  async collect() {
    try {
      this.set((await statsForThisScrape()).ledgersBehind);
    } catch (err) {
      console.error('metrics: failed to read ledgersBehind', err); // use your logger
    }
  },
});

new Gauge({
  name: 'indexer_estimated_lag_seconds',
  help: 'Estimated indexer lag behind the network tip, in seconds',
  registers: [register],
  async collect() {
    try {
      this.set((await statsForThisScrape()).estimatedLagSeconds);
    } catch (err) {
      console.error('metrics: failed to read estimatedLagSeconds', err);
    }
  },
});

new Gauge({
  name: 'indexer_quarantined_events',
  help: 'Number of events currently in quarantine',
  registers: [register],
  async collect() {
    try {
      this.set((await statsForThisScrape()).quarantinedEvents);
    } catch (err) {
      console.error('metrics: failed to read quarantinedEvents', err);
    }
  },
});
