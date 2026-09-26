/** Account authentication only: this proof never decrypts vault content. */
import { hex, hkdf, sha256, unhex, utf8 } from "./crypto";
import { ApiError } from "./transport";

export const FORGOTTEN_DEVICE = "This server no longer recognises this device. Your local notes and vault key are safe. In obsync settings, pair from a syncing device, or use Setup or recover with this server's setup token and this vault's recovery phrase.";

export function forgottenCredential(error: unknown): error is ApiError {
  return error instanceof ApiError &&
    ((error.status === 401 && error.code === "bad_signature") || (error.status === 403 && error.code === "device_revoked"));
}

/** RFC 5869 domain separation; the server stores only SHA-256(proof). */
export async function accountRecovery(vrk: string): Promise<{ proof: string; verifier: string }> {
  const proof = await hkdf(unhex(vrk), utf8("obsync/v1/account-recovery"), new Uint8Array(0), 32);
  return { proof: hex(proof), verifier: hex(await sha256(proof)) };
}
