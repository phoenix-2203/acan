import { Buffer } from "buffer";
import { StrKey, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  IndexedDBStorage,
  SmartAccountKit,
  createCallContractContext,
  createEd25519Signer,
  createSpendingLimitParams,
  createWeightedThresholdParams,
  type ContextRule,
} from "smart-account-kit";
import { ASSETS, OZ_SMART_ACCOUNT, TESTNET, getEventsSince, stroopsToUsdc } from "@acan/core/browser";
import { encodeMerchantPolicyParams, type RecipientCap } from "./merchant-policy";

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
  /** Ledger after which the rule stops authorizing anything (undefined = never). */
  validUntil?: number;
  /** Recipients the rule may pay (merchant budget policy), if installed. */
  recipients?: string[];
  /** Per-recipient caps in atomic units as strings ("0" = no cap), aligned with `recipients`. */
  caps?: string[];
  /** Payments allowed per period by the merchant budget policy (0 = no limit). */
  maxPayments?: number;
  /** Largest single payment in atomic units as a string ("0" = no limit). */
  maxPerPayment?: string;
  /** Set when the rule is a task budget the agent asked for. */
  task?: string;
  /** Found on-chain but not in this browser's records (e.g. storage was cleared). */
  discovered?: boolean;
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
export async function grantAgent(
  agentKey: string,
  limitStroops: bigint,
  periodLedgers: number,
  /** Expire the allowance this many ledgers from now (undefined = never). */
  expiresInLedgers?: number,
  /** Only allow transfers to these recipients, each with an optional cap (ACAN merchant budget policy). */
  allowlist?: {
    policy: string;
    recipients: RecipientCap[];
    maxPayments: number;
    /** Largest single payment, atomic units (0n = none). Needs policy v0.3. */
    maxPerPayment?: bigint;
    version?: "0.2" | "0.3";
  },
  /** Label the rule as a task budget. */
  task?: string,
  /** Provenance gate: the rule also needs this co-signer (OZ weighted threshold policy). */
  gate?: { policy: string; cosigner: string },
): Promise<AgentGrant> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  if (!StrKey.isValidEd25519PublicKey(agentKey)) throw new Error("Agent key must be a G... public key");
  if (limitStroops <= 0n) throw new Error("Limit must be greater than zero");

  const signer = createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, StrKey.decodeEd25519PublicKey(agentKey));
  const policyParams = kit.convertPolicyParams(
    "spending_limit",
    createSpendingLimitParams(limitStroops, periodLedgers),
  );
  // valid_until is enforced by the smart account itself: after that ledger the
  // rule no longer authorizes anything, with no further action needed.
  const validUntil = expiresInLedgers ? (await currentLedger()) + expiresInLedgers : undefined;
  const policies = new Map<string, unknown>([[OZ_SMART_ACCOUNT.spendingLimitPolicy, policyParams]]);
  if (allowlist) {
    policies.set(
      allowlist.policy,
      encodeMerchantPolicyParams({
        recipients: allowlist.recipients,
        periodLedgers,
        maxPayments: allowlist.maxPayments,
        maxPerPayment: allowlist.maxPerPayment,
        version: allowlist.version ?? "0.2",
      }),
    );
  }
  const signers = [signer];
  if (gate) {
    if (!StrKey.isValidEd25519PublicKey(gate.cosigner)) throw new Error("Co-signer must be a G... public key");
    const cosigner = createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, StrKey.decodeEd25519PublicKey(gate.cosigner));
    signers.push(cosigner);
    // Agent 1, co-signer 1, threshold 2: the agent's key alone never suffices.
    const weights = new Map<any, number>([
      [signer, 1],
      [cosigner, 1],
    ]);
    policies.set(gate.policy, kit.convertPolicyParams("weighted_threshold", createWeightedThresholdParams(2, weights)));
  }
  // One passkey approval installs the rule with all its policies at once.
  const tx = await kit.rules.add(
    createCallContractContext(ASSETS.usdc.sac),
    gate ? "agent-usdc-gated" : "agent-usdc",
    signers,
    policies,
    validUntil,
  );
  const simulated = tx.result as ContextRule | undefined;
  const result = await kit.signAndSubmitAdmin(tx);
  if (!result.success) throw new Error(result.error?.message ?? "Rule creation failed");

  // get_context_rules_count is the number of live rules, not the next id
  // (ids stay sparse after revocations), so fall back to reading the chain.
  const ruleId =
    typeof simulated?.id === "number"
      ? simulated.id
      : Math.max(...(await agentRulesOnChain()).filter((r) => r.agentKey === agentKey).map((r) => r.ruleId));
  if (!Number.isInteger(ruleId)) throw new Error("Rule created, but its id could not be read back; refresh the page");
  const grant: AgentGrant = {
    ruleId,
    agentKey,
    limitStroops,
    periodLedgers,
    validUntil,
    recipients: allowlist?.recipients.map((r) => r.address),
    caps: allowlist?.recipients.map((r) => r.cap.toString()),
    maxPayments: allowlist?.maxPayments,
    maxPerPayment: allowlist?.maxPerPayment ? allowlist.maxPerPayment.toString() : undefined,
    task,
    createdAt: new Date().toISOString(),
  };
  saveGrants(account, [...loadGrants(account).filter((g) => g.ruleId !== ruleId), grant]);
  return grant;
}

/** An agent rule as it exists on-chain (whatever this browser remembers). */
export interface OnChainAgentRule {
  ruleId: number;
  name: string;
  agentKey: string;
  validUntil?: number;
  policies: string[];
}

/**
 * Every rule on the connected account whose signer is an Ed25519 agent key,
 * read from the contract. The dashboard lists these even if this browser's
 * storage was cleared, so no live allowance can hide from the guardian.
 */
export async function agentRulesOnChain(): Promise<OnChainAgentRule[]> {
  const rules = await kit.rules.list();
  return rules.flatMap((r) => {
    const key = r.signers.find((s) => s.tag === "External" && s.values[0] === OZ_SMART_ACCOUNT.ed25519Verifier);
    if (!key || key.tag !== "External" || key.values[1].length !== 32) return [];
    return [
      {
        ruleId: r.id,
        name: r.name,
        agentKey: StrKey.encodeEd25519PublicKey(Buffer.from(key.values[1])),
        validUntil: r.valid_until ?? undefined,
        policies: [...r.policies],
      },
    ];
  });
}

/** Revoke instantly by deleting the agent's context rule. */
export async function revokeAgent(ruleId: number): Promise<void> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  const tx = await kit.rules.remove(ruleId);
  const result = await kit.signAndSubmitAdmin(tx);
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

export async function currentLedger(): Promise<number> {
  return (await server.getLatestLedger()).sequence;
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
  // getEvents scans 10,000 ledgers per call: follow the cursor up to now.
  const events = await getEventsSince(server, startLedger, [
    {
      type: "contract",
      contractIds: [ASSETS.usdc.sac],
      topics: [[xdr.ScVal.scvSymbol("transfer").toXDR("base64"), fromTopic, "*", "*"]],
    },
  ]);
  return events
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
