import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, Keypair, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ASSETS } from "@acan/core/browser";
import { checkRequest, decodeEntry } from "../src/approval-check.js";

const ACCOUNT = StrKey.encodeContract(hash(Buffer.from("guardian-account")));
const MERCHANT = Keypair.random().publicKey();

function entry(opts: { contract?: string; fn?: string; from?: string; to?: string; amount?: bigint; sub?: boolean } = {}) {
  const invocation = (contract: string, fn: string, args: xdr.ScVal[], sub: xdr.SorobanAuthorizedInvocation[] = []) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contract).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations: sub,
    });
  const args = [
    nativeToScVal(opts.from ?? ACCOUNT, { type: "address" }),
    nativeToScVal(opts.to ?? MERCHANT, { type: "address" }),
    nativeToScVal(opts.amount ?? 50_000n, { type: "i128" }),
  ];
  const extra = opts.sub ? [invocation(ASSETS.usdc.sac, "approve", args)] : [];
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(opts.contract ?? ASSETS.usdc.sac, opts.fn ?? "transfer", args, extra),
  }).toXDR("base64");
}

const expected = { account: ACCOUNT, payTo: MERCHANT, amount: "50000" };

test("decodes the payment an auth entry really authorizes", () => {
  const d = decodeEntry(entry());
  assert.equal(d.contract, ASSETS.usdc.sac);
  assert.equal(d.fn, "transfer");
  assert.equal(d.from, ACCOUNT);
  assert.equal(d.to, MERCHANT);
  assert.equal(d.amount, 50_000n);
});

test("accepts exactly the claimed payment", () => {
  assert.equal(checkRequest(entry(), expected), null);
});

test("refuses anything that differs from the request", () => {
  assert.match(checkRequest(entry({ amount: 5_000_000n }), expected)!, /amount differs/);
  assert.match(checkRequest(entry({ to: Keypair.random().publicKey() }), expected)!, /recipient differs/);
  assert.match(checkRequest(entry({ fn: "approve" }), expected)!, /not a transfer/);
  assert.match(checkRequest(entry({ contract: ASSETS.xlm.sac }), expected)!, /not a USDC payment/);
  assert.match(checkRequest(entry({ from: StrKey.encodeContract(hash(Buffer.from("x"))) }), expected)!, /not from this smart account/);
  assert.match(checkRequest(entry({ sub: true }), expected)!, /extra calls/);
  assert.match(checkRequest("not-xdr", expected)!, /cannot decode/);
});
