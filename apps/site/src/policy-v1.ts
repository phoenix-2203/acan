import { Address, xdr } from "@stellar/stellar-sdk";

/**
 * Install parameters of ACAN's merchant allowlist policy v0.1:
 * `AllowlistParams { recipients: Vec<Address> }` (an ScMap with one symbol key).
 * v0.2 (per-recipient caps, payment count) uses encodeMerchantPolicyParams.
 */
export function encodeAllowlistV1(recipients: string[]): xdr.ScVal {
  if (recipients.length === 0) throw new Error("Pick at least one allowed shop");
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("recipients"),
      val: xdr.ScVal.scvVec(recipients.map((a) => xdr.ScVal.scvAddress(Address.fromString(a).toScAddress()))),
    }),
  ]);
}
