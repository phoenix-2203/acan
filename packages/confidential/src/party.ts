import {
  ChainClient,
  CircuitProver,
  JsonFileStore,
  StateEngine,
  addressToField,
  buildRegisterWitness,
  buildTransferWitness,
  buildWithdrawWitness,
  deriveKeys,
  keypairSigner,
  loadCircuit,
  submitDeposit,
  submitMerge,
  submitRegister,
  submitTransfer,
  submitWithdraw,
  type KeyPair,
  type Signer,
} from "./vendor.js";
import { CONFIDENTIAL_TESTNET } from "./deployment.js";

type CircuitName = "register" | "withdraw" | "transfer";

export interface ConfidentialAccountOptions {
  /** Classic Stellar secret (S...) of the account that owns the confidential balance. */
  secret: string;
  /** Confidential spending secret (hex scalar). Generated once by `npm run ct:setup`. */
  ctSecretHex: string;
  /** JSON file caching the decrypted balance openings (needed to spend). */
  statePath: string;
  deployment?: typeof CONFIDENTIAL_TESTNET;
}

/**
 * One account's view of the confidential token: its keys, its locally
 * reconstructed balance, and the operations it can sign.
 *
 * Balances on-chain are Pedersen commitments. The plaintext lives only in the
 * owner's local state, rebuilt from encrypted contract events.
 */
export class ConfidentialAccount {
  readonly client: ChainClient;
  readonly keys: KeyPair;
  readonly address: string;
  readonly engine: StateEngine;
  private readonly signer: Signer;
  private readonly provers = new Map<CircuitName, CircuitProver>();
  private readonly dep: typeof CONFIDENTIAL_TESTNET;

  constructor(opts: ConfidentialAccountOptions) {
    this.dep = opts.deployment ?? CONFIDENTIAL_TESTNET;
    this.client = new ChainClient({
      rpcUrl: this.dep.rpcUrl,
      networkPassphrase: this.dep.networkPassphrase,
      contracts: {
        token: this.dep.contracts.token,
        verifier: this.dep.contracts.verifier,
        auditor: this.dep.contracts.auditor,
      },
    });
    this.signer = keypairSigner(opts.secret, this.dep.networkPassphrase);
    this.address = this.signer.publicKey;
    this.keys = deriveKeys(parseScalar(opts.ctSecretHex), addressToField(this.dep.contracts.token));
    this.engine = new StateEngine({
      client: this.client,
      store: new JsonFileStore(opts.statePath),
      keys: this.keys,
      address: this.address,
      fromLedger: this.dep.deployedAtLedger,
    });
  }

  private prover(name: CircuitName): CircuitProver {
    let p = this.provers.get(name);
    if (!p) {
      p = new CircuitProver(loadCircuit(name));
      this.provers.set(name, p);
    }
    return p;
  }

  /** Release the proving backends (bb.js workers). */
  async close(): Promise<void> {
    await Promise.all([...this.provers.values()].map((p) => p.destroy()));
    this.provers.clear();
  }

  async isRegistered(): Promise<boolean> {
    return this.client.isRegistered(this.address);
  }

  /** Register the confidential account (one zero-knowledge proof). Idempotent. */
  async register(): Promise<string | null> {
    if (await this.isRegistered()) return null;
    const w = buildRegisterWitness(this.keys);
    const { proof } = await this.prover("register").prove(w.inputs);
    const r = await submitRegister(this.client, this.signer, this.address, this.dep.auditorId, w, proof);
    return r.hash;
  }

  /** Sync from chain and return plaintext balances (atomic units). */
  async balances(): Promise<{ spendable: bigint; receiving: bigint }> {
    const s = await this.engine.sync();
    return { spendable: s.spendable.v, receiving: s.receiving.v };
  }

  /** Public → confidential: pull `amount` of the underlying token from this account. */
  async deposit(amount: bigint): Promise<string> {
    const r = await submitDeposit(this.client, this.signer, this.address, this.address, amount);
    return r.hash;
  }

  /** Fold the receiving balance into the spendable balance (no proof). */
  async merge(): Promise<string> {
    const r = await submitMerge(this.client, this.signer, this.address);
    return r.hash;
  }

  /**
   * Sync until the spendable balance reaches `min` (events can lag a ledger
   * behind the transaction that produced them).
   */
  async waitForSpendable(min: bigint, timeoutMs = 30_000): Promise<bigint> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const { spendable } = await this.balances();
      if (spendable >= min || Date.now() > end) return spendable;
      await sleep(2_500);
    }
  }

  /**
   * Confidential transfer: the amount is hidden on-chain. Only the recipient
   * (with its viewing key) and the auditor can decrypt it.
   */
  async transfer(to: string, amount: bigint): Promise<string> {
    const recipient = await this.client.confidentialBalance(to);
    if (!recipient) throw new Error(`${to} has no confidential account (it must register first)`);
    const me = await this.client.confidentialBalance(this.address);
    if (!me) throw new Error("this account is not registered");
    const s = await this.engine.sync();
    const ok = await this.engine.verifyAgainstChain();
    if (!ok.spendableOk) throw new Error("local confidential state does not match the chain; refusing to spend");
    if (s.spendable.v < amount) throw new Error(`spendable ${s.spendable.v} < ${amount}`);
    const [kAudR, kAudS] = await Promise.all([
      this.client.auditorKey(recipient.auditorId),
      this.client.auditorKey(me.auditorId),
    ]);
    const w = buildTransferWitness({
      keys: this.keys,
      v: s.spendable.v,
      r: s.spendable.r,
      amount,
      pvkB: recipient.viewingPublicKey,
      kAudR,
      kAudS,
    });
    const { proof } = await this.prover("transfer").prove(w.inputs);
    const r = await submitTransfer(this.client, this.signer, this.address, to, w, proof);
    await this.engine.setSpendable({ v: w.next.v, r: w.next.r });
    return r.hash;
  }

  /** Confidential → public: withdraw `amount` of the underlying token to `to`. */
  async withdraw(amount: bigint, to = this.address): Promise<string> {
    const s = await this.engine.sync();
    const ok = await this.engine.verifyAgainstChain();
    if (!ok.spendableOk) throw new Error("local confidential state does not match the chain; refusing to spend");
    if (s.spendable.v < amount) throw new Error(`spendable ${s.spendable.v} < ${amount}`);
    const me = await this.client.confidentialBalance(this.address);
    const kAudS = await this.client.auditorKey(me!.auditorId);
    const w = buildWithdrawWitness({ keys: this.keys, v: s.spendable.v, r: s.spendable.r, amount, kAudS });
    const { proof } = await this.prover("withdraw").prove(w.inputs);
    const r = await submitWithdraw(this.client, this.signer, this.address, to, amount, w, proof);
    return r.hash;
  }
}

export function parseScalar(hex: string): bigint {
  const h = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(h)) throw new Error("confidential secret must be hex");
  return BigInt(h);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
