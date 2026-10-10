/**
 * Recovery codes for a guardian's passkey wallet.
 *
 * A recovery key is an ed25519 key made in the guardian's browser and added to
 * the smart account under its own context rule: scoped to the account's own
 * address and narrowed by ACAN's recovery scope policy
 * (contracts/recovery-scope-policy) to one action, adding a signer to the
 * guardian's rule (#0). It cannot pay, call `execute`, or upgrade the account.
 *
 * The recovery code carries everything needed on a new device: the account,
 * the recovery rule's id, and the key. On a new device the guardian creates a
 * passkey and the code adds it to rule #0.
 */
import { Buffer } from "buffer";
import { Keypair, StrKey, contract, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
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
 * Install parameters of the recovery scope policy: the Soroban struct
 * `RecoveryScopeParams { admin_rule_id: u32 }`, a map keyed by field name.
 */
export function recoveryScopeParams(adminRuleId = GUARDIAN_RULE_ID): xdr.ScVal {
  return xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("admin_rule_id"), val: xdr.ScVal.scvU32(adminRuleId) })]);
}

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
    "passkey to your account from another device" + (opts.site ? ` (${opts.site})` : "") + ".",
    "",
    "Keep it offline. The code cannot pay from your account on its own, but anyone",
    "holding it could add their own passkey and take over the account. Treat it like a key.",
    "",
  ].join("\n");
}

/**
 * Adds `signer` (a new passkey) to the guardian's rule, authorized by the
 * recovery key under the recovery rule. `source` only pays the network fee.
 * Returns the transaction hash.
 */
export async function recoverWithCode(opts: {
  code: RecoveryCode;
  /** The new signer, as the account's `Signer` ScVal (e.g. smart-account-kit's signerToScVal). */
  signer: xdr.ScVal;
  source: Keypair;
  rpcUrl?: string;
  networkPassphrase?: string;
  ed25519Verifier?: string;
}): Promise<string> {
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
    method: "add_signer",
    args: [nativeToScVal(GUARDIAN_RULE_ID, { type: "u32" }), opts.signer],
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

  // Enforcing simulation: runs __check_auth and the recovery scope policy.
  await tx.simulate();
  if (rpc.Api.isSimulationError(tx.simulation!)) throw new Error(`Recovery refused: ${describeSimulationError(tx.simulation.error)}`);

  const sent = await tx.signAndSend({ signTransaction: contract.basicNodeSigner(source, networkPassphrase).signTransaction });
  const hash = sent.sendTransactionResponse?.hash;
  if (!hash) throw new Error("The recovery transaction was not submitted");
  return hash;
}
