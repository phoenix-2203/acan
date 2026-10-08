import { Address, StrKey, xdr } from "@stellar/stellar-sdk";

/** One allowed recipient; `cap` is the most it may receive per period (atomic units), 0n = no cap. */
export interface RecipientCap {
  address: string;
  cap: bigint;
}

export interface MerchantPolicySettings {
  recipients: RecipientCap[];
  periodLedgers: number;
  /** Payments allowed per period; 0 = no limit. */
  maxPayments: number;
  /** Largest single payment (atomic units); 0n = no limit. Policy v0.3 and later. */
  maxPerPayment?: bigint;
  /** Contract version the parameters are for (v0.2 has no per-payment limit). Default "0.3". */
  version?: "0.2" | "0.3";
}

/**
 * Encode `MerchantPolicyParams { recipients: Vec<Recipient { address, cap }>,
 * period_ledgers, max_payments, max_per_payment }` exactly as the Soroban
 * contract expects: structs are ScMaps with symbol keys in sorted order.
 * v0.2 contracts have no `max_per_payment` field.
 */
export function encodeMerchantPolicyParams(p: MerchantPolicySettings): xdr.ScVal {
  if (p.recipients.length === 0) throw new Error("Pick at least one allowed recipient");
  if (!Number.isInteger(p.periodLedgers) || p.periodLedgers <= 0) throw new Error("Period must be positive");
  if (!Number.isInteger(p.maxPayments) || p.maxPayments < 0) throw new Error("Max payments must be 0 or more");
  const version = p.version ?? "0.3";
  const maxPerPayment = p.maxPerPayment ?? 0n;
  if (maxPerPayment < 0n) throw new Error("The per-payment limit cannot be negative");
  if (version === "0.2" && maxPerPayment > 0n) throw new Error("This policy contract (v0.2) has no per-payment limit; redeploy v0.3");
  const seen = new Set<string>();
  const recipients = p.recipients.map((r) => {
    if (!StrKey.isValidEd25519PublicKey(r.address) && !StrKey.isValidContract(r.address)) {
      throw new Error(`Invalid recipient ${r.address}`);
    }
    if (seen.has(r.address)) throw new Error(`Duplicate recipient ${r.address}`);
    seen.add(r.address);
    if (r.cap < 0n) throw new Error("Caps cannot be negative");
    return xdr.ScVal.scvMap([
      entry("address", xdr.ScVal.scvAddress(Address.fromString(r.address).toScAddress())),
      entry("cap", i128(r.cap)),
    ]);
  });
  return xdr.ScVal.scvMap([
    entry("max_payments", xdr.ScVal.scvU32(p.maxPayments)),
    ...(version === "0.2" ? [] : [entry("max_per_payment", i128(maxPerPayment))]),
    entry("period_ledgers", xdr.ScVal.scvU32(p.periodLedgers)),
    entry("recipients", xdr.ScVal.scvVec(recipients)),
  ]);
}

function entry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function i128(v: bigint): xdr.ScVal {
  const lo = v & 0xffffffffffffffffn;
  const hi = v >> 64n;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }),
  );
}
