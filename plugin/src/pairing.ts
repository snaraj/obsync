/**
 * Device pairing and vault-key custody, `docs/architecture.md` 4.
 *
 * Obsidian sign-in does not authorize this server. Each device pairs once,
 * then sync runs automatically. Two roles live here:
 *
 * - CREATOR (an already-paired device): mints a pairing through the server,
 *   generates the 16-byte pairing secret `PS` LOCALLY, shows the code, polls
 *   for a claimant, asks the user to approve it by name and platform, and
 *   posts `{VRK}` sealed under `K_pair = HKDF(PS, "obsync/v1/pair",
 *   pairing_id)`. The vault key is the whole envelope: which paths live in
 *   which domain is read from the synced map (`domainmap.ts`), which `VRK`
 *   is exactly what unlocks.
 * - CLAIMANT (the new device): reads the code, claims the pairing with the
 *   enroll token to get its device credential, fetches the sealed envelope
 *   once, and opens it with `PS`.
 *
 * `PS` never reaches the server, so the server — and the TLS terminator in
 * front of it — sees only ciphertext of the vault key. The code itself is
 * the whole secret: it is shown as text, as a copy button and as an
 * `obsidian://obsync-private-sync/pair?code=…` link, and it expires in ten minutes.
 *
 * FIRST DEVICE. `newVault()` generates the 32-byte `VRK` on the device and
 * `recoveryPhrase()` renders it as 24 BIP-0039 words with the standard 8-bit
 * SHA-256 checksum. Without a paired device and without that phrase a vault
 * is unrecoverable, by design (`docs/threat-model.md`).
 *
 * PLATFORM. Identical everywhere. The `obsidian://` link is what makes
 * pairing bearable on iOS and Android, where typing 104 characters is not.
 */

import {
  Bytes,
  base32,
  base64,
  concat,
  hex,
  pairingKey,
  randomBytes,
  sha256,
  unbase32,
  unbase64,
  unhex,
  utf8,
} from "./crypto";
import { WORDLIST } from "./wordlist";

export const PAIRING_ID_BYTES = 16;
export const ENROLL_TOKEN_BYTES = 32;
export const PAIRING_SECRET_BYTES = 16;
export const VRK_BYTES = 32;
export const PHRASE_WORDS = 24;
/** The directory identity also owns the pairing URI action. */
export const PAIRING_ACTION = "obsync-private-sync";

export interface PairingCode {
  pairingId: string;
  enrollToken: string;
  pairingSecret: Bytes;
}

/** What a paired device seals for a new one. */
export interface VaultEnvelope {
  vrk: string;
}

/**
 * The pairing code: `base32(pairing_id || enroll_token || PS)`, RFC 4648
 * uppercase and unpadded, 64 bytes in and 103 characters out. Whitespace and
 * dashes are ignored on the way back in, so a user may break it up.
 */
export function encodePairingCode(pairingId: string, enrollToken: string, pairingSecret: Bytes): string {
  return base32(concat(unhex(pairingId), unhex(enrollToken), pairingSecret));
}

export function decodePairingCode(code: string): PairingCode {
  const raw = unbase32(code.trim());
  const expected = PAIRING_ID_BYTES + ENROLL_TOKEN_BYTES + PAIRING_SECRET_BYTES;
  if (raw.length < expected) throw new Error("pairing: the code is too short");
  return {
    pairingId: hex(raw.subarray(0, PAIRING_ID_BYTES) as Bytes),
    enrollToken: hex(raw.subarray(PAIRING_ID_BYTES, PAIRING_ID_BYTES + ENROLL_TOKEN_BYTES) as Bytes),
    pairingSecret: raw.subarray(PAIRING_ID_BYTES + ENROLL_TOKEN_BYTES, expected) as Bytes,
  };
}

export function pairingLink(code: string): string {
  return `obsidian://${PAIRING_ACTION}/pair?code=${encodeURIComponent(code)}`;
}

