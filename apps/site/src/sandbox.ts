/**
 * The in-browser sandbox: a real passkey smart account on Stellar testnet,
 * a real agent key with a capped allowance, and real payments that the
 * account itself accepts or refuses. No server is involved.
 *
 * Testnet only. Who pays which fee:
 *   - a throwaway "deployer" account (funded by Friendbot) deploys the
 *     wallet and pays for the guardian's passkey-signed changes;
 *   - the agent's own key (funded by Friendbot) pays the fee for each of its
 *     payments, while the money itself comes out of the smart account under
 *     the agent's capped rule.
 * The sandbox keys are kept in this browser's localStorage so a reload can
 * resume; they control nothing but testnet XLM.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  IndexedDBStorage,
  SmartAccountKit,
  createCallContractContext,
  createEd25519Signer,
  createSpendingLimitParams,
  createWeightedThresholdParams,
  type ContextRule,
} from "smart-account-kit";
import {
  ASSETS,
  OZ_SMART_ACCOUNT,
  PaymentRejectedError,
  SmartAccountAgentSigner,
  TESTNET,
  contractErrorCode,
  describeSimulationError,
  encodeMerchantPolicyParams,
  gatedSmartAccountTransfer,
  ProvenanceCosigner,
  ProvenanceEscalation,
  signRequest,
  smartAccountTransfer,
  type PricedItem,
  type SignedRequest,
  type Step,
} from "@acan/core/browser";
import { contextRules, latestLedger, read, u32 } from "./chain";
import { encodeAllowlistV1 } from "./policy-v1";

export const XLM = ASSETS.xlm.sac;
const STORE = "acan-sandbox-v1";

export interface Shop {
  name: string;
  address: string;
  /** Per-period cap in stroops; 0n = no cap of its own. */
  cap: bigint;
}

export interface GrantSettings {
  limit: bigint;
  periodLedgers: number;
  /** Minutes until the rule expires on its own; 0 = never. */
  expiresInMinutes: number;
  shops: Shop[];
  /** Merchant budget policy contract and its version, if the allowlist is on. */
  policy?: { address: string; version: string };
  maxPayments: number;
  /** Largest single payment in stroops; 0n = none (policy v0.3 only). */
  maxPerPayment: bigint;
  /** Co-signer gate policy (OZ weighted threshold): when set, the rule also needs the provenance co-signer. */
  gate?: string;
  /** The price book the guardian pins for the co-signer (gated rules). */
  catalog?: PricedItem[];
}

export interface SavedGrant extends Omit<GrantSettings, "limit" | "shops" | "maxPerPayment" | "gate"> {
  /** The rule needs the provenance co-signer next to the agent. */
  gated?: boolean;
  maxPerPayment?: string;
  ruleId: number;
  limit: string;
  shops: { name: string; address: string; cap: string }[];
  validUntil?: number;
  revoked?: boolean;
}

interface Saved {
  deployerSecret: string;
  agentSecret: string;
  attackerSecret: string;
  /** Provenance co-signer key (runs in this browser for the demo). */
  cosignerSecret?: string;
  /** Stands in for a key on the user's own device that signs their requests. */
  deviceSecret?: string;
  contractId?: string;
  credentialId?: string;
  grant?: SavedGrant;
}

export type Outcome =
  | { ok: true; tx: string; authEntry?: string; cosignature?: string }
  | { ok: false; refused: boolean; code: number | null; reason: string; why?: string[]; verdict?: "escalate" | "reject" };

/** What the autonomous agent asks the co-signer to back: the request, the plan, what it read, and which payment. */
export interface GatedCase {
  request: SignedRequest;
  plan: Step[];
  transcript: Record<string, string>;
  payIndex: number;
}

function load(): Saved | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function save(s: Saved): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    /* private mode: the sandbox still works for this visit */
  }
}

/** Fund a testnet account with Friendbot (idempotent: an existing account is fine). */
export async function friendbot(address: string): Promise<void> {
  const r = await fetch(`${TESTNET.friendbotUrl}?addr=${encodeURIComponent(address)}`);
  if (r.ok) return;
  const text = await r.text();
  // Friendbot answers 400 "createAccountAlreadyExist" for a funded account.
  if (/already|exist/i.test(text)) return;
  throw new Error(`Friendbot could not fund ${address.slice(0, 6)}…: ${text.slice(0, 160)}`);
}

