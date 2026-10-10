/**
 * Recovery codes for the guardian wallet (the same design as the demo site):
 * a recovery key under its own rule, scoped to the account's own address and
 * limited by ACAN's recovery scope policy to giving one new passkey a rule of
 * its own. It can never pay.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { createCallContractContext, createEd25519Signer, createWebAuthnSigner, signerToScVal, type ContextRule, type StoredCredential } from "smart-account-kit";
import {
  OZ_SMART_ACCOUNT,
  RECOVERY_RULE_NAME,
  TESTNET,
  parseRecoveryCode,
  recoverWithCode,
  recoveryScopeParams,
  type RecoveryCode,
} from "@acan/core/browser";
import { guardianOnly, kit, setGuardianRule, storage } from "./acan";



const RECOVERED = "acan-recovered-passkey";
const RULES = "acan-recovery-rules";

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

/** The recovery rule this browser set up (or recovered with) for an account. */
export function recoveryRuleFor(account: string): number | undefined {
  return readJson<Record<string, number>>(RULES)?.[account];
}

function rememberRule(account: string, ruleId: number): void {
  writeJson(RULES, { ...(readJson<Record<string, number>>(RULES) ?? {}), [account]: ruleId });
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
  if (!r) return null;
  if (!Number.isInteger(r.guardianRule)) return null;
  (kit as unknown as { setConnectedState(c: string, k: string): void }).setConnectedState(r.contractId, r.credentialId);
  setGuardianRule(r.guardianRule);
  return r.contractId;
}

/** Adds a recovery key to the connected guardian wallet and returns the code (never stored). */
export async function setupRecovery(policy: string): Promise<RecoveryCode> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  const key = Keypair.random();
  const tx = await kit.rules.add(
    createCallContractContext(account),
    RECOVERY_RULE_NAME,
    [createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, key.rawPublicKey())],
    new Map<string, unknown>([[policy, recoveryScopeParams()]]),
  );
  const simulated = tx.result as ContextRule | undefined;
  const result = await kit.signAndSubmitAdmin(tx, guardianOnly());
  if (!result.success) throw new Error(result.error?.message ?? "The recovery rule was not created");
  if (typeof simulated?.id !== "number") throw new Error("The recovery rule was created but its id could not be read; check the account's rules before relying on the code");
  rememberRule(account, simulated.id);
  return { account, ruleId: simulated.id, secret: key.secret() };
}

/**
 * A new recovery code, then the old recovery rule removed so a missed or leaked
 * code stops working. The new code is returned even if the removal fails.
 */
export async function replaceRecovery(policy: string): Promise<{ code: RecoveryCode; warning?: string }> {
  const account = kit.contractId;
  if (!account) throw new Error("Connect the guardian wallet first");
  const old = recoveryRuleFor(account);
  const code = await setupRecovery(policy);
  if (old === undefined || old === code.ruleId) return { code };
  try {
    const rule = (await kit.rules.get(old)).result;
    if (rule.name !== RECOVERY_RULE_NAME) return { code, warning: `Rule #${old} is not a recovery rule, so it was left alone.` };
    const res = await kit.signAndSubmitAdmin(await kit.rules.remove(old), guardianOnly());
    if (!res.success) throw new Error(res.error?.message ?? "not removed");
    return { code };
  } catch (e) {
    return { code, warning: `Your new code works, but the old one (rule #${old}) could not be switched off: ${e instanceof Error ? e.message : String(e)}. Make a new code again to retry.` };
  }
}

/** On a new device: create a passkey here and add it to the account with the recovery code. */
export async function recoverWallet(codeText: string, progress: (m: string) => void): Promise<{ account: string; tx: string }> {
  const code = parseRecoveryCode(codeText);
  progress("Funding a throwaway testnet account to pay the fee…");
  const fee = Keypair.random();
  const r = await fetch(`${TESTNET.friendbotUrl}?addr=${encodeURIComponent(fee.publicKey())}`);
  if (!r.ok) throw new Error("Friendbot could not fund the fee account; try again in a minute");
  progress("Create a passkey for this device when your browser asks…");
  const created = await (kit as unknown as {
    createPasskey(app: string, user: string): Promise<{ credentialId: string; publicKey: Uint8Array; rawResponse: { response: { transports?: string[] } } }>;
  }).createPasskey("ACAN", "guardian (recovered)");
  const signer = createWebAuthnSigner(OZ_SMART_ACCOUNT.webauthnVerifier, created.publicKey, created.credentialId);
  progress("Adding the new passkey to your account with the recovery code…");
  const { tx, ruleId } = await recoverWithCode({ code, signer: signerToScVal(signer), source: fee });
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
  rememberRule(code.account, code.ruleId);
  connectRecovered();
  return { account: code.account, tx };
}
