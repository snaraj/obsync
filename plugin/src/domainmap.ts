/**
 * The path-to-domain map, `docs/architecture.md` 5.1 item 3.
 *
 * WHAT IT IS. One object that says which paths live in which domain, so
 * every device derives the same key for the same path. It is data, not local
 * configuration: two devices that disagreed about a path's domain would write
 * the same file under two different keys and neither could read the other's.
 *
 * WHERE IT LIVES. On the server, through the ordinary file mechanism: a
 * reserved file id, ordinary versions, the ciphertext in the manifest slot
 * the server already cannot read. It carries no chunks — the whole map fits
 * in one AEAD blob under the protocol's 1 MiB manifest ceiling — so a version
 * of it is a version with an empty sid list.
 *
 * WHAT THE SERVER SEES. Two random-looking 16-byte identifiers, a ciphertext,
 * and a nonce. Every path in the map is inside the ciphertext, encrypted
 * under `K_map`, which derives from `VRK` and from nothing any recipient will
 * ever hold (AGENTS.md requirement 6).
 *
 * FAIL-CLOSED. Every rule below refuses rather than guesses: a map that does
 * not parse, that declares a prefix twice, that has no default domain, or
 * that has more than one head is a map this device will not sync against,
 * because the alternative is writing a file under the wrong key.
 *
 * PLATFORM. Identical everywhere: WebCrypto and the transport, no filesystem.
 */

import {
  Bytes,
  base64,
  contentVersionId,
  decryptDomainMap,
  deriveDomainMapKey,
  domainMapIds,
  encryptDomainMap,
  hex,
  isHex,
  randomBytes,
  unbase64,
  unhex,
  versionId,
} from "./crypto";
import { ApiError, Transport } from "./transport";

/** One domain and the paths it claims. A path with no slash is a whole file. */
export interface DomainEntry {
  id: string;
  paths: string[];
}

export interface DomainMap {
  v: 1;
  domains: DomainEntry[];
}

/** The prefix the default domain claims: everything no other entry claims. */
export const DEFAULT_PREFIX = "";

/** The keys and reserved identifiers of one vault's map. */
export interface DomainMapKeys {
  key: Bytes;
  fileId: string;
  domainId: string;
}

/** A map this device refuses to act on, with the reason for the log line. */
export class DomainMapError extends Error {
  constructor(readonly reason: string) {
    super(`domain map refused: ${reason}`);
    this.name = "DomainMapError";
  }
}

export async function domainMapKeys(vrk: Bytes): Promise<DomainMapKeys> {
  const key = await deriveDomainMapKey(vrk);
  const { fileId, domainId } = await domainMapIds(key);
  return { key, fileId, domainId };
}

/** The map v0.1 writes for a new vault: one domain covering everything. */
export function defaultDomainMap(domainId = hex(randomBytes(16))): DomainMap {
  return { v: 1, domains: [{ id: domainId, paths: [DEFAULT_PREFIX] }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The runtime schema check. The bytes came off the wire and were written by
 * another device, so every field is verified before any of it picks a key.
 */
export function parseDomainMap(json: string): DomainMap {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new DomainMapError("not_json");
  }
  if (!isRecord(value)) throw new DomainMapError("not_an_object");
  if (value["v"] !== 1) throw new DomainMapError("version");
  const entries = value["domains"];
  if (!Array.isArray(entries) || entries.length === 0) throw new DomainMapError("domains");
  const domains: DomainEntry[] = [];
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry)) throw new DomainMapError("entry");
    const id = entry["id"];
    if (typeof id !== "string" || !isHex(id, 16)) throw new DomainMapError("entry_id");
    if (ids.has(id)) throw new DomainMapError("duplicate_domain");
    ids.add(id);
    const paths = entry["paths"];
    if (!Array.isArray(paths) || paths.length === 0) throw new DomainMapError("entry_paths");
    for (const path of paths as unknown[]) {
      if (typeof path !== "string") throw new DomainMapError("entry_path");
      if (path.startsWith("/") || path.endsWith("/")) throw new DomainMapError("entry_path_shape");
      // Two domains claiming one prefix has no defined winner, and picking
      // one would put a file under a key the other device does not expect.
      if (prefixes.has(path)) throw new DomainMapError("duplicate_prefix");
      prefixes.add(path);
    }
    domains.push({ id, paths: paths as string[] });
  }
  if (!prefixes.has(DEFAULT_PREFIX)) throw new DomainMapError("no_default_domain");
  return { v: 1, domains };
}

