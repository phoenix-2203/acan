import type { rpc } from "@stellar/stellar-sdk";

/**
 * Stellar RPC's getEvents scans at most 10,000 ledgers per call, starting at
 * `startLedger` (stellar-rpc: LedgerScanLimit = 10000). A single call with a
 * start more than ~14 hours back therefore misses everything recent. This
 * follows the returned cursor until it reaches the latest ledger.
 */
export async function getEventsSince(
  server: Pick<rpc.Server, "getEvents">,
  startLedger: number,
  filters: rpc.Api.EventFilter[],
  opts: { limit?: number; maxPages?: number } = {},
): Promise<rpc.Api.EventResponse[]> {
  const limit = opts.limit ?? 200;
  const maxPages = opts.maxPages ?? 20;
  const out: rpc.Api.EventResponse[] = [];
  let res = await server.getEvents({ startLedger, filters, limit });
  for (let page = 1; ; page++) {
    out.push(...res.events);
    const reached = cursorLedger(res.cursor);
    if (reached === null || reached >= res.latestLedger || page >= maxPages) break;
    res = await server.getEvents({ cursor: res.cursor, filters, limit });
  }
  return out;
}

/** Ledger of a getEvents cursor ("<TOID 19 digits>-<event index>"; TOID = ledger << 32 | ...). */
export function cursorLedger(cursor: string | undefined): number | null {
  const m = cursor?.match(/^(\d+)-\d+$/);
  return m ? Number(BigInt(m[1]) >> 32n) : null;
}
