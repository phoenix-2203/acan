/**
 * Cross-checks ACAN's headless agent signer against smart-account-kit's
 * reference implementation (the SDK SDF ships for OpenZeppelin smart accounts):
 * same auth digest, same AuthPayload bytes. Runs fully offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { computeEntryAuthDigest, Ed25519Signer } from "smart-account-kit";
// Internal helper (not in the package's public exports); imported by path for the cross-check only.
import { writeAuthPayload } from "../../../node_modules/smart-account-kit/dist/kit/auth-payload.js";
import { SmartAccountAgentSigner, buildAuthDigest } from "../src/agent-signer.js";
import { ASSETS, OZ_SMART_ACCOUNT, TESTNET } from "../src/config.js";

const SMART_ACCOUNT = StrKey.encodeContract(hash(Buffer.from("acan-test-account")));
const MERCHANT = Keypair.random().publicKey();
const AGENT = Keypair.random();
const RULE_ID = 3;
const EXPIRATION = 1_234_567;

function usdcTransferEntry(): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(ASSETS.usdc.sac).toScAddress(),
        functionName: "transfer",
        args: [
          nativeToScVal(SMART_ACCOUNT, { type: "address" }),
          nativeToScVal(MERCHANT, { type: "address" }),
          nativeToScVal(100_000n, { type: "i128" }),
        ],
      }),
    ),
    subInvocations: [],
  });
  const creds = new xdr.SorobanAddressCredentials({
    address: Address.fromString(SMART_ACCOUNT).toScAddress(),
    nonce: xdr.Int64.fromString("42"),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(creds),
    rootInvocation: invocation,
  });
}

test("agent signer matches smart-account-kit digest and AuthPayload encoding", async () => {
  const signer = new SmartAccountAgentSigner({
    smartAccount: SMART_ACCOUNT,
    agentSecret: AGENT.secret(),
    contextRuleId: RULE_ID,
    networkPassphrase: TESTNET.networkPassphrase,
  });

  const signed = await signer.signEntry(usdcTransferEntry(), EXPIRATION);
  const creds = signed.credentials().addressV2();
  assert.equal(creds.signatureExpirationLedger(), EXPIRATION);

  // Reference: smart-account-kit computes the digest over a fresh copy of the entry.
  const ref = usdcTransferEntry();
  const { authDigest } = computeEntryAuthDigest(TESTNET.networkPassphrase, ref, EXPIRATION, [RULE_ID]);
  const refSigner = new Ed25519Signer(AGENT, OZ_SMART_ACCOUNT.ed25519Verifier);
  const refSig = refSigner.signAuthDigest(authDigest);
  const refPayload = writeAuthPayload({
    context_rule_ids: [RULE_ID],
    signers: new Map([[refSigner.signer, refSig]]),
  });

  assert.equal(creds.signature().toXDR("base64"), refPayload.toXDR("base64"));
  assert.ok(AGENT.verify(authDigest, refSig));
});

test("auth digest binds the rule id", () => {
  const payload = Buffer.alloc(32, 7);
  assert.notDeepEqual(buildAuthDigest(payload, [1]), buildAuthDigest(payload, [2]));
});

test("refuses to sign an entry for a different address", async () => {
  const other = StrKey.encodeContract(hash(Buffer.from("someone-else")));
  const signer = new SmartAccountAgentSigner({
    smartAccount: other,
    agentSecret: AGENT.secret(),
    contextRuleId: RULE_ID,
    networkPassphrase: TESTNET.networkPassphrase,
  });
  await assert.rejects(signer.signEntry(usdcTransferEntry(), EXPIRATION), /not the smart account/);
});
