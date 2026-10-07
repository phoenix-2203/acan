import { Keypair } from "@stellar/stellar-sdk";
import {
  ASSETS,
  SmartAccountAgentSigner,
  smartAccountTransfer,
  type TabSettler,
} from "@acan/core";
import type { ConfidentialAccount } from "./party.js";

export type VaultEvent =
  | { kind: "topup-start"; amount: bigint }
  | { kind: "topup-pulled"; amount: bigint; tx: string }
  | { kind: "topup-deposited"; amount: bigint; tx: string }
  | { kind: "topup-merged"; tx: string; spendable: bigint }
  | { kind: "transfer"; to: string; tx: string };

/**
 * The agent's confidential vault: a classic account the agent controls, whose
 * confidential balance pays merchant tabs.
 *
 * The vault can only be filled from the guardian's smart account through the
 * agent's capped context rule, so the on-chain spending limit still bounds
 * everything the agent can ever spend. Top-ups are public and use a fixed
 * chunk size, so they reveal how much flowed into the vault but not how it was
 * split between merchants; settlements out of the vault are confidential.
 */
export class ConfidentialVault implements TabSettler {
  constructor(
    private readonly account: ConfidentialAccount,
    private readonly opts: {
      vaultKeypair: Keypair;
      signer: SmartAccountAgentSigner;
      /** Top-up granularity, atomic units (e.g. 0.10 USDC = 1_000_000n). */
      chunk: bigint;
      onEvent?: (e: VaultEvent) => void;
    },
  ) {
    if (opts.vaultKeypair.publicKey() !== account.address) {
      throw new Error("vault keypair does not match the confidential account");
    }
    if (opts.chunk <= 0n) throw new Error("chunk must be positive");
  }

  /** Make sure at least `amount` is spendable, pulling whole chunks from the smart account. */
  async ensureSpendable(amount: bigint): Promise<bigint> {
    let { spendable, receiving } = await this.account.balances();
    if (spendable >= amount) return spendable;
    const missing = amount - spendable - receiving;
    if (missing > 0n) {
      const topUp = ((missing + this.opts.chunk - 1n) / this.opts.chunk) * this.opts.chunk;
      this.emit({ kind: "topup-start", amount: topUp });
      // Policy-capped: the smart account refuses if the allowance is used up.
      const pulled = await smartAccountTransfer({
        signer: this.opts.signer,
        source: this.opts.vaultKeypair,
        to: this.account.address,
        amount: topUp,
        token: ASSETS.usdc.sac,
      });
      this.emit({ kind: "topup-pulled", amount: topUp, tx: pulled });
      const dep = await this.account.deposit(topUp);
      this.emit({ kind: "topup-deposited", amount: topUp, tx: dep });
    }
    const merged = await this.account.merge();
    spendable = await this.account.waitForSpendable(amount);
    this.emit({ kind: "topup-merged", tx: merged, spendable });
    if (spendable < amount) throw new Error(`vault spendable ${spendable} still below ${amount} after top-up`);
    return spendable;
  }

  async settle(payee: string, amount: bigint): Promise<string> {
    await this.ensureSpendable(amount);
    const tx = await this.account.transfer(payee, amount);
    this.emit({ kind: "transfer", to: payee, tx });
    return tx;
  }

  private emit(e: VaultEvent): void {
    this.opts.onEvent?.(e);
  }
}
