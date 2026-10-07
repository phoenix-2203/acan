import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import { SmartAccountAwareFacilitator } from "../src/facilitator.js";
import { ASSETS, OZ_SMART_ACCOUNT } from "../src/config.js";

const PAYER = StrKey.encodeContract(hash(Buffer.from("payer")));
const PAYEE = Keypair.random().publicKey();
const OTHER = StrKey.encodeContract(hash(Buffer.from("other")));

function ev(contract: string, topics: xdr.ScVal[], data: xdr.ScVal): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: Address.fromString(contract).toScAddress().contractId() as any,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
}
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const addr = (a: string) => nativeToScVal(a, { type: "address" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

const transfer = (contract = ASSETS.usdc.sac, amount = 100_000n) =>
  ev(contract, [sym("transfer"), addr(PAYER), addr(PAYEE), xdr.ScVal.scvString("USDC")], i128(amount));
const policyEvent = ev(OZ_SMART_ACCOUNT.spendingLimitPolicy, [sym("spent"), addr(PAYER)], i128(100_000n));

const fac = new SmartAccountAwareFacilitator([createEd25519Signer(Keypair.random().secret(), "stellar:testnet")]);
const validate = (events: xdr.DiagnosticEvent[], amount = 100_000n) =>
  (fac as any).validateSimulationEvents(events, PAYER, PAYEE, amount, ASSETS.usdc.sac);

test("accepts transfer plus spending-limit policy event", () => {
  assert.equal(validate([policyEvent, transfer()]), undefined);
});

test("still rejects events from unknown contracts", () => {
  const r = validate([ev(OTHER, [sym("x"), addr(PAYER), addr(PAYEE)], i128(1n)), transfer()]);
  assert.equal(r?.invalidReason, "invalid_exact_stellar_payload_event_not_transfer");
});

test("a fake transfer event emitted by the payer does not count as payment", () => {
  const r = validate([transfer(PAYER)]);
  assert.equal(r?.invalidReason, "invalid_exact_stellar_payload_no_transfer_events");
});

test("still enforces exact amount and single transfer", () => {
  assert.equal(validate([transfer(ASSETS.usdc.sac, 99n)])?.invalidReason, "invalid_exact_stellar_payload_event_wrong_amount");
  assert.equal(validate([transfer(), transfer()])?.invalidReason, "invalid_exact_stellar_payload_multiple_transfers");
});
