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