export class Sandbox {
  private state: Saved;
  readonly kit: SmartAccountKit;
  readonly agent: Keypair;
  readonly attacker: Keypair;
  readonly deployer: Keypair;
  readonly cosigner: Keypair;
  readonly device: Keypair;
  private cosignerService?: ProvenanceCosigner;

  constructor() {
    this.state = load() ?? {
      deployerSecret: Keypair.random().secret(),
      agentSecret: Keypair.random().secret(),
      attackerSecret: Keypair.random().secret(),
    };
    this.state.cosignerSecret ??= Keypair.random().secret();
    this.state.deviceSecret ??= Keypair.random().secret();
    save(this.state);
    this.cosigner = Keypair.fromSecret(this.state.cosignerSecret);
    this.device = Keypair.fromSecret(this.state.deviceSecret);
    this.deployer = Keypair.fromSecret(this.state.deployerSecret);
    this.agent = Keypair.fromSecret(this.state.agentSecret);
    this.attacker = Keypair.fromSecret(this.state.attackerSecret);
    this.kit = new SmartAccountKit({
      rpcUrl: TESTNET.rpcUrl,
      networkPassphrase: TESTNET.networkPassphrase,
      accountWasmHash: OZ_SMART_ACCOUNT.accountWasmHash,
      webauthnVerifierAddress: OZ_SMART_ACCOUNT.webauthnVerifier,
      ed25519VerifierAddress: OZ_SMART_ACCOUNT.ed25519Verifier,
      // No relayer: this page's own testnet deployer pays the fees.
      deployerSecret: this.state.deployerSecret,
      storage: new IndexedDBStorage(),
      rpName: "ACAN sandbox",
    });
  }

  get contractId(): string | undefined {
    return this.state.contractId;
  }

  get grant(): SavedGrant | undefined {
    return this.state.grant;
  }

  /** Step 1: a passkey, a smart account, and 10,000 testnet XLM in it. */
  async createWallet(progress: (s: string) => void): Promise<string> {
    progress("Funding a throwaway testnet account to pay the deployment fee…");
    await friendbot(this.deployer.publicKey());
    progress("Create the passkey when your browser asks…");
    const res = await this.kit.createWallet("ACAN sandbox", `Sandbox guardian ${new Date().toLocaleDateString()}`, {
      autoSubmit: true,
      autoFund: true,
      nativeTokenContract: XLM,
    });
    if (res.submitResult && !res.submitResult.success) {
      throw new Error(res.submitResult.error?.message ?? "Deployment failed");
    }
    this.state.contractId = res.contractId;
    this.state.credentialId = res.credentialId;
    this.state.grant = undefined;
    save(this.state);
    if (res.fundResult && !res.fundResult.success) {
      progress("Wallet created. Friendbot funding failed; use “Add testnet XLM”.");
    }
    return res.contractId;
  }

  /** Make sure the kit is connected to this sandbox's wallet (may prompt for the passkey). */
  async connect(): Promise<void> {
    if (this.kit.isConnected && this.kit.contractId === this.state.contractId) return;
    if (!this.state.contractId) throw new Error("Create the wallet first");
    await this.kit.connectWallet({ contractId: this.state.contractId, credentialId: this.state.credentialId });
  }

  async addXlm(): Promise<void> {
    await this.connect();
    const r = await this.kit.fundWallet(XLM);
    if (!r.success) throw new Error(r.error?.message ?? "Funding failed");
  }

