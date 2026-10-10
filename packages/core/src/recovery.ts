/**
 * Recovery codes for a guardian's passkey wallet.
 *
 * A recovery key is an ed25519 key made in the guardian's browser and added to
 * the smart account under a rule of its own (OpenZeppelin context rule, no
 * custom contract). On a new device the guardian creates a passkey and the
 * recovery key gives it a rule of its own too. (Adding the new passkey to the
 * guardian's existing rule would lock that rule: OpenZeppelin requires every
 * signer of a rule without policies to sign.)
 *
 * The key can authorize anything the account can do, so the code is treated
 * like the account's key: whoever holds it can take the account over.
 */
import { Buffer } from "buffer";
import { Account, BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder, contract, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SmartAccountAgentSigner, entryAddress } from "./agent-signer.js";
import { OZ_SMART_ACCOUNT, TESTNET } from "./config.js";
import { describeSimulationError } from "./errors.js";

/** The guardian's own rule: the passkey's rule, created with the wallet. */
export const GUARDIAN_RULE_ID = 0;
export const RECOVERY_RULE_NAME = "recovery";
const PREFIX = "acan-recovery-1";

export interface RecoveryCode {
  /** The smart account (C…). */
  account: string;
  /** The recovery rule's id on that account. */
  ruleId: number;
  /** The recovery key's secret (S…). */
  secret: string;
}

/** `acan-recovery-1:<rule id>:<account>:<secret>` */
export function formatRecoveryCode(c: RecoveryCode): string {
  checkCode(c);
  return `${PREFIX}:${c.ruleId}:${c.account}:${c.secret}`;
}

/** Parses a recovery code, tolerating spaces and line breaks from copying. */
export function parseRecoveryCode(text: string): RecoveryCode {
  const t = text.replace(/\s+/g, "");
  const parts = t.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("This is not an ACAN recovery code (it starts with “acan-recovery-1:”).");
  const [, rule, account, secret] = parts;
  if (!/^\d{1,9}$/.test(rule)) throw new Error("The recovery code's rule number is damaged.");
  const c = { account, ruleId: Number(rule), secret };
  checkCode(c);
  return c;
}

function checkCode(c: RecoveryCode): void {
  if (!StrKey.isValidContract(c.account)) throw new Error("The recovery code's account address is damaged.");
  if (!StrKey.isValidEd25519SecretSeed(c.secret)) throw new Error("The recovery code's key is damaged.");
  if (!Number.isInteger(c.ruleId) || c.ruleId < 0) throw new Error("The recovery code's rule number is damaged.");
}

/** The recovery key's public half, as registered on the account. */
export function recoveryPublicKey(c: RecoveryCode): Buffer {
  return Buffer.from(Keypair.fromSecret(c.secret).rawPublicKey());
}

/**
 * Is the code's recovery rule still on the account with the code's key?
 * "missing" when it was removed or the code belongs to another rule.
 */
export async function recoveryRuleStatus(
  code: RecoveryCode,
  rpcUrl: string = TESTNET.rpcUrl,
  networkPassphrase: string = TESTNET.networkPassphrase,
): Promise<"ok" | "missing" | "outdated"> {
  const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.invokeContractFunction({ contract: code.account, function: "get_context_rule", args: [nativeToScVal(code.ruleId, { type: "u32" })] }))
    .setTimeout(30)
    .build();
  const sim = await new rpc.Server(rpcUrl).simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return "missing";
  const rule = scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as { signers?: unknown[]; policies?: unknown[] };
  const mine = recoveryPublicKey(code);
  const has = (rule?.signers ?? []).some((x) => Array.isArray(x) && x[0] === "External" && Buffer.from(x[2] as Uint8Array).equals(mine));
  if (!has) return "missing";
  // Codes made by an earlier version of the site carry a policy that only allows that version's recovery step.
  return (rule?.policies ?? []).length > 0 ? "outdated" : "ok";
}

export const RECOVERY_MISSING_MESSAGE =
  "This recovery code doesn't match a recovery key on that account any more. Check that it is the newest code for this wallet.";

