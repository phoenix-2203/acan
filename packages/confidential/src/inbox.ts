import type { ReceivedSettlement, SettlementInbox } from "@acan/core";
import { fetchEvents, type TransferEvent } from "./vendor.js";
import type { ConfidentialAccount } from "./party.js";

/** Largest plausible amount (1e8 USDC in 7-decimal units); anything above is a failed decryption. */
const MAX_AMOUNT = 10n ** 15n;

/**
 * The merchant's view of incoming confidential transfers.
 *
 * Given a transaction hash, it finds the token's `transfer` event in that
 * transaction, checks it is addressed to the merchant, and decrypts the
 * amount with the merchant's viewing key. Nobody else watching the chain
 * learns the amount; the transfer's zero-knowledge proof, verified on-chain,
 * binds the ciphertext to the amount actually moved.
 */
export class MerchantInbox implements SettlementInbox {
  constructor(
    private readonly merchant: ConfidentialAccount,
    private readonly opts: { attempts?: number; delayMs?: number } = {},
  ) {}

  async lookup(txHash: string): Promise<ReceivedSettlement | null> {
    const attempts = this.opts.attempts ?? 8;
    const delayMs = this.opts.delayMs ?? 2_500;
    for (let i = 0; i < attempts; i++) {
      const found = await this.tryOnce(txHash);
      if (found !== "pending") return found;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  private async tryOnce(txHash: string): Promise<ReceivedSettlement | null | "pending"> {
    const client = this.merchant.client;
    const tx = await client.server.getTransaction(txHash);
    if (tx.status === "NOT_FOUND") return "pending";
    if (tx.status !== "SUCCESS") return null;
    const { events } = await fetchEvents(client, { startLedger: tx.ledger });
    const ev = events.find(
      (e): e is TransferEvent => e.type === "transfer" && e.txHash.toLowerCase() === txHash.toLowerCase(),
    );
    if (!ev) return "pending"; // event not indexed yet
    if (ev.to !== this.merchant.address) return null;
    const { vTx } = this.merchant.engine.decryptIncoming(ev.rE, ev.vTilde, ev.sigma);
    if (vTx <= 0n || vTx > MAX_AMOUNT) return null;
    return { tx: txHash.toLowerCase(), from: ev.from, to: ev.to, amount: vTx };
  }
}
