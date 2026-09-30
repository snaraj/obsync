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
  derivePairingV2Key,
  exportPairingPublicKey,
  generatePairingKeyPair,
  hex,
  hkdf,
  importPairingPublicKey,
  PAIRING_PUBLIC_KEY_BYTES,
  pairingKey,
  randomBytes,
  sha256,
  unbase32,
  unbase64,
  unbase64url,
  unhex,
  utf8,
} from "./crypto";
import { ApiError, EDGE_REQUIRED, certificateRefusal } from "./transport";
import { WORDLIST } from "./wordlist";

export const PAIRING_ID_BYTES = 16;
export const ENROLL_TOKEN_BYTES = 32;
export const PAIRING_SECRET_BYTES = 16;
export const VRK_BYTES = 32;
export const PHRASE_WORDS = 24;
/** The directory identity also owns the pairing URI action. */
export const PAIRING_ACTION = "obsync-private-sync";
/** A pairing is claimable for ten minutes from its creation, the server's own window. */
export const PAIRING_WINDOW_MS = 10 * 60 * 1000;

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

/** Quotes and brackets a copy picked up around what was meant (issue #154). */
function unwrap(text: string): string {
  return text.trim().replace(/^["'`<‘’“”]+|["'`>‘’“”]+$/g, "").trim();
}

/**
 * Read a pasted code, or the link Copy link makes, whose query carries the
 * code (issue #154). Refusals say what to paste, never what failed to decode.
 */
export function decodePairingCode(code: string): PairingCode {
  const linked = /[?&]code=([^&#\s]+)/.exec(code)?.[1];
  let raw: Bytes;
  try {
    raw = unbase32(unwrap(linked ?? code));
  } catch {
    throw new Error("That is not a pairing code. Paste the code, or the link, exactly as your other device shows it under Pair a new device.");
  }
  const expected = PAIRING_ID_BYTES + ENROLL_TOKEN_BYTES + PAIRING_SECRET_BYTES;
  if (raw.length < expected) {
    throw new Error("That pairing code is incomplete. Copy all of it again from your other device, or use its Copy link.");
  }
  return {
    pairingId: hex(raw.subarray(0, PAIRING_ID_BYTES)),
    enrollToken: hex(raw.subarray(PAIRING_ID_BYTES, PAIRING_ID_BYTES + ENROLL_TOKEN_BYTES)),
    pairingSecret: raw.subarray(PAIRING_ID_BYTES + ENROLL_TOKEN_BYTES, expected),
  };
}

export function pairingLink(code: string): string {
  return `obsidian://${PAIRING_ACTION}/pair?code=${encodeURIComponent(code)}`;
}

/**
 * A fixed 16-bit marker in the first two bytes of a creator-generated pairing
 * secret. It is the CAPABILITY SIGNAL for pairing v2: the claimant reads it
 * from the code it was handed OUT OF BAND (never from the server or the
 * network, which an interceptor controls), so a stripped key-exchange field
 * cannot silently downgrade the pairing -- the claimant already knows the
 * creator is v2-capable and shows a v2 match code the stripped path cannot
 * reproduce.
 *
 * It costs nothing the design relies on: 112 bits of `PS` remain random and
 * v2's confidentiality rests on the ECDH exchange, not on `PS`. It does not
 * change the code's length, so a 1.1.4 device decodes a v2 code unchanged and
 * simply pairs the legacy way. A 1.1.4 creator's fully random secret matches
 * the marker with probability 2^-16; that one pairing then shows mismatched
 * codes and is retried with a fresh code (`docs/protocol.md`).
 */
export const PAIRING_V2_MARKER = Uint8Array.from([0x0b, 0x5c]);

export function newPairingSecret(): Bytes {
  const secret = randomBytes(PAIRING_SECRET_BYTES);
  secret[0] = PAIRING_V2_MARKER[0] as number;
  secret[1] = PAIRING_V2_MARKER[1] as number;
  return secret;
}

/** Does this pairing secret carry the v2 capability marker (creator is v2)? */
export function isV2Secret(secret: Bytes): boolean {
  return secret.length >= 2 && secret[0] === PAIRING_V2_MARKER[0] && secret[1] === PAIRING_V2_MARKER[1];
}

/** The first server release that carries the two key-exchange fields. */
export const PAIRING_V2_SERVER = [1, 1, 5] as const;

/**
 * Whether the version a server reports is 1.1.5 or later (owner ruling: fail
 * closed, say it early). Only `major.minor.patch` counts, so a pre-release of
 * 1.1.5 passes; anything else -- absent, empty, or not three numbers -- does
 * not. A forged or stripped answer can only make the creator refuse; the key
 * exchange's own strip detection is unchanged.
 */
export function serverPairsV2(version: unknown): boolean {
  if (typeof version !== "string") return false;
  const parts = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$/.exec(version);
  if (parts === null) return false;
  for (let i = 0; i < PAIRING_V2_SERVER.length; i++) {
    const have = Number(parts[i + 1]);
    const need = PAIRING_V2_SERVER[i] as number;
    if (have !== need) return have > need;
  }
  return true;
}

/** The device-list fields that say what a new device did with the key it collected. */
export interface KeptRow {
  state?: string;
  revoked: boolean;
  last_seen?: number | null;
  last_sign_in?: number | null;
  last_heartbeat?: number | null;
}

/**
 * What a new device did with the vault key it collected, read from its row
 * of the device list. Collection proves only that the envelope left the
 * server; a device that cannot open it, or whose person cancels, takes itself
 * back. Its first request after collection signs it in (`last_sign_in`, the
 * survey that reads the server's vault); a KEPT key then starts its sync, and
 * that sync's heartbeat moves `last_seen` past the sign-in. So: `kept` once
 * active and seen after signing in, `dropped` once revoked or gone, and
 * `open` while it is still deciding.
 *
 * A HEARTBEAT IS THE EVIDENCE, NOT A LATER SECOND (issue #290). The server
 * stamps these fields in whole seconds, and a sync that starts in the second
 * of its sign-in leaves `last_seen` EQUAL to `last_sign_in`: the creator
 * waited out its ten minutes on a device that was syncing all along. Only a
 * started sync sends a heartbeat -- the engine's start, never the claim or
 * the survey -- a pending device's is refused, and the row is minted for this
 * claim, so any `last_heartbeat` on an active row is a kept key. A server
 * that does not list the field is read by the comparison alone, which can
 * only wait longer, never say "paired" sooner.
 */
export function keptOutcome(row: KeptRow | undefined): "kept" | "dropped" | "open" {
  if (row === undefined || row.revoked || row.state === "revoked") return "dropped";
  if (row.state !== "active") return "open";
  if (typeof row.last_heartbeat === "number") return "kept";
  if (typeof row.last_sign_in !== "number" || typeof row.last_seen !== "number") return "open";
  return row.last_seen > row.last_sign_in ? "kept" : "open";
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
 * The v2 vault-key envelope (`docs/protocol.md` "Pairing"). What v1 does with
 * `PS` alone, v2 does with the ECDH-derived key, and it BINDS the sealed key to
 * the pairing and to BOTH public keys through the AEAD's additional data, so an
 * envelope cannot be replayed into another pairing or opened against a
 * substituted key. The 65-byte raw public keys are the additional data,
 * claimant's then creator's, after the pairing id.
 */
function envelopeAadV2(pairingId: string, claimantKey: Bytes, creatorKey: Bytes): Bytes {
  return concat(utf8(pairingId), claimantKey, creatorKey);
}

/** A raw-uncompressed P-256 public key as base64url, checked before it is used. */
export function checkedPublicKey(value: unknown): Bytes {
  if (typeof value !== "string") throw new Error("pairing: a public key must be text");
  let raw: Bytes;
  try {
    raw = unbase64url(value);
  } catch {
    throw new Error("pairing: a public key is not base64url");
  }
  if (raw.length !== PAIRING_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new Error("pairing: a public key is not a raw-uncompressed P-256 point");
  }
  return raw;
}

/** What a device holds through one v2 pairing: its ephemeral pair and its own public key text. */
export interface PairingKeyExchange {
  pair: CryptoKeyPair;
  publicKey: string;
}

export async function newPairingKeyExchange(): Promise<PairingKeyExchange> {
  const pair = await generatePairingKeyPair();
  return { pair, publicKey: await exportPairingPublicKey(pair) };
}

/**
 * Seal `{VRK}` for the claimant under the ECDH-derived key, with the two public
 * keys bound as additional data. The creator calls this on approval, with its
 * own ephemeral pair and the claimant's public key it received.
 */
export async function sealEnvelopeV2(
  ours: PairingKeyExchange,
  peerPublicKey: string,
  pairingSecret: Bytes,
  pairingId: string,
  envelope: VaultEnvelope,
): Promise<{ envelope: string; nonce: string }> {
  const peerRaw = checkedPublicKey(peerPublicKey);
  const peer = await importPairingPublicKey(peerRaw);
  const key = await derivePairingV2Key(ours.pair, peer, pairingSecret, pairingId);
  const nonce = randomBytes(12);
  const handle = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const aad = envelopeAadV2(pairingId, checkedPublicKey(peerPublicKey), checkedPublicKey(ours.publicKey));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
      handle,
      utf8(JSON.stringify(envelope)),
    ),
  );
  return { envelope: base64(ciphertext), nonce: hex(nonce) };
}

/**
 * Open a v2 envelope: the claimant calls this with its own ephemeral pair and
 * the creator's public key it collected. A stripped or substituted creator key
 * makes the AEAD tag fail, which the caller treats as a device that could not
 * be verified.
 */
export async function openEnvelopeV2(
  ours: PairingKeyExchange,
  peerPublicKey: string,
  pairingSecret: Bytes,
  pairingId: string,
  envelope: string,
  nonce: string,
): Promise<VaultEnvelope> {
  const peerRaw = checkedPublicKey(peerPublicKey);
  const peer = await importPairingPublicKey(peerRaw);
  const key = await derivePairingV2Key(ours.pair, peer, pairingSecret, pairingId);
  const handle = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  const aad = envelopeAadV2(pairingId, checkedPublicKey(ours.publicKey), checkedPublicKey(peerPublicKey));
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unhex(nonce), additionalData: aad, tagLength: 128 },
      handle,
      unbase64(envelope),
    ),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as VaultEnvelope;
  if (typeof parsed.vrk !== "string" || parsed.vrk.length !== VRK_BYTES * 2) {
    throw new Error("pairing: the envelope carries no vault key");
  }
  return { vrk: parsed.vrk };
}

/** Vault details travel only as ciphertext, with a key distinct from the VRK envelope. */
export interface PairingVault { name: string; notes: number }
export interface SealedPairingVault { envelope: string; nonce: string }
const VAULT_LABEL = "obsync/v1/pair-vault";

/**
 * A character no vault name shown to a person may hold: a control character,
 * or a bidirectional override or isolate that would make the name read as
 * another. Decided by code point, not by a regular expression over control
 * characters, which Obsidian's review rules refuse.
 */
function unshowable(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

function checkedVault(value: unknown): PairingVault {
  const vault = value as PairingVault | null;
  if (!vault || typeof vault.name !== "string" || vault.name.length === 0 || vault.name.length > 256 ||
      unshowable(vault.name) ||
      !Number.isSafeInteger(vault.notes) || vault.notes < 0) {
    throw new Error("pairing: invalid vault details; start pairing again");
  }
  return { name: vault.name, notes: vault.notes };
}

async function vaultDetailsKey(secret: Bytes, id: string): Promise<CryptoKey> {
  const key = await hkdf(secret, utf8(VAULT_LABEL), utf8(id), 32);
  return crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealPairingVault(secret: Bytes, id: string, vault: PairingVault): Promise<SealedPairingVault> {
  const nonce = randomBytes(12);
  const envelope = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: utf8(id), tagLength: 128 },
    await vaultDetailsKey(secret, id), utf8(JSON.stringify(checkedVault(vault))),
  );
  return { envelope: base64(new Uint8Array(envelope)), nonce: hex(nonce) };
}

export async function openPairingVault(secret: Bytes, id: string, sealed: SealedPairingVault): Promise<PairingVault> {
  if (typeof sealed?.envelope !== "string" || sealed.envelope.length > 2048 ||
      typeof sealed.nonce !== "string" || !/^[0-9a-f]{24}$/.test(sealed.nonce)) {
    throw new Error("pairing: invalid sealed vault details; start pairing again");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(sealed.nonce), additionalData: utf8(id), tagLength: 128 },
    await vaultDetailsKey(secret, id), unbase64(sealed.envelope),
  );
  return checkedVault(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
}

const MATCH_LABEL = "obsync/v1/pair-match";

/**
 * The code both screens show while a pairing waits for approval (issue
 * #152): six digits of `HKDF(PS, "obsync/v1/pair-match", pairing_id + ":" +
 * device_id)`. Each side computes it alone -- the creator from the claimant
 * id the pairing poll names, the claimant from the id its claim returned --
 * from a secret the server never sees, so the server cannot make two screens
 * agree, and a second device racing a leaked code holds another id and shows
 * another code. Nothing about it crosses the wire: a device older than 1.1.4
 * shows none, and pairs as before.
 */
function sixDigits(bytes: Bytes): string {
  const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) % 1_000_000;
  const digits = String(value).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export async function matchCode(secret: Bytes, pairingId: string, deviceId: string): Promise<string> {
  return sixDigits(await hkdf(secret, utf8(MATCH_LABEL), utf8(`${pairingId}:${deviceId}`), 4));
}

const MATCH_LABEL_V2 = "obsync/v2/pair-match";

/**
 * The v2 match code, `docs/protocol.md` "Pairing". It additionally binds the
 * claimant's public key: `HKDF(PS, "obsync/v2/pair-match", pairing_id + ":" +
 * device_id + ":" + claimant_pub)`, six digits. The creator derives it from the
 * key it RECEIVED, the claimant from the key it SENT, so a substituted or
 * STRIPPED key exchange makes the two screens show different codes -- the
 * signal to the person not to approve. A device pairing the legacy way shows
 * `matchCode` (v1) instead.
 */
export async function matchCodeV2(
  secret: Bytes,
  pairingId: string,
  deviceId: string,
  claimantKey: string,
): Promise<string> {
  return sixDigits(await hkdf(secret, utf8(MATCH_LABEL_V2), utf8(`${pairingId}:${deviceId}:${claimantKey}`), 4));
}

const PLATFORM_LABELS: Record<string, string> = {
  macos: "Mac", windows: "Windows PC", linux: "Linux PC", ios: "iPhone", ipados: "iPad", android: "Android",
};

/** What a person calls a platform word (issue #152); anything else is "device". */
export function platformLabel(platform: string): string {
  return Object.hasOwn(PLATFORM_LABELS, platform) ? PLATFORM_LABELS[platform] as string : "device";
}

/** No 0/O, 1/I/L or U: a tag is read aloud and retyped. */
const TAG_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Four characters that tell this device from every other of its kind, made
 * HERE, once, and kept (issue #152). Not the computer's own name: that is
 * often its owner's, and the server stores device names in clear.
 */
export function newDeviceTag(): string {
  let tag = "";
  while (tag.length < 4) {
    // Rejection keeps the 30 characters equally likely.
    const byte = randomBytes(1)[0] as number;
    if (byte < 240) tag += TAG_ALPHABET[byte % 30];
  }
  return tag;
}

/** A setup token as pasted: quotes, spaces and line breaks are copy-paste, never token (issue #154). */
export function pastedToken(text: string): string {
  return unwrap(text).replace(/\s+/g, "");
}

/**
 * A claim waiting for its vault key: everything a device that restarted needs
 * to finish it inside the ten minutes, and nothing it keeps afterwards (issue
 * #153). It lives in its own native secret entry, never in the credential.
 */
export interface PendingClaim {
  pairingId: string;
  /** `PS`, hex: it opens only this pairing's envelope. */
  pairingSecret: string;
  deviceId: string;
  deviceSecret: string;
  serverUrl: string;
  /** Unix ms; the pairing was made before it, so it ends by `+ PAIRING_WINDOW_MS`. */
  claimedAt: number;
}

/** A held claim as stored, or `null` for anything that is not exactly one. */
export function readClaim(text: string | null): PendingClaim | null {
  let value: unknown;
  try {
    value = text === null || text === "" ? null : JSON.parse(text);
  } catch {
    return null;
  }
  const claim = value as PendingClaim | null;
  const hexOf = (field: unknown, bytes: number): boolean =>
    typeof field === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(field);
  if (claim === null || typeof claim !== "object" || !hexOf(claim.pairingId, PAIRING_ID_BYTES) ||
      !hexOf(claim.pairingSecret, PAIRING_SECRET_BYTES) || !hexOf(claim.deviceId, 16) ||
      !hexOf(claim.deviceSecret, 32) || typeof claim.serverUrl !== "string" ||
      !Number.isSafeInteger(claim.claimedAt)) {
    return null;
  }
  const { pairingId, pairingSecret, deviceId, deviceSecret, serverUrl, claimedAt } = claim;
  return { pairingId, pairingSecret, deviceId, deviceSecret, serverUrl, claimedAt };
}

const PAIR_ELSEWHERE = "on a device that already syncs, choose Pair a new device, then paste its code here with Pair this device";
const NEW_CODE = "Make a new one on your other device with Pair a new device.";

/**
 * What a person reads when setup or pairing is refused: what happened, then
 * what to do (issue #154). The server's code stays in the log line; nothing
 * here names a status, a code or a cryptographic detail.
 */
const REFUSALS: Record<string, string> = {
  bad_setup_token: "This server did not accept that setup token. Check that it is this server's token (obsyncd setup-token prints it) and paste it again.",
  already_set_up: `This server already holds a vault, and one server holds one vault. To add this device to it, pair it: ${PAIR_ELSEWHERE}; a different vault needs a server of its own.`,
  not_set_up: "This server holds no vault yet. Set it up first on one device, with Setup or recover and the server's setup token.",
  unknown_pairing: `That code does not match a pairing on this server. Check that you copied all of it and that this device uses the same server. ${NEW_CODE}`,
  pairing_expired: `That code has expired: codes last ten minutes. ${NEW_CODE}`,
  already_claimed: `Another device already used that code. ${NEW_CODE} If none of your devices used it, choose Reject when the other device asks.`,
  stale_timestamp: "This device's clock is more than five minutes off, so the server refused it. Set the date and time automatically, then try again.",
  edge_required: EDGE_REQUIRED,
  device_revoked: "This device was removed from the server, so it cannot pair another. Use Leave this server in obsync's settings, then pair this device again.",
};

/** The text for one refusal code; one this table does not know says so without naming it. */
export function refusalFor(code: string): string {
  return Object.hasOwn(REFUSALS, code)
    ? REFUSALS[code] as string
    : "The server refused this step, so nothing changed. Try again; if it repeats, obsync's log names the reason.";
}

/** Any error a setup or pairing step throws, as text: refusals by table, this plugin's own words as they are. */
export function refusalText(error: unknown): string {
  const certificate = certificateRefusal(error);
  if (certificate !== null) return certificate;
  if (error instanceof ApiError) return refusalFor(error.code);
  const message = error instanceof Error ? error.message.trim() : "";
  return message !== "" ? message : "Something went wrong on this device before anything was shared. Try again.";
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
