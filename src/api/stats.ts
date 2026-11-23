// src/indexer/stats.ts  (path is a guess)
export interface IndexerStats {
  ledgersBehind: number;
  estimatedLagSeconds: number;
  quarantinedEvents: number;
  // ...any other fields /api/stats already returns
}

export async function getIndexerStats(): Promise<IndexerStats> {
  // <- move the existing computation here, verbatim
  // return { ledgersBehind, estimatedLagSeconds, quarantinedEvents, ... };
}
