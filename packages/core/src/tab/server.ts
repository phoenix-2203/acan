import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { TAB_SCHEME, type TabRequirementsExtra } from "./voucher.js";

export interface TabServerOptions {
  /** Confidential token contract (C...) the tab is settled in. */
  confidentialToken: string;
  /** Public token it wraps (USDC SAC). */
  underlying: string;
  /** Decimals of the confidential token (same as the underlying: 7). */
  decimals: number;
  /** Max unsettled debt per payer, atomic units. */
  creditLimit: bigint;
  /** Public URL prefix where a payer can read its tab. */
  tabUrl?: string;
}

/**
 * Resource-server side of the "acan-tab" scheme: turns a route price into
 * payment requirements denominated in the confidential token, with the
 * merchant's credit terms in `extra`.
 */
export class TabServerScheme implements SchemeNetworkServer {
  readonly scheme = TAB_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  // Verify before serving, record the voucher after a successful response.
  readonly paymentFlows = {
    default: { supported: ["authorization"] as const, default: "authorization" as const },
  };

  constructor(private readonly opts: TabServerOptions) {}

  getAssetDecimals(asset: string): number | undefined {
    return asset === this.opts.confidentialToken ? this.opts.decimals : undefined;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (price.asset && price.asset !== this.opts.confidentialToken) {
        throw new Error(`acan-tab on ${network} only prices in ${this.opts.confidentialToken}`);
      }
      return { amount: price.amount, asset: this.opts.confidentialToken, extra: price.extra ?? {} };
    }
    const { amount } = parseMoney(price);
    return {
      amount: convertToTokenAmount(amount, this.opts.decimals),
      asset: this.opts.confidentialToken,
      extra: {},
    };
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _extensions: string[],
  ): Promise<PaymentRequirements> {
    const extra: TabRequirementsExtra = {
      creditLimit: this.opts.creditLimit.toString(),
      underlying: this.opts.underlying,
      ...(this.opts.tabUrl ? { tabUrl: this.opts.tabUrl } : {}),
    };
    return { ...requirements, extra: { ...requirements.extra, ...extra } };
  }
}
