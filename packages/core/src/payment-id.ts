/**
 * Client side of exactly-once paid requests: tag each payment with an x402
 * `payment-identifier` (when the merchant declares the extension) and retry
 * the paid request with the SAME header if the response is lost. A merchant
 * running {@link PaymentIdempotency} replays the stored response instead of
 * charging twice or answering 402 for a payment that already went through.
 */
import {
  PAYMENT_IDENTIFIER,
  generatePaymentId,
  isPaymentIdentifierExtension,
} from "@x402/extensions/payment-identifier";

/**
 * Add a fresh payment identifier to `payload` if the 402 response declared
 * the extension. Returns the identifier, or null when the merchant does not
 * support it (the payload is then left unchanged).
 */
export function attachPaymentIdentifier(
  payload: { extensions?: Record<string, unknown> },
  required: { extensions?: Record<string, unknown> },
  id: string = generatePaymentId("acan_"),
): string | null {
  const declared = required.extensions?.[PAYMENT_IDENTIFIER];
  if (!isPaymentIdentifierExtension(declared)) return null;
  payload.extensions = {
    ...(payload.extensions ?? {}),
    [PAYMENT_IDENTIFIER]: { ...declared, info: { ...declared.info, id } },
  };
  return id;
}

export interface PaidFetchOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Wait before retry n (ms). Default 1000 × n. */
  backoffMs?: (attempt: number) => number;
  fetchImpl?: typeof fetch;
}

/**
 * Send a paid request, retrying with the identical payment header on a
 * network error, a 5xx, or a 409 "payment_in_progress". Safe only because
 * the header carries a payment identifier the merchant deduplicates on;
 * without one, a retry can at worst be refused (the payment is single-use
 * on-chain or in the voucher chain), never charged twice.
 */
export async function fetchPaid(
  url: string,
  headers: Record<string, string>,
  opts: PaidFetchOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const wait = opts.backoffMs ?? ((n: number) => 1000 * n);
  const f = opts.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let n = 1; n <= attempts; n++) {
    try {
      const r = await f(url, { headers });
      const retryable = r.status >= 500 || (r.status === 409 && (await isInProgress(r)));
      if (!retryable || n === attempts) return r;
    } catch (e) {
      lastError = e;
      if (n === attempts) throw e;
    }
    await new Promise((res) => setTimeout(res, wait(n)));
  }
  throw lastError ?? new Error("fetchPaid: no attempts made");
}

async function isInProgress(r: Response): Promise<boolean> {
  try {
    return (await r.clone().json())?.error === "payment_in_progress";
  } catch {
    return false;
  }
}
