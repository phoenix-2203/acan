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
}

/**
 * Encode `MerchantPolicyParams { recipients: Vec<Recipient { address, cap }>,
 * period_ledgers, max_payments }` exactly as the Soroban contract expects:
 * structs are ScMaps with symbol keys in sorted order.
 */
export function encodeMerchantPolicyParams(p: MerchantPolicySettings): xdr.ScVal {
  if (p.recipients.length === 0) throw new Error("Pick at least one allowed recipient");
  if (!Number.isInteger(p.periodLedgers) || p.periodLedgers <= 0) throw new Error("Period must be positive");
  if (!Number.isInteger(p.maxPayments) || p.maxPayments < 0) throw new Error("Max payments must be 0 or more");
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
