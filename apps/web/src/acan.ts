import { StrKey, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  IndexedDBStorage,
  SmartAccountKit,
  createCallContractContext,
  createEd25519Signer,
  createSpendingLimitParams,
  type ContextRule,
} from "smart-account-kit";
import { ASSETS, OZ_SMART_ACCOUNT, TESTNET, stroopsToUsdc } from "@acan/core/browser";

export const kit = new SmartAccountKit({
  rpcUrl: TESTNET.rpcUrl,
  networkPassphrase: TESTNET.networkPassphrase,
  accountWasmHash: OZ_SMART_ACCOUNT.accountWasmHash,
  webauthnVerifierAddress: OZ_SMART_ACCOUNT.webauthnVerifier,
  ed25519VerifierAddress: OZ_SMART_ACCOUNT.ed25519Verifier,
  relayerUrl: TESTNET.relayerUrl,
  storage: new IndexedDBStorage(),
  rpName: "ACAN",
});

const server = new rpc.Server(TESTNET.rpcUrl);

export interface AgentGrant {
  ruleId: number;
  agentKey: string;
  limitStroops: bigint;
  periodLedgers: number;
  createdAt: string;
}

const grantsKey = (account: string) => `acan:grants:${account}`;

export function loadGrants(account: string): AgentGrant[] {
  try {
    const raw = localStorage.getItem(grantsKey(account));
    if (!raw) return [];
    return (JSON.parse(raw) as any[]).map((g) => ({ ...g, limitStroops: BigInt(g.limitStroops) }));
  } catch {
    return [];
  }
}

function saveGrants(account: string, grants: AgentGrant[]) {
  try {
    localStorage.setItem(
      grantsKey(account),
      JSON.stringify(grants.map((g) => ({ ...g, limitStroops: g.limitStroops.toString() }))),
    );
  } catch {
    /* storage unavailable: grants still exist on-chain */
  }
}

/**
 * Give an agent key a capped allowance: a new context rule that applies only
 * to calls on the USDC contract, whose sole signer is the agent's Ed25519 key,
 * with OpenZeppelin's spending-limit policy attached. The guardian's passkey
 * signs this change; the agent can never widen it.
 */
export async function grantAgent(agentKey: string, limitStroops: bigint, periodLedgers: number): Promise<AgentGrant> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  if (!StrKey.isValidEd25519PublicKey(agentKey)) throw new Error("Agent key must be a G... public key");
  if (limitStroops <= 0n) throw new Error("Limit must be greater than zero");

  const signer = createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, StrKey.decodeEd25519PublicKey(agentKey));
  const policyParams = kit.convertPolicyParams(
    "spending_limit",
    createSpendingLimitParams(limitStroops, periodLedgers),
  );
  const tx = await kit.rules.add(
    createCallContractContext(ASSETS.usdc.sac),
    "agent-usdc",
    [signer],
    new Map([[OZ_SMART_ACCOUNT.spendingLimitPolicy, policyParams]]),
  );
  const simulated = tx.result as ContextRule | undefined;
  const result = await kit.signAndSubmit(tx);
  if (!result.success) throw new Error(result.error?.message ?? "Rule creation failed");

  const ruleId = typeof simulated?.id === "number" ? simulated.id : (await kit.rules.count()) - 1;
  const grant: AgentGrant = {
    ruleId,
    agentKey,
    limitStroops,
    periodLedgers,
    createdAt: new Date().toISOString(),
  };
  saveGrants(account, [...loadGrants(account).filter((g) => g.ruleId !== ruleId), grant]);
  return grant;
}

/** Revoke instantly by deleting the agent's context rule. */
export async function revokeAgent(ruleId: number): Promise<void> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  const tx = await kit.rules.remove(ruleId);
  const result = await kit.signAndSubmit(tx);
  if (!result.success) throw new Error(result.error?.message ?? "Revoke failed");
  saveGrants(account, loadGrants(account).filter((g) => g.ruleId !== ruleId));
}

export interface Allowance {
  limit: bigint;
  spent: bigint;
  periodLedgers: number;
  payments: number;
}

export async function readAllowance(ruleId: number): Promise<Allowance | null> {
  try {
    const d = await kit.policyClients.spendingLimit(OZ_SMART_ACCOUNT.spendingLimitPolicy).getSpendingLimitData(ruleId);
    return {
      limit: BigInt(d.spending_limit),
      spent: BigInt(d.cached_total_spent),
      periodLedgers: d.period_ledgers,
      payments: d.spending_history.length,
    };
  } catch {
    return null; // rule removed or not installed
  }
}

export async function usdcBalance(address: string): Promise<bigint> {
  const sim = await server.simulateTransaction(
    await buildRead(ASSETS.usdc.sac, "balance", [nativeToScVal(address, { type: "address" })]),
  );
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return BigInt(scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as bigint);
}

async function buildRead(contractId: string, fn: string, args: xdr.ScVal[]) {
  const { Account, Keypair, TransactionBuilder, Operation, Address, BASE_FEE } = await import("@stellar/stellar-sdk");
  return new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: TESTNET.networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName: fn,
            args,
          }),
        ),
        auth: [],
      }),
    )
    .setTimeout(30)
    .build();
}

export interface Payment {
  id: string;
  txHash: string;
  ledger: number;
  closedAt: string;
  to: string;
  amount: bigint;
}

/**
 * Recent USDC transfers out of the smart account, read from Soroban events.
 * Topics of a SAC transfer event: ["transfer", from, to, asset-name].
 */
export async function recentPayments(account: string): Promise<Payment[]> {
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - 17_000); // ~1 day
  const fromTopic = nativeToScVal(account, { type: "address" }).toXDR("base64");
  const res = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [ASSETS.usdc.sac],
        topics: [[xdr.ScVal.scvSymbol("transfer").toXDR("base64"), fromTopic, "*", "*"]],
      },
    ],
    limit: 100,
  });
  return res.events
    .map((e) => ({
      id: e.id,
      txHash: e.txHash,
      ledger: e.ledger,
      closedAt: e.ledgerClosedAt,
      to: scValToNative(e.topic[2]) as string,
      amount: amountOf(e.value),
    }))
    .reverse();
}

function amountOf(v: xdr.ScVal): bigint {
  const n = scValToNative(v);
  if (typeof n === "bigint") return n;
  if (n && typeof n === "object" && "amount" in n) return BigInt((n as { amount: bigint }).amount);
  return 0n;
}

export const fmt = (stroops: bigint) => stroopsToUsdc(stroops);
export const short = (a: string, n = 4) => `${a.slice(0, n + 1)}…${a.slice(-n)}`;
export const explorer = (kind: "tx" | "contract" | "account", id: string) =>
  `https://stellar.expert/explorer/testnet/${kind}/${id}`;
