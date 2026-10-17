/** Closed suite-2 wire framing. This module never selects a key or retries a decoder. */
import { base64, unbase64 } from "./crypto";
import type { Bytes } from "./crypto";

export type ManifestSeal =
  | { manifest_ct: string; manifest_nonce: string; seal_suite?: never }
  | { manifest_ct: string; seal_suite: 2; manifest_nonce?: never };
export type PairingSeal =
  | { envelope: string; nonce: string; seal_suite?: never }
  | { envelope: string; seal_suite: 2; nonce?: never };

export class SealWireError extends Error {
  constructor() { super("sealed record refused"); this.name = "SealWireError"; }
}

function packet(value: unknown, field: "manifest_ct" | "envelope", nonce: "manifest_nonce" | "nonce", max: number): Bytes {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SealWireError();
  const record = value as Record<string, unknown>;
  if (!Object.hasOwn(record, "seal_suite") || !Object.hasOwn(record, field) || record["seal_suite"] !== 2 || nonce in record) throw new SealWireError();
  const text = record[field];
  if (typeof text !== "string" || text.length > max || text.length < 24) throw new SealWireError();
  try {
    const raw = unbase64(text);
    // Canonical base64 of at least 24 characters contains at least 16 bytes.
    if (base64(raw) !== text) throw new SealWireError();
    return raw;
  } catch { throw new SealWireError(); }
}

/** The protocol limits the encoded manifest field to 1 MiB. */
export function readManifestSeal2(value: unknown): Bytes {
  return packet(value, "manifest_ct", "manifest_nonce", 1 << 20);
}

/** Root envelopes and vault details retain their existing encoded-field budgets. */
export function readPairingSeal2(value: unknown, kind: "root" | "details"): Bytes {
  if (kind !== "root" && kind !== "details") throw new SealWireError();
  return packet(value, "envelope", "nonce", kind === "root" ? 8192 : 2048);
}
