import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";

/**
 * ACAN tab vouchers.
 *
 * Under the "acan-tab" x402 scheme an agent does not move money on every
 * request. It signs a voucher acknowledging a debt to the merchant, and pays
 * the accumulated tab later in ONE confidential transfer whose amount is
 * hidden on-chain.
 *
 * Vouchers are chained: nonce n+1 must follow nonce n, and `cumulative` is
 * the total owed so far. A merchant therefore always holds a single signed
 * statement of the full debt (the latest voucher), and a replayed or
 * reordered voucher is rejected.
 */
export const TAB_SCHEME = "acan-tab";
export const VOUCHER_DOMAIN = "acan-tab-voucher-v1";

export interface TabVoucher {
  v: 1;
  /** CAIP-2 network, e.g. "stellar:testnet". */
  network: string;
  /** Confidential token contract the tab is settled in. */
  token: string;
  /** Agent's vault (G...) that signs vouchers and sends settlements. */
  payer: string;
  /** Merchant (G...) that receives settlements. */
  payee: string;
  /** 1, 2, 3, ... per payer/payee tab. */
  nonce: number;
  /** Price of this request, atomic units (decimal string). */
  amount: string;
  /** Total owed after this request, atomic units (decimal string). */
  cumulative: string;
  /** Resource URL this voucher pays for. */
  resource: string;
  /** Unix seconds. */
  issuedAt: number;
}

/** Canonical JSON: keys sorted, no whitespace. Vouchers hold only flat scalars. */
export function canonicalVoucher(v: TabVoucher): string {
  const keys = Object.keys(v).sort() as (keyof TabVoucher)[];
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(v[k])}`).join(",") + "}";
}

/** sha256(domain || "\n" || canonical JSON) */
export function voucherDigest(v: TabVoucher): Buffer {
  return hash(Buffer.from(`${VOUCHER_DOMAIN}\n${canonicalVoucher(v)}`, "utf8"));
}

export function signVoucher(v: TabVoucher, payer: Keypair): string {
  if (payer.publicKey() !== v.payer) throw new Error("Voucher payer does not match the signing key");
  return payer.sign(voucherDigest(v)).toString("base64");
}

export function verifyVoucherSignature(v: TabVoucher, signatureB64: string): boolean {
  if (!StrKey.isValidEd25519PublicKey(v.payer)) return false;
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  try {
    return Keypair.fromPublicKey(v.payer).verify(voucherDigest(v), sig);
  } catch {
    return false;
  }
}

const UINT = /^\d+$/;

/** Structural validation of an untrusted voucher. Returns an error string or null. */
export function voucherShapeError(v: unknown): string | null {
  if (!v || typeof v !== "object") return "voucher missing";
  const o = v as Record<string, unknown>;
  const expected = ["v", "network", "token", "payer", "payee", "nonce", "amount", "cumulative", "resource", "issuedAt"];
  const keys = Object.keys(o);
  if (keys.length !== expected.length || !expected.every((k) => k in o)) return "voucher has unexpected fields";
  if (o.v !== 1) return "unsupported voucher version";
  for (const k of ["network", "token", "payer", "payee", "resource"]) {
    if (typeof o[k] !== "string" || !(o[k] as string)) return `voucher.${k} must be a non-empty string`;
  }
  if (!StrKey.isValidEd25519PublicKey(o.payer as string)) return "voucher.payer must be a G... address";
  if (!StrKey.isValidEd25519PublicKey(o.payee as string)) return "voucher.payee must be a G... address";
  if (!StrKey.isValidContract(o.token as string)) return "voucher.token must be a C... address";
  if (!Number.isSafeInteger(o.nonce) || (o.nonce as number) < 1) return "voucher.nonce must be a positive integer";
  if (!Number.isSafeInteger(o.issuedAt) || (o.issuedAt as number) < 0) return "voucher.issuedAt must be unix seconds";
  for (const k of ["amount", "cumulative"]) {
    if (typeof o[k] !== "string" || !UINT.test(o[k] as string)) return `voucher.${k} must be an integer string`;
  }
  if (BigInt(o.amount as string) <= 0n) return "voucher.amount must be positive";
  return null;
}

/** Wire payload carried in the x402 PAYMENT-SIGNATURE header. */
export interface TabPayload {
  voucher: TabVoucher;
  /** base64 Ed25519 signature by `voucher.payer` over {@link voucherDigest}. */
  signature: string;
  /** Hash of a confidential transfer payer → payee settling earlier debt. */
  settlementTx?: string;
}

/** `extra` advertised in the payment requirements of an acan-tab route. */
export interface TabRequirementsExtra {
  /** Max unsettled debt (atomic units) the merchant extends to one payer. */
  creditLimit: string;
  /** Public token the confidential token wraps (USDC SAC). */
  underlying: string;
  /** Where the agent can read its tab (GET <tabUrl>/<payer>). */
  tabUrl?: string;
}
