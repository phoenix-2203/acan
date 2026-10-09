/**
 * The co-signer service with the gated agent signer, over HTTP, as the MCP
 * agent uses them: a purchase that matches the guardian-signed task is signed
 * by both keys; one the AI chose differently is refused before anything is signed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Buffer } from "buffer";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { GatedAgentSigner, ProvenanceEscalation, buildAuthDigest, remoteCosigner, signaturePayloadOf, taskPlan } from "@acan/core";
import { createCosignerService } from "../src/service.js";
import { ACCOUNT, CATALOG, KEYS, NOW, PASSPHRASE, RULE_ID, SOUTHGATE, NORTHWIND, TOKEN, VERIFIER, entryFor, request } from "../../../research/prototype/src/scenario.js";

async function setup() {
  const srv = createCosignerService({
    secret: KEYS.cosigner.secret(),
    account: ACCOUNT,
    token: TOKEN,
    ruleId: RULE_ID,
    networkPassphrase: PASSPHRASE,
    verifier: VERIFIER,
    deviceKeys: [KEYS.device.publicKey()],
    catalog: CATALOG,
    now: () => NOW,
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const task = request({ product: "ledger-report", maxAmount: "100000" });
  const signer = new GatedAgentSigner(
    { smartAccount: ACCOUNT, agentSecret: KEYS.agent.secret(), contextRuleId: RULE_ID, networkPassphrase: PASSPHRASE },
    remoteCosigner(url, () => ({ request: task, plan: taskPlan(false), transcript: {}, payIndex: 0 })),
  );
  return { srv, signer };
}

function signersOf(entry: xdr.SorobanAuthorizationEntry): Buffer[] {
  const sig = entry.credentials().address().signature();
  const signers = sig.map()!.find((e) => e.key().sym().toString() === "signers")!.val().map()!;
  return signers.map((e) => Buffer.from(e.key().vec()![2].bytes()));
}

test("a purchase matching the signed task is signed by the agent and the co-signer, over the same digest", async () => {
  const { srv, signer } = await setup();
  try {
    const signed = await signer.signEntry(entryFor(SOUTHGATE, 80_000n), 1_000_050);
    const keys = signersOf(signed);
    assert.equal(keys.length, 2);
    const digest = buildAuthDigest(signaturePayloadOf(signed, PASSPHRASE), [RULE_ID]);
    const sigs = signed.credentials().address().signature().map()!.find((e) => e.key().sym().toString() === "signers")!.val().map()!;
    for (const e of sigs) {
      const pk = Buffer.from(e.key().vec()![2].bytes());
      assert.ok(Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(pk)).verify(digest, Buffer.from(e.val().bytes())));
    }
    assert.equal(signed.credentials().address().signatureExpirationLedger(), 1_000_050);
  } finally {
    srv.close();
  }
});

test("the AI buying something else than the signed task (another merchant, a pricier item) is refused, nothing signed", async () => {
  const { srv, signer } = await setup();
  try {
    await assert.rejects(signer.signEntry(entryFor(NORTHWIND, 100_000n), 1_000_050), (e: unknown) => e instanceof ProvenanceEscalation);
    await assert.rejects(signer.signEntry(entryFor(NORTHWIND, 250_000n), 1_000_050), (e: unknown) => e instanceof ProvenanceEscalation);
  } finally {
    srv.close();
  }
});
