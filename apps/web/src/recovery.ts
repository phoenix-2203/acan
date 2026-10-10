/**
 * Recovery codes for the guardian wallet (the same design as the demo site): a
 * recovery key under a rule of its own (an OpenZeppelin context rule, no custom
 * contract). On a new device the code gives a new passkey a rule of its own.
 * The code is kept in this browser so it can be shown again.
 */
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { createDefaultContext, createEd25519Signer, createWebAuthnSigner, type ContextRule, type StoredCredential } from "smart-account-kit";
import {
  OZ_SMART_ACCOUNT,
  RECOVERY_MISSING_MESSAGE,
  RECOVERY_OUTDATED_MESSAGE,
  RECOVERY_RULE_NAME,
  TESTNET,
  formatRecoveryCode,
  parseRecoveryCode,
  recoverWithCode,
  recoveryRuleStatus,
  type RecoveryCode,
} from "@acan/core/browser";
import { guardianOnly, kit, setGuardianRule, storage } from "./acan";

const RECOVERED = "acan-recovered-passkey";
const CODES = "acan-recovery-codes";

interface Recovered {
  contractId: string;
  credentialId: string;
  /** The new passkey's own rule. */
  guardianRule: number;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

/** The recovery code this browser holds for an account (made here or used here). */
export function savedCode(account: string): RecoveryCode | null {
  const c = readJson<Record<string, string>>(CODES)?.[account];
  try {
    return c ? parseRecoveryCode(c) : null;
  } catch {
    return null;
  }
}

function remember(code: RecoveryCode): void {
  writeJson(CODES, { ...(readJson<Record<string, string>>(CODES) ?? {}), [code.account]: formatRecoveryCode(code) });
}

/** Is this browser's passkey one that was added with a recovery code? */
export function recoveredPasskey(): Recovered | null {
  return readJson<Recovered>(RECOVERED);
}

/**
 * Connect a passkey that was added with a recovery code. It is not the wallet's
 * first passkey, so the kit's birth check for first passkeys does not apply; the
 * account and passkey come from the guardian's own code, and signing looks the
 * passkey up on-chain.
 */
export function connectRecovered(): string | null {
  const r = recoveredPasskey();
  if (!r || !Number.isInteger(r.guardianRule)) return null;
  (kit as unknown as { setConnectedState(c: string, k?: string): void }).setConnectedState(r.contractId, r.credentialId);
  setGuardianRule(r.guardianRule);
  return r.contractId;
}

/** Adds a recovery key to the connected guardian wallet and returns its code. */
export async function setupRecovery(): Promise<RecoveryCode> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  const key = Keypair.random();
  const tx = await kit.rules.add(createDefaultContext(), RECOVERY_RULE_NAME, [createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, key.rawPublicKey())], new Map<string, unknown>());
  const simulated = tx.result as ContextRule | undefined;
  const result = await kit.signAndSubmitAdmin(tx, guardianOnly());
  if (!result.success) throw new Error(result.error?.message ?? "The recovery key was not added");
  if (typeof simulated?.id !== "number") throw new Error("The recovery key was added but its rule id could not be read; check the account's rules before relying on the code");
  const code = { account, ruleId: simulated.id, secret: key.secret() };
  remember(code);
  return code;
}

/** On a new device: create a passkey here and give it a rule of its own with the recovery code. */
export async function recoverWallet(codeText: string, progress: (m: string) => void): Promise<{ account: string; tx: string }> {
  const code = parseRecoveryCode(codeText);
  progress("Checking your recovery code on testnet…");
  const status = await recoveryRuleStatus(code);
    if (status !== "ok") throw new Error(status === "outdated" ? RECOVERY_OUTDATED_MESSAGE : RECOVERY_MISSING_MESSAGE);
  progress("Funding a throwaway testnet account to pay the fee…");
  const fee = Keypair.random();
  const r = await fetch(`${TESTNET.friendbotUrl}?addr=${encodeURIComponent(fee.publicKey())}`);
  if (!r.ok) throw new Error("Friendbot could not fund the fee account; try again in a minute");
  progress("Create a passkey for this device when your browser asks…");
  const created = await (kit as unknown as {
    createPasskey(app: string, user: string): Promise<{ credentialId: string; publicKey: Uint8Array; rawResponse: { response: { transports?: string[] } } }>;
  }).createPasskey("ACAN", "guardian (recovered)");
  const signer = createWebAuthnSigner(OZ_SMART_ACCOUNT.webauthnVerifier, created.publicKey, created.credentialId);
  // Let the account's own client encode add_context_rule, then sign with the recovery key.
  const k = kit as unknown as { setConnectedState(c: string, id?: string): void };
  k.setConnectedState(code.account, undefined);
  const draft = await kit.rules.add(createDefaultContext(), "recovered passkey", [signer], new Map<string, unknown>());
  const args = (draft.built!.operations[0] as unknown as { func: { invokeContract(): { args(): xdr.ScVal[] } } }).func.invokeContract().args();
  progress("Adding the new passkey to your account with the recovery code…");
  const { tx, ruleId } = await recoverWithCode({ code, args, source: fee });
  await storage.save({
    credentialId: created.credentialId,
    publicKey: created.publicKey,
    contractId: code.account,
    nickname: "Recovered passkey",
    createdAt: Date.now(),
    transports: created.rawResponse.response.transports,
    isPrimary: false,
    contextRuleId: ruleId,
    deploymentStatus: "deployed",
    associationVerified: true,
  } as StoredCredential);
  writeJson(RECOVERED, { contractId: code.account, credentialId: created.credentialId, guardianRule: ruleId });
  remember(code);
  connectRecovered();
  return { account: code.account, tx };
}
