import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { ASSETS, OZ_SMART_ACCOUNT, TESTNET } from "./config.js";

export const server = new rpc.Server(TESTNET.rpcUrl);

/** Any funded-looking placeholder works as the source for read-only simulation. */
const READ_SOURCE = new Account(Keypair.random().publicKey(), "0");

/** Simulate a read-only contract call and return its native value. */
export async function simulateRead(contractId: string, fn: string, args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(READ_SOURCE, { fee: BASE_FEE, networkPassphrase: TESTNET.networkPassphrase })
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
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn} simulation failed: ${sim.error}`);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new Error(`${fn} returned no result`);
  return scValToNative(retval);
}

/** SEP-41 balance of any address (G or C) for a token contract, in stroops. */
export async function tokenBalance(holder: string, token: string = ASSETS.usdc.sac): Promise<bigint> {
  const v = await simulateRead(token, "balance", [nativeToScVal(holder, { type: "address" })]);
  return BigInt(v as bigint);
}

export interface SpendingLimitState {
  spending_limit: bigint;
  period_ledgers: number;
  cached_total_spent: bigint;
  spending_history: { amount: bigint; ledger_sequence: number }[];
}

/** Read the OZ spending-limit policy state for (smart account, rule). */
export async function spendingLimitState(smartAccount: string, contextRuleId: number): Promise<SpendingLimitState> {
  return (await simulateRead(OZ_SMART_ACCOUNT.spendingLimitPolicy, "get_spending_limit_data", [
    xdr.ScVal.scvU32(contextRuleId),
    nativeToScVal(smartAccount, { type: "address" }),
  ])) as SpendingLimitState;
}

export async function friendbot(address: string): Promise<void> {
  const res = await fetch(`${TESTNET.friendbotUrl}/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) {
    const body = await res.text();
    // Friendbot answers 400 if the account is already funded; that is fine.
    if (!/already funded|createAccountAlreadyExist|op_already_exists/i.test(body)) {
      throw new Error(`Friendbot failed for ${address}: ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

export async function accountExists(address: string): Promise<boolean> {
  try {
    await server.getAccount(address);
    return true;
  } catch {
    return false;
  }
}

/** Submit a classic transaction and wait for it. */
async function submitAndWait(tx: ReturnType<TransactionBuilder["build"]>): Promise<string> {
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`Submission failed: ${JSON.stringify(sent.errorResult?.toXDR("base64"))}`);
  for (let i = 0; i < 30; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return sent.hash;
    if (r.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`Transaction ${sent.hash} failed`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${sent.hash}`);
}

/** Add a USDC trustline to a G account (no-op if it already has one). */
export async function ensureUsdcTrustline(kp: Keypair): Promise<string | null> {
  const usdc = new Asset(ASSETS.usdc.code, ASSETS.usdc.issuer);
  const balance = await tokenBalance(kp.publicKey()).catch(() => null);
  if (balance !== null) return null; // balance() succeeds only when a trustline exists
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return submitAndWait(tx);
}

/** SEP-41 transfer signed by a classic G account (used to fund smart accounts). */
export async function transferFromClassic(
  from: Keypair,
  to: string,
  amount: bigint,
  token: string = ASSETS.usdc.sac,
): Promise<string> {
  const tx = await contract.AssembledTransaction.build({
    contractId: token,
    method: "transfer",
    args: [
      nativeToScVal(from.publicKey(), { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
    networkPassphrase: TESTNET.networkPassphrase,
    rpcUrl: TESTNET.rpcUrl,
    publicKey: from.publicKey(),
    parseResultXdr: (r) => r,
  });
  const signed = await tx.signAndSend({
    signTransaction: contract.basicNodeSigner(from, TESTNET.networkPassphrase).signTransaction,
  });
  const hash = signed.sendTransactionResponse?.hash;
  if (!hash) throw new Error("Transfer was not submitted");
  return hash;
}

export function explorerTx(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

export function explorerAccount(address: string): string {
  return `https://stellar.expert/explorer/testnet/${address.startsWith("C") ? "contract" : "account"}/${address}`;
}

export interface MerchantPolicyView {
  recipients: { address: string; cap: bigint }[];
  period_ledgers: number;
  max_payments: number;
  /** Largest single payment (atomic units); 0n = no limit or a v0.2 contract. */
  max_per_payment: bigint;
}

export interface MerchantPolicyUsage {
  window_start: number;
  payments: number;
  /** Paid per recipient in the current period. */
  spent: Map<string, bigint>;
}

/** Read the merchant budget policy installed on a smart account's rule, and its current-period usage. */
export async function merchantPolicyState(
  policy: string,
  smartAccount: string,
  contextRuleId: number,
): Promise<{ params: MerchantPolicyView; usage: MerchantPolicyUsage }> {
  const args = [nativeToScVal(contextRuleId, { type: "u32" }), nativeToScVal(smartAccount, { type: "address" })];
  const params = (await simulateRead(policy, "get_params", args)) as any;
  const state = (await simulateRead(policy, "get_state", args)) as any;
  const spent = new Map<string, bigint>();
  const raw = state.spent;
  if (raw instanceof Map) for (const [k, v] of raw) spent.set(String(k), BigInt(v));
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) spent.set(k, BigInt(v as bigint));
  return {
    params: {
      recipients: (params.recipients ?? []).map((r: any) => ({ address: String(r.address), cap: BigInt(r.cap) })),
      period_ledgers: Number(params.period_ledgers),
      max_payments: Number(params.max_payments),
      max_per_payment: BigInt(params.max_per_payment ?? 0),
    },
    usage: { window_start: Number(state.window_start), payments: Number(state.payments), spent },
  };
}
