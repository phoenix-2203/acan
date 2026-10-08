/**
 * Smart-account refusals, decoded. Browser-safe (no Node or x402 imports), so
 * the dashboard and the demo site explain refusals the same way the agent does.
 */
/** Raised when the smart account's own rules refuse a payment. */
export class PaymentRejectedError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PaymentRejectedError";
  }

  /** The contract error code behind the refusal, when there is one. */
  get code(): number | null {
    return contractErrorCode(this.cause ?? this.message);
  }
}

/**
 * Known OpenZeppelin smart-account contract error codes
 * (smart-account-kit CONTRACT_ERROR_REGISTRY: SmartAccount 3000-3016, SpendingLimit 3220-3227).
 */
export const KNOWN_CODES: Record<number, string> = {
  3000: "ContextRuleNotFound: the agent's allowance was revoked",
  3002: "UnvalidatedContext: no active allowance covers this payment (revoked or expired)",
  3003: "ExternalVerificationFailed: the agent's signature was not accepted",
  3016: "UnauthorizedSigner: this key is not authorized on the smart account",
  3223: "NotAllowed: the spending-limit policy only allows token transfers",
  3401: "RecipientNotAllowed: this recipient is not on the guardian's merchant allowlist",
  3400: "NotInstalled: the merchant budget policy is not installed for this rule",
  3402: "NotAllowed: the merchant budget policy only allows token transfers",
  3406: "RecipientCapExceeded: this merchant's own cap for the period is used up",
  3407: "TooManyPayments: the payment-count limit for the period is reached",
  3408: "PaymentTooLarge: this single payment is above the per-payment limit",
  3224: "HistoryCapacityExceeded: too many payments in this period for the spending-limit policy",
  3221: "SpendingLimitExceeded: the agent's allowance for this period is used up",
};

/** The contract error code in a simulation or submission error, if any. */
export function contractErrorCode(err: unknown): number | null {
  const text = err instanceof Error ? err.message : String(err);
  const m = text.match(/Error\(Contract, #(\d+)\)/);
  return m ? Number(m[1]) : null;
}

export function describeSimulationError(err: unknown): string {
  const code = contractErrorCode(err);
  if (code !== null) return KNOWN_CODES[code] ?? `Contract error #${code}`;
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0].slice(0, 300);
}

/** Plain-language account of why the smart account refused a payment. */
export interface Refusal {
  code: number | null;
  /** Short headline, e.g. "Recipient is not approved". */
  title: string;
  /** Which control refused it. */
  policy: string;
  /** One sentence for a person. */
  reason: string;
  /**
   * "medium": inside the guardian's intent but over a limit; a one-off passkey
   * approval is the normal next step. "high": an unlisted recipient, a revoked
   * or expired allowance, or a bad signature: approve only with care.
   */
  severity: "medium" | "high";
}

const REFUSALS: Record<number, Omit<Refusal, "code">> = {
  3000: { title: "Allowance revoked", policy: "Agent's rule", reason: "The guardian deleted this agent's rule, so its key authorizes nothing.", severity: "high" },
  3002: { title: "No active allowance", policy: "Agent's rule (expiry)", reason: "The agent's rule was revoked or has expired.", severity: "high" },
  3003: { title: "Signature not accepted", policy: "Smart account", reason: "The agent's signature did not verify.", severity: "high" },
  3016: { title: "Key not authorized", policy: "Smart account", reason: "This key is not a signer on the smart account.", severity: "high" },
  3221: { title: "Over the allowance", policy: "Spending limit", reason: "This payment would take the agent past its allowance for the period.", severity: "medium" },
  3223: { title: "Not a token transfer", policy: "Spending limit", reason: "The agent's rule only allows token transfers.", severity: "high" },
  3224: { title: "Too many payments", policy: "Spending limit", reason: "The spending-limit policy's history for this period is full.", severity: "medium" },
  3400: { title: "Merchant policy missing", policy: "Merchant budget policy", reason: "No merchant budget is installed for this rule.", severity: "high" },
  3401: { title: "Recipient is not approved", policy: "Merchant allowlist", reason: "This address is not on the guardian's list of allowed merchants.", severity: "high" },
  3402: { title: "Not a token transfer", policy: "Merchant budget policy", reason: "The agent's rule only allows token transfers.", severity: "high" },
  3406: { title: "Merchant cap reached", policy: "Per-merchant cap", reason: "This merchant's own share of the allowance is used up for the period.", severity: "medium" },
  3407: { title: "Payment count reached", policy: "Payments per period", reason: "The number of payments allowed in this period is used up.", severity: "medium" },
  3408: { title: "Payment too large", policy: "Per-payment limit", reason: "This single payment is above the largest amount the agent may pay on its own.", severity: "medium" },
};

/** Explain a refusal from its contract error code (or the raw error). */
export function explainRefusal(codeOrError: number | null | unknown): Refusal {
  const code = typeof codeOrError === "number" ? codeOrError : codeOrError === null ? null : contractErrorCode(codeOrError);
  const known = code !== null ? REFUSALS[code] : undefined;
  return known
    ? { code, ...known }
    : {
        code,
        title: "Payment refused",
        policy: "Smart account",
        reason: code !== null ? `The smart account refused it (contract error #${code}).` : "The smart account refused it.",
        severity: "high",
      };
}