export const RECOVERY_OUTDATED_MESSAGE =
  "This recovery code was made by an earlier version of the site, so it can't be used. Reload the page where your wallet is (to get the current version), press Start over, and make a new wallet and code.";

/** The text of the downloadable .txt file. */
export function recoveryFileText(c: RecoveryCode, opts: { network?: string; site?: string } = {}): string {
  return [
    "ACAN recovery code",
    "",
    formatRecoveryCode(c),
    "",
    `Smart account: ${c.account}`,
    `Network: ${opts.network ?? "Stellar testnet"}`,
    `Recovery rule: #${c.ruleId}`,
    "",
    "Your passkey lives on one device. If that device is lost, this code adds a new",
    "passkey for your account from another device" + (opts.site ? ` (${opts.site})` : "") + ".",
    "",
    "Keep it offline. Anyone holding this code can take over your account and spend",
    "from it. Treat it like a key, not a note.",
    "",
  ].join("\n");
}

/**
 * Gives a new passkey a rule of its own on the account, authorized by the
 * recovery key under the recovery rule. `args` are the encoded arguments of
 * `add_context_rule` (built by the account's own client, so they match its
 * contract spec). `source` only pays the network fee. Returns the transaction
 * hash and the new passkey's rule id.
 */
export async function recoverWithCode(opts: {
  code: RecoveryCode;
  args: xdr.ScVal[];
  source: Keypair;
  rpcUrl?: string;
  networkPassphrase?: string;
  ed25519Verifier?: string;
}): Promise<{ tx: string; ruleId: number }> {
  const { code, source } = opts;
  const rpcUrl = opts.rpcUrl ?? TESTNET.rpcUrl;
  const networkPassphrase = opts.networkPassphrase ?? TESTNET.networkPassphrase;
  const key = new SmartAccountAgentSigner({
    smartAccount: code.account,
    agentSecret: code.secret,
    contextRuleId: code.ruleId,
    networkPassphrase,
    ed25519Verifier: opts.ed25519Verifier ?? OZ_SMART_ACCOUNT.ed25519Verifier,
  });

  const tx = await contract.AssembledTransaction.build({
    contractId: code.account,
    method: "add_context_rule",
    args: opts.args,
    networkPassphrase,
    rpcUrl,
    publicKey: source.publicKey(),
    parseResultXdr: (r) => r,
  });
  if (rpc.Api.isSimulationError(tx.simulation!)) throw new Error(`Recovery refused: ${describeSimulationError(tx.simulation.error)}`);

  const latest = await new rpc.Server(rpcUrl).getLatestLedger();
  const op = tx.built!.operations[0] as unknown as { auth?: xdr.SorobanAuthorizationEntry[] };
  const auth = op.auth ?? [];
  let signed = 0;
  for (const [i, entry] of auth.entries()) {
    if (entryAddress(entry) !== code.account) continue;
    auth[i] = await key.signEntry(entry, latest.sequence + 60);
    signed++;
  }
  if (signed !== 1) throw new Error(`Expected one smart-account auth entry, signed ${signed}`);

  // Enforcing simulation: runs the account's __check_auth with the recovery key.
  await tx.simulate();
  if (rpc.Api.isSimulationError(tx.simulation!)) throw new Error(`Recovery refused: ${describeSimulationError(tx.simulation.error)}`);
  const sim = tx.simulation as rpc.Api.SimulateTransactionSuccessResponse;
  const rule = scValToNative(sim.result!.retval) as { id?: number | bigint };
  const ruleId = Number(rule?.id);
  if (!Number.isInteger(ruleId)) throw new Error("Could not read the new passkey's rule id");

  const sent = await tx.signAndSend({ signTransaction: contract.basicNodeSigner(source, networkPassphrase).signTransaction });
  const hash = sent.sendTransactionResponse?.hash;
  if (!hash) throw new Error("The recovery transaction was not submitted");
  return { tx: hash, ruleId };
}
