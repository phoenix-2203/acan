import { Buffer } from "buffer";

export const CANCEL_DOMAIN = "acan-cosigner-cancel-v1";

/**
 * What the user's device key signs to cancel a request or sub-mandate at a
 * hosted co-signer (apps/cosigner/src/hosted.ts).
 */
export function cancelMessage(account: string, ruleId: number, id: string): Buffer {
  return Buffer.from(`${CANCEL_DOMAIN}:${account}:${ruleId}:${id}`, "utf8");
}
