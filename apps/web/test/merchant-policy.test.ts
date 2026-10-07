import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMerchantPolicyParams } from "../src/merchant-policy.js";

// Produced by the Rust test `params_xdr_fixture` in contracts/merchant-allowlist-policy:
// the contract's own encoding of the same value. Any drift fails here.
const RUST_FIXTURE =
  "0000001100000001000000030000000f0000000c6d61785f7061796d656e7473000000030000000a0000000f0000000e706572696f645f6c656467657273000000000003000043800000000f0000000a726563697069656e747300000000001000000001000000020000001100000001000000020000000f0000000761646472657373000000001200000000000000004584249c4e48681599d0abf37556018c648c462500dc39e50fe0443b5be77ee20000000f00000003636170000000000a0000000000000000000000000007a1200000001100000001000000020000000f0000000761646472657373000000001200000001abcac2664b7c6a55ace2dbb4d9d60b9d7d93e83293e851eacd54c1b6bfb1137a0000000f00000003636170000000000a00000000000000000000000000000000";

test("dashboard encodes merchant policy params byte-for-byte like the contract", () => {
  const v = encodeMerchantPolicyParams({
    recipients: [
      { address: "GBCYIJE4JZEGQFMZ2CV7G5KWAGGGJDCGEUANYOPFB7QEIO23457OESPT", cap: 500_000n },
      { address: "CCV4VQTGJN6GUVNM4LN3JWOWBOOX3E7IGKJ6QUPKZVKMDNV7WEJXVYAQ", cap: 0n },
    ],
    periodLedgers: 17_280,
    maxPayments: 10,
  });
  // Rust's to_xdr prefixes the ScVal discriminant; compare the full ScVal encoding.
  assert.equal(v.toXDR("hex"), RUST_FIXTURE);
});

test("rejects bad settings before asking for a passkey", () => {
  const ok = { address: "GBCYIJE4JZEGQFMZ2CV7G5KWAGGGJDCGEUANYOPFB7QEIO23457OESPT", cap: 1n };
  assert.throws(() => encodeMerchantPolicyParams({ recipients: [], periodLedgers: 1, maxPayments: 0 }), /at least one/);
  assert.throws(() => encodeMerchantPolicyParams({ recipients: [ok, ok], periodLedgers: 1, maxPayments: 0 }), /Duplicate/);
  assert.throws(() => encodeMerchantPolicyParams({ recipients: [{ ...ok, cap: -1n }], periodLedgers: 1, maxPayments: 0 }), /negative/);
  assert.throws(() => encodeMerchantPolicyParams({ recipients: [ok], periodLedgers: 0, maxPayments: 0 }), /Period/);
  assert.throws(() => encodeMerchantPolicyParams({ recipients: [{ address: "nope", cap: 0n }], periodLedgers: 1, maxPayments: 0 }), /Invalid/);
});