export function newPairingSecret(): Bytes {
  return randomBytes(PAIRING_SECRET_BYTES);
}

export function newVaultKey(): Bytes {
  return randomBytes(VRK_BYTES);
}

async function envelopeKey(pairingSecret: Bytes, pairingId: string): Promise<CryptoKey> {
  const key = await pairingKey(pairingSecret, pairingId);
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Seal `{VRK}` for the claimant. The AAD is the pairing id, so an
 * envelope cannot be replayed into a different pairing even if the same `PS`
 * were somehow reused.
 */
export async function sealEnvelope(
  pairingSecret: Bytes,
  pairingId: string,
  envelope: VaultEnvelope,
): Promise<{ envelope: string; nonce: string }> {
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8(pairingId), tagLength: 128 },
      await envelopeKey(pairingSecret, pairingId),
      utf8(JSON.stringify(envelope)),
    ),
  );
  return { envelope: base64(ciphertext), nonce: hex(nonce) };
}

export async function openEnvelope(
  pairingSecret: Bytes,
  pairingId: string,
  envelope: string,
  nonce: string,
): Promise<VaultEnvelope> {
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(nonce), additionalData: utf8(pairingId), tagLength: 128 },
      await envelopeKey(pairingSecret, pairingId),
      unbase64(envelope),
    ),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as VaultEnvelope;
  if (typeof parsed.vrk !== "string" || parsed.vrk.length !== VRK_BYTES * 2) {
    throw new Error("pairing: the envelope carries no vault key");
  }
  return { vrk: parsed.vrk };
}

/**
 * BIP-0039 encoding of 32 bytes of entropy: 256 entropy bits plus the first
 * 8 bits of `SHA-256(entropy)` make 264 bits, read as 24 indices of 11 bits
 * into the 2048-word English list.
 */
export async function recoveryPhrase(entropy: Bytes): Promise<string[]> {
  if (entropy.length !== VRK_BYTES) throw new Error("recovery: entropy must be 32 bytes");
  const checksum = (await sha256(entropy))[0] as number;
  const bits: number[] = [];
  for (let i = 0; i < entropy.length; i++) {
    for (let bit = 7; bit >= 0; bit--) bits.push(((entropy[i] as number) >> bit) & 1);
  }
  for (let bit = 7; bit >= 0; bit--) bits.push((checksum >> bit) & 1);
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    let index = 0;
    for (let bit = 0; bit < 11; bit++) index = (index << 1) | (bits[i + bit] as number);
    words.push(WORDLIST[index] as string);
  }
  return words;
}

export function normalisePhrase(text: string): string[] {
  return text.toLowerCase().trim().split(/\s+/).filter((word) => word !== "");
}

/**
 * The inverse, with the checksum enforced: a mistyped or reordered phrase is
 * rejected rather than silently producing the wrong vault key.
 */
export async function entropyFromPhrase(words: string[]): Promise<Bytes> {
  if (words.length !== PHRASE_WORDS) {
    throw new Error(`recovery: expected ${PHRASE_WORDS} words, read ${words.length}`);
  }
  const bits: number[] = [];
  for (const word of words) {
    const index = WORDLIST.indexOf(word);
    if (index < 0) throw new Error(`recovery: "${word}" is not a recovery word`);
    for (let bit = 10; bit >= 0; bit--) bits.push((index >> bit) & 1);
  }
  const entropy = new Uint8Array(VRK_BYTES);
  for (let i = 0; i < VRK_BYTES; i++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | (bits[i * 8 + bit] as number);
    entropy[i] = byte;
  }
  let checksum = 0;
  for (let bit = 0; bit < 8; bit++) checksum = (checksum << 1) | (bits[VRK_BYTES * 8 + bit] as number);
  if (((await sha256(entropy))[0] as number) !== checksum) {
    throw new Error("recovery: the phrase fails its checksum — check the words and their order");
  }
  return entropy;
}
