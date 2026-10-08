import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  ASSETS,
  ReceiptRecorder,
  checkPaymentOnChain,
  checkReceiptOffline,
  parseSignedReceipt,
  signReceipt,
  usdcTransfers,
} from "../src/index.js";

const agent = Keypair.random();
const ACCOUNT = "CCV4VQTGJN6GUVNM4LN3JWOWBOOX3E7IGKJ6QUPKZVKMDNV7WEJXVYAQ";
const MERCHANT = "GBCYIJE4JZEGQFMZ2CV7G5KWAGGGJDCGEUANYOPFB7QEIO23457OESPT";
const TX = "4394246d34c0d491671d9c76ba78f8785c0c377054d62f6038ce0456a13aaf6a";

function signed() {
  const rec = new ReceiptRecorder({ network: "stellar:testnet", agent: agent.publicKey(), smartAccount: ACCOUNT, ruleId: 12, mode: "public", task: "latest ledger" });
  rec.paid({ merchant: "Northwind Data", address: MERCHANT, item: "/api/ledger", amountUsdc: "0.01", scheme: "exact", tx: TX });
  return signReceipt(rec.build(), (d) => agent.sign(d), agent.publicKey());
}

/** Transaction meta (v3) holding one SAC "transfer" event. */
function metaWithTransfer(from: string, to: string, stroops: bigint, sac: string = ASSETS.usdc.sac): xdr.TransactionMeta {
  const event = new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Address.fromString(sac).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [nativeToScVal("transfer", { type: "symbol" }), Address.fromString(from).toScVal(), Address.fromString(to).toScVal()],
        data: nativeToScVal(stroops, { type: "i128" }),
      }),
    ),
  });
  return xdr.TransactionMeta.fromXDR(
    new xdr.TransactionMeta(
      3,
      new xdr.TransactionMetaV3({
        ext: new xdr.ExtensionPoint(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMeta({
          ext: new xdr.SorobanTransactionMetaExt(0),
          events: [event],
          returnValue: xdr.ScVal.scvVoid(),
          diagnosticEvents: [],
        }),
      }),
    ).toXDR(),
  );
}

const server = (resp: any) => ({ getTransaction: async () => resp }) as unknown as rpc.Server;

test("offline checks pass for an untouched receipt and fail when an amount is edited", () => {
  const s = signed();
  assert.deepEqual(checkReceiptOffline(s).map((c) => c.status), ["ok", "ok"]);
  const edited = structuredClone(s);
  edited.receipt.payments[0].amountUsdc = "0.10";
  const [sig, sum] = checkReceiptOffline(edited);
  assert.equal(sig.status, "fail");
  assert.equal(sum.status, "fail");
  assert.match(sum.text, /add up to 0.1 USDC/);
});

test("a payment line is confirmed only by a matching USDC transfer from the smart account", async () => {
  const p = signed().receipt.payments[0];
  const meta = metaWithTransfer(ACCOUNT, MERCHANT, 100_000n);
  assert.deepEqual(usdcTransfers(meta), [{ from: ACCOUNT, to: MERCHANT, amount: 100_000n }]);
  const ok = await checkPaymentOnChain(server({ status: "SUCCESS", resultMetaXdr: meta }), ACCOUNT, p, 0);
  assert.equal(ok.status, "ok");
  assert.match(ok.text, /moved 0.01 USDC from the smart account to Northwind Data/);

  const wrongAmount = await checkPaymentOnChain(server({ status: "SUCCESS", resultMetaXdr: metaWithTransfer(ACCOUNT, MERCHANT, 200_000n) }), ACCOUNT, p, 0);
  assert.equal(wrongAmount.status, "fail");
  assert.match(wrongAmount.text, /moved 0.02 USDC, but the receipt says 0.01/);

  const otherToken = await checkPaymentOnChain(server({ status: "SUCCESS", resultMetaXdr: metaWithTransfer(ACCOUNT, MERCHANT, 100_000n, ASSETS.xlm.sac) }), ACCOUNT, p, 0);
  assert.equal(otherToken.status, "fail", "an XLM transfer does not prove a USDC payment");

  const missing = await checkPaymentOnChain(server({ status: "NOT_FOUND" }), ACCOUNT, p, 0);
  assert.match(missing.text, /not found/);

  const voucher = await checkPaymentOnChain(server({}), ACCOUNT, { ...p, tx: undefined, voucher: "v1", scheme: "acan-tab" }, 0);
  assert.equal(voucher.status, "skip");
});

test("parsing gives readable errors for files that are not receipts", () => {
  assert.throws(() => parseSignedReceipt("not json"), /not JSON/);
  assert.throws(() => parseSignedReceipt('{"hello":1}'), /not a signed ACAN task receipt/);
  assert.equal(parseSignedReceipt(JSON.stringify(signed())).receipt.ruleId, 12);
});
