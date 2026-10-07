import { test } from "node:test";
import assert from "node:assert/strict";
import { auditCsv, auditJson } from "../src/audit-export.js";
import type { AuditReport } from "../src/guardian.js";

const report: AuditReport = {
  account: "GVAULT",
  token: "CTOKEN",
  latestLedger: 100,
  auditorKey: true,
  names: { GVAULT: "Agent vault", GMERCH: "Northwind Data, merchant A" },
  totalsTo: { GMERCH: "300000" },
  rows: [
    { ledger: 10, txHash: "aa", type: "deposit", from: "GVAULT", to: "GVAULT", publicAmount: "1000000" },
    {
      ledger: 11,
      txHash: "bb",
      type: "transfer",
      from: "GVAULT",
      to: "GMERCH",
      publicAmount: null,
      decryptedAmount: "300000",
      balanceAfter: "700000",
      decrypted: true,
    },
  ],
};

test("CSV shows the public view next to the decrypted amount, with links", () => {
  const lines = auditCsv(report).trim().split("\n");
  assert.equal(lines[0], "ledger,event,from,to,public_amount_usdc,decrypted_amount_usdc,vault_balance_after_usdc,transaction");
  assert.equal(lines[1], "10,deposit,Agent vault,Agent vault,0.1,,,https://stellar.expert/explorer/testnet/tx/aa");
  // Names with commas are quoted; the hidden amount stays "hidden" in the public column.
  assert.equal(
    lines[2],
    '11,transfer,Agent vault,"Northwind Data, merchant A",hidden,0.03,0.07,https://stellar.expert/explorer/testnet/tx/bb',
  );
});

test("JSON carries totals per recipient in USDC", () => {
  const j = JSON.parse(auditJson(report, "2026-10-07T00:00:00Z"));
  assert.deepEqual(j.totalsUsdc, { "Northwind Data, merchant A": "0.03" });
  assert.equal(j.events[1].to, "Northwind Data, merchant A");
  assert.equal(j.events.length, 2);
});