/**
 * Which domain owns a path: longest match wins (`docs/architecture.md` 5.1
 * item 1). An entry claims a path when it IS the path or is a folder above
 * it, so `Notes/Trip.md` can be its own domain inside `Notes/` and sharing
 * the note hands over nothing else.
 */
export function domainFor(map: DomainMap, path: string): string {
  let bestId = "";
  let bestLength = -1;
  for (const entry of map.domains) {
    for (const prefix of entry.paths) {
      const claims =
        prefix === DEFAULT_PREFIX || path === prefix || path.startsWith(`${prefix}/`);
      if (claims && prefix.length > bestLength) {
        bestId = entry.id;
        bestLength = prefix.length;
      }
    }
  }
  return bestId;
}

/**
 * The one domain v0.1 can sync, or `null`.
 *
 * v0.1 derives one domain key per engine, so a map declaring a second domain
 * describes a vault this version cannot write correctly. It says so and
 * refuses rather than syncing the parts it happens to understand.
 */
export function soleDomain(map: DomainMap): string | null {
  const only = map.domains[0];
  if (map.domains.length !== 1 || !only) return null;
  if (only.paths.length !== 1 || only.paths[0] !== DEFAULT_PREFIX) return null;
  return only.id;
}

/** The map exactly as it is sealed: canonical field order, no whitespace. */
export function serialiseDomainMap(map: DomainMap): string {
  return JSON.stringify({
    v: 1,
    domains: map.domains.map((entry) => ({ id: entry.id, paths: entry.paths })),
  });
}

/**
 * Read the vault's map, or `null` when no device has written one yet.
 *
 * More than one head means two devices wrote different maps concurrently.
 * There is no rule that says which is current, so this refuses: the derived
 * nonce (`encryptDomainMap`) already collapses two IDENTICAL writes into one
 * version, so a genuine fork is a disagreement, not a race.
 */
export async function loadDomainMap(
  transport: Transport,
  keys: DomainMapKeys,
): Promise<DomainMap | null> {
  let file;
  try {
    file = await transport.getFile(keys.fileId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  if (file.heads.length !== 1) throw new DomainMapError("conflicted");
  const head = file.versions.find((version) => version.version_id === file.heads[0]);
  if (!head) throw new DomainMapError("head_missing");
  const binder = await contentVersionId(keys.fileId, head.parents, head.sids);
  let json: string;
  try {
    json = await decryptDomainMap(
      keys.key,
      keys.fileId,
      binder,
      unhex(head.manifest_nonce),
      unbase64(head.manifest_ct),
    );
  } catch {
    throw new DomainMapError("undecryptable");
  }
  return parseDomainMap(json);
}

/**
 * Write the map as a version of the reserved file. `parents` is the head it
 * replaces, or empty for a vault's first map.
 */
export async function saveDomainMap(
  transport: Transport,
  keys: DomainMapKeys,
  map: DomainMap,
  parents: string[] = [],
): Promise<string> {
  const json = serialiseDomainMap(map);
  const binder = await contentVersionId(keys.fileId, parents, []);
  const { nonce, ciphertext } = await encryptDomainMap(keys.key, keys.fileId, binder, json);
  const id = await versionId(keys.fileId, parents, ciphertext, []);
  await transport.postVersion(keys.fileId, {
    version_id: id,
    parents,
    sids: [],
    bytes: 0,
    domain_id: keys.domainId,
    manifest_ct: base64(ciphertext),
    manifest_nonce: hex(nonce),
    deleted: false,
  });
  return id;
}
