import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { formatRecoveryCode, parseRecoveryCode, recoveryFileText, recoveryPublicKey, recoveryScopeParams } from "../src/recovery.js";

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
  // contracts/recovery-scope-policy/src/test.rs PARAMS_ADMIN_0_XDR_HEX
  assert.equal(recoveryScopeParams(0).toXDR("hex"), "0000001100000001000000010000000f0000000d61646d696e5f72756c655f69640000000000000300000000");
});

test("the download file holds the code and the warning", () => {
  const c = { account, ruleId: 3, secret: key.secret() };
  const t = recoveryFileText(c);
  assert.ok(t.includes(formatRecoveryCode(c)));
  assert.ok(t.includes("cannot pay from your account on its own"));
});
