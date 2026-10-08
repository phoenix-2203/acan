import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorLedger, getEventsSince } from "../src/events.js";

const SCAN = 10_000;
const cursorAt = (ledger: number) => `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`;

/** Mimics stellar-rpc: each call scans SCAN ledgers from its start and returns a cursor at the window end. */
function fakeServer(latest: number, eventLedgers: number[]) {
  const calls: any[] = [];
  return {
    calls,
    async getEvents(req: any) {
      calls.push(req);
      const start = req.cursor ? cursorLedger(req.cursor)! + 1 : req.startLedger;
      const end = Math.min(start + SCAN, latest + 1);
      const events = eventLedgers.filter((l) => l >= start && l < end).map((l) => ({ id: `e${l}`, ledger: l }));
      return { events, cursor: cursorAt(end - 1), latestLedger: latest } as any;
    },
  };
}

test("cursorLedger decodes the ledger from a TOID cursor", () => {
  assert.equal(cursorLedger(cursorAt(5_085_632)), 5_085_632);
  assert.equal(cursorLedger(undefined), null);
  assert.equal(cursorLedger("garbage"), null);
});

test("getEventsSince follows the cursor past the 10,000-ledger scan limit", async () => {
  const latest = 5_100_000;
  const s = fakeServer(latest, [latest - 100_000, latest - 20_000, latest - 5, latest]);
  const events = await getEventsSince(s, latest - 120_000, []);
  assert.deepEqual(events.map((e) => e.ledger), [latest - 100_000, latest - 20_000, latest - 5, latest]);
  assert.equal(s.calls.length, 13);
  // A single call (what the dashboard used to do) would have seen none of the recent ones.
  const one = await fakeServer(latest, [latest - 5]).getEvents({ startLedger: latest - 17_000 });
  assert.equal(one.events.length, 0);
});

test("getEventsSince stops at maxPages", async () => {
  const s = fakeServer(5_100_000, []);
  await getEventsSince(s, 5_000_000, [], { maxPages: 3 });
  assert.equal(s.calls.length, 3);
});
