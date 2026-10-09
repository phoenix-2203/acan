/**
 * Encoding checks: the two-signer AuthPayload must be byte-identical to the
 * reference SDK's, and the Rust fixture must be exactly what this code produces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Buffer } from "buffer";
import { Keypair } from "@stellar/stellar-sdk";
// Internal helper of smart-account-kit, imported by path for the cross-check only (as packages/core/test does).
import { writeAuthPayload } from "../../../node_modules/smart-account-kit/dist/kit/auth-payload.js";
import { authPayloadMulti, withSignature } from "../src/auth.js";
import { fixtureRust } from "../src/fixture.js";
import { KEYS, SOUTHGATE, VERIFIER, entryFor } from "../src/scenario.js";

const sig = (n: number) => Buffer.alloc(64, n);

test("two-signer AuthPayload matches smart-account-kit's writeAuthPayload byte for byte, whatever the input order", () => {
  for (let i = 0; i < 20; i++) {
    const a = Keypair.random();
    const b = Keypair.random();
    const ours = authPayloadMulti([7], [
      { verifier: VERIFIER, publicKey: Buffer.from(a.rawPublicKey()), signature: sig(1) },
      { verifier: VERIFIER, publicKey: Buffer.from(b.rawPublicKey()), signature: sig(2) },
    ]);
    const signers = new Map<any, Buffer>([
      [{ tag: "External", values: [VERIFIER, Buffer.from(b.rawPublicKey())] }, sig(2)],
      [{ tag: "External", values: [VERIFIER, Buffer.from(a.rawPublicKey())] }, sig(1)],
    ]);
    const theirs = writeAuthPayload({ context_rule_ids: [7], signers });
    assert.equal(ours.toXDR("base64"), theirs.toXDR("base64"));
  }
});

test("duplicate signers and wrong sizes are refused", () => {
  const pk = Buffer.from(KEYS.agent.rawPublicKey());
  assert.throws(() => authPayloadMulti([0], [
    { verifier: VERIFIER, publicKey: pk, signature: sig(1) },
    { verifier: VERIFIER, publicKey: pk, signature: sig(2) },
  ]), /duplicate signer/);
  assert.throws(() => authPayloadMulti([0], [{ verifier: VERIFIER, publicKey: pk.subarray(1), signature: sig(1) }]), /32 bytes/);
});

test("the signature is attached without changing what the entry authorizes", () => {
  const entry = entryFor(SOUTHGATE, 80_000n);
  const signed = withSignature(entry, authPayloadMulti([0], [{ verifier: VERIFIER, publicKey: Buffer.from(KEYS.agent.rawPublicKey()), signature: sig(3) }]));
  assert.equal(signed.rootInvocation().toXDR("base64"), entry.rootInvocation().toXDR("base64"));
  assert.notEqual(signed.toXDR("base64"), entry.toXDR("base64"));
});

test("the committed Rust fixture is exactly what the TypeScript co-signer and agent produce", () => {
  const path = fileURLToPath(new URL("../soroban/src/fixture.rs", import.meta.url));
  assert.equal(readFileSync(path, "utf8"), fixtureRust());
});
