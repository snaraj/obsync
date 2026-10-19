/** Bounded rotation bookkeeping. These receipts do not authenticate plaintext. */
export const ROTATION_PAGE_HEADS = 256;
export const ROTATION_MAX_HEADS = 65536;
export interface RotationWireIntent {
  operation: string; previous_map: string; current_map: string;
  target: string | null; recovery_verifier: string; seal_suite: 2;
}
export type SourceHead = [string, string];
export type CatalogEntry = [string, string, string, string];
export interface RotationStatus {
  intent: RotationWireIntent; coordinator: string; cutoff: number; inventory_hash: string;
  inventory_heads: number; catalog_pages: number; catalog_heads: number; catalog_last: SourceHead | null;
  committed: boolean; resume_id: string | null; catalog_hash: string;
}
export interface RotationInventory {
  operation: string; cutoff: number; inventory_hash: string; page: number;
  inventory_heads: number; heads: SourceHead[];
}
const fail = (): never => { throw new Error("rotation response refused"); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return fail();
  return record;
}
function id(value: unknown, bytes = 16): string {
  if (typeof value !== "string" || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) return fail();
  return value;
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return fail();
  return value;
}
function source(value: unknown): SourceHead {
  if (!Array.isArray(value) || value.length !== 2) return fail();
  return [id(value[0]), id(value[1], 32)];
}
export function sourceOrder(left: SourceHead, right: SourceHead): number {
  const a = left[0] + left[1], b = right[0] + right[1];
  return a < b ? -1 : a === b ? 0 : 1;
}
export function readRotationIntent(value: unknown): RotationWireIntent {
  const r = object(value, ["operation", "previous_map", "current_map", "target", "recovery_verifier", "seal_suite"]);
  if (r["seal_suite"] !== 2) return fail();
  const intent: RotationWireIntent = { operation: id(r["operation"]), previous_map: id(r["previous_map"]),
    current_map: id(r["current_map"]), target: r["target"] === null ? null : id(r["target"]),
    recovery_verifier: id(r["recovery_verifier"], 32), seal_suite: 2 };
  if (intent.previous_map === intent.current_map) return fail();
  return intent;
}
export function readRotationStatus(value: unknown, expected: RotationWireIntent, coordinator: string): RotationStatus {
  const r = object(value, ["intent", "coordinator", "cutoff", "inventory_hash", "inventory_heads", "catalog_pages",
    "catalog_heads", "catalog_last", "committed", "resume_id", "catalog_hash"]);
  const intent = readRotationIntent(r["intent"]);
  if (JSON.stringify(intent) !== JSON.stringify(readRotationIntent(expected)) || id(r["coordinator"]) !== coordinator ||
      intent.target === coordinator || typeof r["committed"] !== "boolean") return fail();
  const inventoryHeads = count(r["inventory_heads"], ROTATION_MAX_HEADS);
  const catalogHeads = count(r["catalog_heads"], inventoryHeads), pages = count(r["catalog_pages"], catalogHeads);
  const last = r["catalog_last"] === null ? null : source(r["catalog_last"]);
  if ((catalogHeads === 0) !== (last === null) ||
      catalogHeads > pages * ROTATION_PAGE_HEADS || (r["committed"] && catalogHeads !== inventoryHeads)) return fail();
  return { intent, coordinator, cutoff: count(r["cutoff"]), inventory_hash: id(r["inventory_hash"], 32),
    inventory_heads: inventoryHeads, catalog_pages: pages, catalog_heads: catalogHeads, catalog_last: last,
    committed: r["committed"], resume_id: r["resume_id"] === null ? null : id(r["resume_id"]), catalog_hash: id(r["catalog_hash"], 32) };
}
export function readRotationInventory(value: unknown, status: RotationStatus, page: number): RotationInventory {
  const r = object(value, ["operation", "cutoff", "inventory_hash", "page", "inventory_heads", "heads"]);
  count(page);
  if (r["operation"] !== status.intent.operation || r["cutoff"] !== status.cutoff || r["inventory_hash"] !== status.inventory_hash ||
      r["inventory_heads"] !== status.inventory_heads || r["page"] !== page || !Array.isArray(r["heads"])) return fail();
  const needed = Math.min(ROTATION_PAGE_HEADS, status.inventory_heads - page * ROTATION_PAGE_HEADS);
  if (needed < 0 || (needed === 0 && page !== 0) || r["heads"].length !== needed) return fail();
  const heads = r["heads"].map(source);
  for (let at = 1; at < heads.length; at++) if (sourceOrder(heads[at - 1]!, heads[at]!) >= 0) return fail();
  return { operation: status.intent.operation, cutoff: status.cutoff, inventory_hash: status.inventory_hash,
    page, inventory_heads: status.inventory_heads, heads };
}

export function checkedCatalog(entries: readonly CatalogEntry[]): CatalogEntry[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > ROTATION_PAGE_HEADS) return fail();
  const result = entries.map(row => {
    if (!Array.isArray(row) || row.length !== 4) return fail();
    return [id(row[0]), id(row[1], 32), id(row[2]), id(row[3], 32)] as CatalogEntry;
  });
  // 256 fixed-width tuples serialize below 64 KiB; no variable strings enter.
  return result;
}
