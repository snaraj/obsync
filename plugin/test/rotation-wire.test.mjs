import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const w = require("../build/rotationWire.js");
const id = n => n.toString(16).padStart(32, "0"), digest = n => n.toString(16).padStart(64, "0");
const coordinator = id(4);
const intent = () => ({ operation: id(1), previous_map: id(2), current_map: id(3), target: id(5), recovery_verifier: digest(6), seal_suite: 2 });
const status = (patch = {}) => ({ intent: intent(), coordinator, cutoff: 123, inventory_hash: digest(7), inventory_heads: 2,
  catalog_pages: 0, catalog_heads: 0, catalog_last: null, committed: false, resume_id: null, catalog_hash: digest(8), ...patch });
const read = value => w.readRotationStatus(value, intent(), coordinator);
const refused = work => assert.throws(work, /^Error: rotation response refused$/);

test("rotation receipt binds all frozen intent fields and the current coordinator", () => {
  assert.deepEqual(read(status()), status());
  for (const field of ["operation", "previous_map", "current_map", "target", "recovery_verifier", "seal_suite"]) {
    const different = intent(); different[field] = field === "seal_suite" ? 1 : field === "recovery_verifier" ? digest(9) : id(9);
    refused(() => read(status({ intent: different })));
  }
  refused(() => read(status({ coordinator: id(9) })));
  const selfTarget = { ...intent(), target: coordinator };
  refused(() => w.readRotationStatus(status({ intent: selfTarget }), selfTarget, coordinator));
});

test("closed intent accepts explicit null migration target and rejects ambiguous identities", () => {
  const solo = { ...intent(), target: null };
  assert.deepEqual(w.readRotationIntent(solo), solo);
  for (const invalid of [{ ...intent(), current_map: id(2) }, { ...intent(), target: undefined }, { ...intent(), seal_suite: "2" },
    { ...intent(), operation: "A".repeat(32) }, { ...intent(), recovery_verifier: id(1) }, { ...intent(), extra: true }]) {
    refused(() => w.readRotationIntent(invalid));
  }
  for (const field of Object.keys(intent())) {
    const missing = intent(); delete missing[field]; refused(() => w.readRotationIntent(missing));
    const inherited = Object.assign(Object.create({ [field]: intent()[field] }), missing);
    refused(() => w.readRotationIntent(inherited));
  }
});

test("receipt counters are safe, bounded and internally consistent", () => {
  for (const field of ["cutoff", "inventory_heads", "catalog_pages", "catalog_heads"]) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, null, "1"]) refused(() => read(status({ [field]: value })));
  }
  refused(() => read(status({ inventory_heads: w.ROTATION_MAX_HEADS + 1 })));
  for (const patch of [{ catalog_heads: 3 }, { catalog_heads: 1 }, { catalog_last: [id(1), digest(1)] },
    { catalog_heads: 1, catalog_pages: 0, catalog_last: [id(1), digest(1)] },
    { catalog_heads: 1, catalog_pages: 2, catalog_last: [id(1), digest(1)] },
    { inventory_heads: 257, catalog_heads: 257, catalog_pages: 1, catalog_last: [id(1), digest(1)] },
    { committed: true }, { committed: "false" }, { resume_id: true }]) refused(() => read(status(patch)));
  const complete = status({ committed: true, catalog_heads: 2, catalog_pages: 1, catalog_last: [id(2), digest(2)], resume_id: id(8) });
  assert.deepEqual(read(complete), complete);
  assert.deepEqual(read(status({ inventory_heads: 0, committed: true })), status({ inventory_heads: 0, committed: true }));
});

test("receipt containers, digests and fields refuse instead of coercing", () => {
  for (const value of [null, [], Object.assign([], status()), true, "record"]) refused(() => read(value));
  for (const field of Object.keys(status())) {
    const value = status(); delete value[field]; refused(() => read(value));
  }
  for (const field of ["inventory_hash", "catalog_hash"]) for (const value of [null, id(1), "AB".repeat(32)]) refused(() => read(status({ [field]: value })));
  for (const last of [[], [id(1)], [id(1), digest(2), digest(3)], [digest(1), digest(2)]]) {
    refused(() => read(status({ catalog_heads: 1, catalog_pages: 1, catalog_last: last })));
  }
});

test("inventory pages preserve complete ordered source membership and bind cutoff/hash/operation", () => {
  const s = read(status());
  const page = { operation: s.intent.operation, cutoff: s.cutoff, inventory_hash: s.inventory_hash, page: 0,
    inventory_heads: 2, heads: [[id(1), digest(1)], [id(1), digest(2)]] };
  assert.deepEqual(w.readRotationInventory(page, s, 0), page);
  for (const [field, value] of [["operation", id(9)], ["cutoff", 124], ["inventory_hash", digest(9)], ["page", 1], ["inventory_heads", 3],
    ["heads", page.heads.slice(0, 1)], ["heads", [...page.heads].reverse()], ["heads", [page.heads[0], page.heads[0]]], ["heads", {}]]) {
    refused(() => w.readRotationInventory({ ...page, [field]: value }, s, 0));
  }
  for (const requested of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) refused(() => w.readRotationInventory(page, s, requested));
  const empty = read(status({ inventory_heads: 0 }));
  const zero = { ...page, inventory_heads: 0, heads: [] };
  assert.deepEqual(w.readRotationInventory(zero, empty, 0), zero);
  refused(() => w.readRotationInventory({ ...zero, page: 1 }, empty, 1));
});

test("fixed inventory page sizes account for a full page and final remainder", () => {
  const s = read(status({ inventory_heads: 257 }));
  const page = { operation: s.intent.operation, cutoff: s.cutoff, inventory_hash: s.inventory_hash, page: 0,
    inventory_heads: 257, heads: Array.from({ length: 256 }, (_, n) => [id(n), digest(n)]) };
  assert.equal(w.readRotationInventory(page, s, 0).heads.length, 256);
  assert.equal(w.readRotationInventory({ ...page, page: 1, heads: [[id(256), digest(256)]] }, s, 1).heads.length, 1);
  refused(() => w.readRotationInventory({ ...page, heads: [...page.heads, [id(256), digest(256)]] }, s, 0));
  refused(() => w.readRotationInventory({ ...page, page: 1, heads: [] }, s, 1));
});

test("catalog input is copied and bounded to exact opaque ID tuples", () => {
  const row = [id(1), digest(1), id(2), digest(2)];
  const rows = Array.from({ length: 256 }, () => [...row]);
  const checked = w.checkedCatalog(rows);
  assert.deepEqual(checked, rows); assert.notEqual(checked[0], rows[0]);
  assert.ok(JSON.stringify(checked).length <= 65536);
  for (const invalid of [[], null, [...rows, row], [[...row, "extra"]], [[id(1), id(1), id(2), digest(2)]]]) refused(() => w.checkedCatalog(invalid));
});

test("inherited required fields refuse even when enumerable filler preserves key count", () => {
  const original = intent(), own = { ...original }; delete own.target;
  const inherited = Object.assign(Object.create({ target: original.target }), own, { filler: true });
  assert.equal(Object.keys(inherited).length, Object.keys(original).length, "own-field control must preserve exact enumerable key count");
  assert.throws(() => w.readRotationIntent(inherited), /^Error: rotation response refused$/, "required rotation fields must be own properties even with compensating filler");
});
