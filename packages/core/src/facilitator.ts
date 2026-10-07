import { Address, xdr } from "@stellar/stellar-sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { OZ_SMART_ACCOUNT } from "./config.js";

type Base = InstanceType<typeof ExactStellarScheme>;
type VerifyInvalid = { isValid: false; invalidReason: string; payer?: string };

/**
 * x402 "exact" Stellar facilitator that accepts payments from OpenZeppelin
 * smart accounts.
 *
 * The stock @x402/stellar facilitator rejects a payment if the simulation
 * emits *any* contract event other than the token transfer. A smart-account
 * payment legitimately emits extra events from its own authorization path:
 * the stateful spending-limit policy records every spend. Those events do not
 * move funds.
 *
 * This subclass keeps every other check of the stock facilitator unchanged
 * and only relaxes that one rule, narrowly: events are ignored only when they
 * come from the payer's own account or from the known OpenZeppelin verifier
 * and policy contracts. Every event from any other contract is still
 * validated by the stock logic, which still requires exactly one SEP-41
 * transfer of the exact amount, from the payer, to the payee, on the asset.
 */
export class SmartAccountAwareFacilitator extends ExactStellarScheme {
  constructor(
    signers: ConstructorParameters<typeof ExactStellarScheme>[0],
    options: ConstructorParameters<typeof ExactStellarScheme>[1] = {},
    private readonly authContracts: string[] = [
      OZ_SMART_ACCOUNT.ed25519Verifier,
      OZ_SMART_ACCOUNT.webauthnVerifier,
      OZ_SMART_ACCOUNT.spendingLimitPolicy,
      OZ_SMART_ACCOUNT.thresholdPolicy,
    ],
  ) {
    super(signers, options);
    const self = this as unknown as {
      validateSimulationEvents: (
        events: xdr.DiagnosticEvent[],
        from: string,
        to: string,
        amount: bigint,
        asset: string,
      ) => VerifyInvalid | undefined;
    };
    const stock = self.validateSimulationEvents.bind(this);
    self.validateSimulationEvents = (events, from, to, amount, asset) => {
      const allowed = new Set([from, ...this.authContracts]);
      const kept = (events ?? []).filter((d) => {
        const ev = d.event();
        if (ev.type().name !== "contract") return true;
        const id = ev.contractId();
        if (!id) return true;
        const emitter = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(id as any)).toString();
        // Never ignore events from the asset itself.
        return emitter === asset || !allowed.has(emitter);
      });
      return stock(kept, from, to, amount, asset);
    };
  }
}

export type { Base as StockStellarFacilitator };
