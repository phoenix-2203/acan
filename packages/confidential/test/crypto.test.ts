import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfidentialAccount, CONFIDENTIAL_TESTNET, auditTransfer, randomScalar, toHex32 } from "../src/index.js";
import { addressToField, auditorPublicKey, buildTransferWitness, deriveKeys } from "../src/vendor.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Offline check of the decryption path the merchant inbox and audit script use:
// a transfer witness built by the agent decrypts to the same amount for the
// merchant (viewing key) and for the guardian (auditor key).
test("merchant and auditor both recover a confidential transfer amount", () => {
  const addrF = addressToField(CONFIDENTIAL_TESTNET.contracts.token);
  const agentKeys = deriveKeys(randomScalar(), addrF);
  const merchant = new ConfidentialAccount({
    secret: Keypair.random().secret(),
    ctSecretHex: toHex32(randomScalar()),
    statePath: join(tmpdir(), `acan-ct-test-${process.pid}.json`),
  });
  const auditorSecret = randomScalar();
  const kAud = auditorPublicKey(auditorSecret);
  const amount = 300_000n;
  const w = buildTransferWitness({
    keys: agentKeys, v: 1_000_000n, r: randomScalar(), amount,
    pvkB: merchant.keys.PVK, kAudR: kAud, kAudS: kAud,
  });
  const { vTx } = merchant.engine.decryptIncoming(w.payload.rE, w.payload.vTilde, w.payload.sigma);
  assert.equal(vTx, amount);

  const audited = auditTransfer(auditorSecret, {
    type: "transfer", ledger: 1, txHash: "00", cursor: "x", from: "A", to: "B",
    rE: w.payload.rE, vTilde: w.payload.vTilde, sigma: w.payload.sigma, bTilde: w.payload.bTilde,
    vAudR: w.payload.vAudR, rAudR: w.payload.rAudR, vAudS: w.payload.vAudS, bAudS: w.payload.bAudS,
  });
  assert.equal(audited.amount, amount);
  assert.equal(audited.senderBalance, 700_000n);
  assert.ok(audited.channelsAgree);

  // A different viewing key does not recover the amount.
  const stranger = deriveKeys(randomScalar(), addrF);
  const other = new ConfidentialAccount({
    secret: Keypair.random().secret(),
    ctSecretHex: toHex32(stranger.sk),
    statePath: join(tmpdir(), `acan-ct-test2-${process.pid}.json`),
  });
  assert.notEqual(other.engine.decryptIncoming(w.payload.rE, w.payload.vTilde, w.payload.sigma).vTx, amount);
});
