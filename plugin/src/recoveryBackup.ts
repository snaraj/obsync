/** Backup text codec only: decoded bytes are staged, never adopted or sent. */
import type { Bytes } from "./crypto";
import { entropyFromPhrase, recoveryPhrase } from "./pairing";

const PREFIX = "obsync-recovery-v2";
const MAX_BYTES = 512;

export class BackupFailure extends Error {
  constructor(readonly code: "backup_text" | "backup_format" | "backup_phrase" | "backup_entropy") {
    super(code);
    this.name = "BackupFailure";
  }
}

/** Canonical ASCII text; snapshot the 32-byte root before any async work. */
export async function encodeRecoveryBackup(root: Bytes): Promise<string> {
  try {
    if (!(root instanceof Uint8Array) || root.byteLength !== 32) throw new BackupFailure("backup_entropy");
    const snapshot = new Uint8Array(root);
    return `${PREFIX} ${(await recoveryPhrase(snapshot)).join(" ")}`;
  } catch {
    // Do not retain a source error/cause which may contain recovery material.
    throw new BackupFailure("backup_entropy");
  }
}

function tokens(text: string): string[] {
  // ASCII length equals byte length; reject before trimming or normalization.
  if (typeof text !== "string" || text.length > MAX_BYTES || !/^[\x20-\x7e\t\r\n]*$/.test(text)) {
    throw new BackupFailure("backup_text");
  }
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").split(/[ \t\r\n]+/);
}

async function stagedRoot(words: string[]): Promise<Bytes> {
  try {
    // Existing BIP39 decoding enforces exactly 24 lowercase English words
    // and their checksum. Its word-bearing errors must never escape here.
    return await entropyFromPhrase(words);
  } catch {
    throw new BackupFailure("backup_phrase");
  }
}

/** Live-v2 interpretation only. A stripped prefix never selects legacy mode. */
export async function parseRecoveryBackup(text: string): Promise<Bytes> {
  const words = tokens(text);
  if (words.shift() !== PREFIX) throw new BackupFailure("backup_format");
  return stagedRoot(words);
}

/** Explicit history interpretation only; this operation makes no live claim. */
export async function parseLegacyRecoveryHistory(text: string): Promise<Bytes> {
  return stagedRoot(tokens(text));
}