  /** Step 2: the guardian's passkey adds the agent's capped, expiring rule. */
  async grantAgent(s: GrantSettings, progress: (m: string) => void): Promise<SavedGrant> {
    await this.connect();
    progress("Funding the agent's fee account on testnet…");
    await Promise.all([friendbot(this.agent.publicKey()), friendbot(this.attacker.publicKey())]);
    // The demo shops must exist on testnet to receive XLM (Friendbot is idempotent).
    progress("Making sure the shops exist on testnet…");
    await Promise.all(s.shops.map((x) => friendbot(x.address).catch(() => undefined)));

    const signer = createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, StrKey.decodeEd25519PublicKey(this.agent.publicKey()));
    const cosignerSigner = createEd25519Signer(OZ_SMART_ACCOUNT.ed25519Verifier, StrKey.decodeEd25519PublicKey(this.cosigner.publicKey()));
    const policies = new Map<string, unknown>([
      [
        OZ_SMART_ACCOUNT.spendingLimitPolicy,
        this.kit.convertPolicyParams("spending_limit", createSpendingLimitParams(s.limit, s.periodLedgers)),
      ],
    ]);
    if (s.policy && s.shops.length > 0) {
      policies.set(
        s.policy.address,
        s.policy.version === "0.1"
          ? encodeAllowlistV1(s.shops.map((x) => x.address))
          : encodeMerchantPolicyParams({
              recipients: s.shops.map((x) => ({ address: x.address, cap: x.cap })),
              periodLedgers: s.periodLedgers,
              maxPayments: s.maxPayments,
              maxPerPayment: s.policy.version === "0.3" ? s.maxPerPayment : 0n,
              version: s.policy.version === "0.3" ? "0.3" : "0.2",
            }),
      );
    }
    if (s.gate) {
      // Agent weight 1, co-signer weight 1, threshold 2: the agent's key alone is never enough.
      const weights = new Map<any, number>([
        [signer, 1],
        [cosignerSigner, 1],
      ]);
      policies.set(s.gate, this.kit.convertPolicyParams("weighted_threshold", createWeightedThresholdParams(2, weights)));
    }
    const validUntil = s.expiresInMinutes > 0 ? (await latestLedger()) + Math.round((s.expiresInMinutes * 60) / 5) : undefined;
    progress("Approve the new rule with your passkey…");
    const tx = await this.kit.rules.add(createCallContractContext(XLM), "sandbox-agent", s.gate ? [signer, cosignerSigner] : [signer], policies, validUntil);
    const simulated = tx.result as ContextRule | undefined;
    const result = await this.kit.signAndSubmitAdmin(tx);
    if (!result.success) throw new Error(result.error?.message ?? "The rule was not created");
    // Rule ids stay sparse after revocations, so the count is not the new id:
    // fall back to finding the agent's rule on-chain.
    const ruleId =
      typeof simulated?.id === "number"
        ? simulated.id
        : Math.max(
            ...(await contextRules(this.state.contractId!))
              .filter((r) => r.signers.some((x) => x.kind === "ed25519" && x.key === this.agent.publicKey()))
              .map((r) => r.id),
          );
    if (!Number.isInteger(ruleId)) throw new Error("The rule was created but its id could not be read back; reload the page");
    const grant: SavedGrant = {
      ruleId,
      limit: s.limit.toString(),
      periodLedgers: s.periodLedgers,
      expiresInMinutes: s.expiresInMinutes,
      validUntil,
      shops: s.shops.map((x) => ({ name: x.name, address: x.address, cap: x.cap.toString() })),
      policy: s.policy && s.shops.length > 0 ? s.policy : undefined,
      maxPayments: s.maxPayments,
      maxPerPayment: s.maxPerPayment.toString(),
      gated: Boolean(s.gate),
      catalog: s.gate ? s.catalog : undefined,
    };
    this.cosignerService = undefined;
    this.state.grant = grant;
    save(this.state);
    return grant;
  }

  /** Step 3: the agent pays from the smart account, signing with its own key only. */
  async agentPays(to: string, amount: bigint): Promise<Outcome> {
    const g = this.state.grant;
    if (!g || !this.state.contractId) return { ok: false, refused: false, code: null, reason: "Give the agent an allowance first" };
    const signer = new SmartAccountAgentSigner({
      smartAccount: this.state.contractId,
      agentSecret: this.state.agentSecret,
      contextRuleId: g.ruleId,
      networkPassphrase: TESTNET.networkPassphrase,
    });
    try {
      const tx = await smartAccountTransfer({ signer, source: this.agent, to, amount, token: XLM });
      return { ok: true, tx };
    } catch (e) {
      let refused = false;
      let code: number | null = null;
      for (let c: any = e; c; c = c.cause) {
        if (c instanceof PaymentRejectedError) refused = true;
        code = code ?? contractErrorCode(c);
      }
      return { ok: false, refused, code, reason: describeSimulationError(e) };
    }
  }

  /** The user's request, signed by the key on their device. */
  signRequest(task: string, fields: Record<string, string>): SignedRequest {
    if (!this.state.contractId) throw new Error("Create the wallet first");
    return signRequest(this.device, {
      account: this.state.contractId,
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      issuedAt: Math.floor(Date.now() / 1000),
      ttlSeconds: 900,
      task,
      fields,
    });
  }

  private service(): ProvenanceCosigner {
    const g = this.state.grant;
    if (!g?.gated || !g.catalog || !this.state.contractId) throw new Error("This allowance has no provenance gate");
    return (this.cosignerService ??= new ProvenanceCosigner({
      secret: this.state.cosignerSecret!,
      account: this.state.contractId,
      token: XLM,
      ruleId: g.ruleId,
      networkPassphrase: TESTNET.networkPassphrase,
      verifier: OZ_SMART_ACCOUNT.ed25519Verifier,
      deviceKeys: [this.device.publicKey()],
      catalog: g.catalog,
    }));
  }

  /**
   * The autonomous agent pays under a gated rule: the provenance co-signer
   * reviews the exact authorization first and signs only if the recipient,
   * amount and decision trace to the user's request and the pinned price book.
   */
  async gatedPay(c: GatedCase, to: string, amount: bigint): Promise<Outcome> {
    const g = this.state.grant;
    if (!g || !this.state.contractId) return { ok: false, refused: false, code: null, reason: "Give the agent an allowance first" };
    const signer = new SmartAccountAgentSigner({
      smartAccount: this.state.contractId,
      agentSecret: this.state.agentSecret,
      contextRuleId: g.ruleId,
      networkPassphrase: TESTNET.networkPassphrase,
    });
    const service = this.service();
    let seen: { authEntry: string; cosignature: string } | undefined;
    try {
      const tx = await gatedSmartAccountTransfer({
        signer,
        source: this.agent,
        to,
        amount,
        token: XLM,
        cosign: async (authEntry) => {
          const d = service.review({ ...c, authEntry });
          if (d.verdict === "cosign") {
            seen = { authEntry, cosignature: d.signature.signature.toString("hex") };
            return { ok: true, signature: d.signature };
          }
          return { ok: false, verdict: d.verdict, why: d.verdict === "escalate" ? d.why : [d.reason] };
        },
      });
      return { ok: true, tx, ...seen };
    } catch (e) {
      if (e instanceof ProvenanceEscalation) return { ok: false, refused: false, code: null, reason: e.message, why: e.why, verdict: e.verdict };
      let refused = false;
      let code: number | null = null;
      for (let c: any = e; c; c = c.cause) {
        if (c instanceof PaymentRejectedError) refused = true;
        code = code ?? contractErrorCode(c);
      }
      return { ok: false, refused, code, reason: describeSimulationError(e) };
    }
  }

  /**
   * The guardian approves one refused payment: their passkey signs this single
   * transfer under their own rule (#0), so the agent's allowance is untouched.
   */
  async approveOnce(to: string, amount: bigint): Promise<Outcome> {
    await this.connect();
    const r = await this.kit.transfer(XLM, to, Number(amount) / 1e7, { resolveContextRuleIds: () => [0] });
    return r.success
      ? { ok: true, tx: r.hash }
      : { ok: false, refused: false, code: contractErrorCode(r.error), reason: r.error?.message ?? "Approval failed" };
  }

  /** Step 4: the guardian's passkey deletes the agent's rule. */
  async revoke(): Promise<void> {
    const g = this.state.grant;
    if (!g) return;
    await this.connect();
    const tx = await this.kit.rules.remove(g.ruleId);
    const r = await this.kit.signAndSubmitAdmin(tx);
    if (!r.success) throw new Error(r.error?.message ?? "Revoke failed");
    this.state.grant = { ...g, revoked: true };
    save(this.state);
  }

  /** After a revoke: forget the old rule so a new allowance can be granted on the same wallet. */
  clearGrant(): void {
    this.state.grant = undefined;
    this.cosignerService = undefined;
    save(this.state);
  }

  /** Is the agent's rule still on the account? */
  async ruleExists(): Promise<boolean> {
    const g = this.state.grant;
    if (!g || !this.state.contractId) return false;
    try {
      await read(this.state.contractId, "get_context_rule", [u32(g.ruleId)]);
      return true;
    } catch {
      return false;
    }
  }

  /** Forget this sandbox (keys and wallet link) to start over. */
  static reset(): void {
    try {
      localStorage.removeItem(STORE);
    } catch {
      /* ignore */
    }
  }
}
