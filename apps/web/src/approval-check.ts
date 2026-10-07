import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { ASSETS } from "@acan/core/browser";

/**
 * Safety checks the dashboard runs before it lets the guardian sign an
 * approval request. They read what the authorization entry really does from
 * its XDR, rather than trusting the agent's description of it.
 */
/**
 * What the auth entry really authorizes, decoded from the XDR itself rather
 * than trusting the agent's description of it.
 */
export function decodeEntry(entryXdr: string): { contract: string; fn: string; from: string; to: string; amount: bigint } {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
  const fnx = entry.rootInvocation().function();
  if (fnx.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") throw new Error("not a contract call");
  const call = fnx.contractFn();
  const args = call.args();
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    fn: call.functionName().toString(),
    from: args[0] ? (scValToNative(args[0]) as string) : "",
    to: args[1] ? (scValToNative(args[1]) as string) : "",
    amount: args[2] ? BigInt(scValToNative(args[2]) as bigint) : 0n,
  };
}

/** What the request claims; the entry must match it exactly. */
export interface Expected {
  account: string;
  payTo: string;
  /** atomic units */
  amount: string;
  /** Defaults to testnet USDC. */
  token?: string;
}

/** Returns a problem that should block signing, or null when the entry is exactly the claimed payment. */
export function checkRequest(entryXdr: string, a: Expected): string | null {
  try {
    const d = decodeEntry(entryXdr);
    if (entryHasSubInvocations(entryXdr)) return "the authorization includes extra calls";
    if (d.contract !== (a.token ?? ASSETS.usdc.sac)) return `not a USDC payment (contract ${d.contract})`;
    if (d.fn !== "transfer") return `not a transfer (${d.fn})`;
    if (d.from !== a.account) return "not from this smart account";
    if (d.to !== a.payTo) return "recipient differs from the request";
    if (d.amount.toString() !== a.amount) return "amount differs from the request";
    return null;
  } catch (e) {
    return `cannot decode the authorization: ${e instanceof Error ? e.message : e}`;
  }
}

function entryHasSubInvocations(entryXdr: string): boolean {
  return xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64").rootInvocation().subInvocations().length > 0;
}

