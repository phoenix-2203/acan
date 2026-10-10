import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { formatRecoveryCode, newPasskeyRuleArgs, parseRecoveryCode, recoveryFileText, recoveryPublicKey, recoveryScopeParams } from "../src/recovery.js";

const account = StrKey.encodeContract(Buffer.alloc(32, 7));
const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

test("a recovery code round-trips, tolerating spaces and line breaks", () => {
  const c = { account, ruleId: 3, secret: key.secret() };
  const text = formatRecoveryCode(c);
  assert.equal(text, `acan-recovery-1:3:${account}:${key.secret()}`);
  assert.deepEqual(parseRecoveryCode(`  ${text.slice(0, 40)}\n ${text.slice(40)}  `), c);
  assert.deepEqual(recoveryPublicKey(c), Buffer.from(key.rawPublicKey()));
});

test("damaged codes are refused with a reason", () => {
  const good = formatRecoveryCode({ account, ruleId: 3, secret: key.secret() });
  assert.throws(() => parseRecoveryCode("hello"), /not an ACAN recovery code/);
  assert.throws(() => parseRecoveryCode(good.replace(":3:", ":x:")), /rule number/);
  assert.throws(() => parseRecoveryCode(good.slice(0, -1) + (good.endsWith("A") ? "B" : "A")), /key is damaged/);
  assert.throws(() => parseRecoveryCode(good.replace(account, account.slice(0, -1) + (account.endsWith("A") ? "B" : "A"))), /account address/);
});

test("install params encode exactly as the Soroban contract type (pinned in contracts/recovery-scope-policy)", () => {
  // contracts/recovery-scope-policy/src/test.rs PARAMS_XDR_HEX, with the testnet WebAuthn verifier
  assert.equal(
    recoveryScopeParams("CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F").toXDR("hex"),
    "0000001100000001000000010000000f00000010706173736b65795f76657269666965720000001200000001be4520f07ee6de081180da3f088ec6a975dac2d5fa63cc7d6ac13f84dd33f287",
  );
});

test("the new rule's arguments are Default, a name, no expiry, one signer, no policies", () => {
  const signer = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), xdr.ScVal.scvBytes(Buffer.alloc(3))]);
  const [type, name, until, signers, policies] = newPasskeyRuleArgs(signer);
  assert.equal(type.vec()![0].sym().toString(), "Default");
  assert.equal(name.str().toString(), "recovered passkey");
  assert.equal(until.switch().name, "scvVoid");
  assert.equal(signers.vec()!.length, 1);
  assert.equal(policies.map()!.length, 0);
});

test("the download file holds the code and the warning", () => {
  const c = { account, ruleId: 3, secret: key.secret() };
  const t = recoveryFileText(c);
  assert.ok(t.includes(formatRecoveryCode(c)));
  assert.ok(t.includes("cannot pay from your account on its own"));
});
