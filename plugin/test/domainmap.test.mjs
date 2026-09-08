/**
 * The owner-only path-to-domain map, `docs/architecture.md` 5.1 item 3.
 *
 * Three claims are worth pinning here and each has its own test: the map
 * REFUSES anything it cannot act on unambiguously, longest-match resolution
 * puts a single file in its own domain without touching its siblings, and
 * what reaches the server carries no path — proved by scanning every clear
 * field for a sentinel that really is inside the ciphertext.
 *
 * Node's built-in modules only, against the same fake obsyncd the engine
 * tests use, so a saved map goes through the real transport, the real
 * signing and the real version-id recomputation.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeServer, KEYS, keys } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const c = require("../build/crypto.js");
const dm = require("../build/domainmap.js");

/** A path long enough that finding it in ciphertext by chance is not a risk. */
const SHARED = "Shared/Recipes/Grandmother's pesto";
const SECOND = "9876543210abcdef9876543210abcdef";

function rig() {
  const server = new FakeServer();
  const transport = new Transport({
    request: server.request,
    serverUrl: () => "https://sync.example.invalid",
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => 1757200000000,
    sleep: async () => undefined,
    maxAttempts: 2,
  });
  return { server, transport };
}

/** A two-domain map: the default, and one folder shared on its own. */
function twoDomains(defaultId) {
  return { v: 1, domains: [{ id: defaultId, paths: [""] }, { id: SECOND, paths: [SHARED] }] };
}

test("a new vault's map is one fresh domain covering everything", () => {
  const first = dm.defaultDomainMap();
  assert.equal(first.v, 1);
  assert.equal(first.domains.length, 1);
  assert.equal(c.isHex(first.domains[0].id, 16), true, "16 bytes of hex");
  assert.deepEqual(first.domains[0].paths, [""]);
  assert.notEqual(first.domains[0].id, dm.defaultDomainMap().domains[0].id, "fresh each time");
  assert.equal(dm.soleDomain(first), first.domains[0].id);
});

test("the map refuses every shape it could not act on unambiguously", () => {
  const id = "aa".repeat(16);
  const cases = [
    ["{", "not_json"],
    ["[]", "not_an_object"],
    [JSON.stringify({ v: 2, domains: [{ id, paths: [""] }] }), "version"],
    [JSON.stringify({ v: 1, domains: [] }), "domains"],
    [JSON.stringify({ v: 1 }), "domains"],
    [JSON.stringify({ v: 1, domains: ["nope"] }), "entry"],
    [JSON.stringify({ v: 1, domains: [{ id: "short", paths: [""] }] }), "entry_id"],
    [JSON.stringify({ v: 1, domains: [{ id, paths: [] }] }), "entry_paths"],
    [JSON.stringify({ v: 1, domains: [{ id, paths: [7] }] }), "entry_path"],
    [JSON.stringify({ v: 1, domains: [{ id, paths: ["/absolute"] }] }), "entry_path_shape"],
    [JSON.stringify({ v: 1, domains: [{ id, paths: ["Notes/"] }] }), "entry_path_shape"],
    // Two entries with one id, or one prefix, have no defined winner.
    [JSON.stringify({ v: 1, domains: [{ id, paths: [""] }, { id, paths: ["A"] }] }), "duplicate_domain"],
    [
      JSON.stringify({ v: 1, domains: [{ id, paths: ["", "A"] }, { id: SECOND, paths: ["A"] }] }),
      "duplicate_prefix",
    ],
    // No default domain: a path no entry claims would have no key at all.
    [JSON.stringify({ v: 1, domains: [{ id, paths: ["Notes"] }] }), "no_default_domain"],
  ];
  for (const [json, reason] of cases) {
    assert.throws(
      () => dm.parseDomainMap(json),
      (error) => error.name === "DomainMapError" && error.reason === reason,
      `${reason}: ${json.slice(0, 60)}`,
    );
  }
  // And the shape it does accept survives the round trip through its own
  // serialiser, so the refusals above are not refusing everything.
  const good = twoDomains("bb".repeat(16));
  assert.deepEqual(dm.parseDomainMap(dm.serialiseDomainMap(good)), good);
});

test("longest match wins, so one file is its own domain and its siblings are not", () => {
  const map = dm.parseDomainMap(
    JSON.stringify({
      v: 1,
      domains: [
        { id: "11".repeat(16), paths: [""] },
        { id: "22".repeat(16), paths: ["Notes"] },
        { id: "33".repeat(16), paths: ["Notes/Trip.md"] },
      ],
    }),
  );
  assert.equal(dm.domainFor(map, "Notes/Trip.md"), "33".repeat(16), "the file itself");
  assert.equal(dm.domainFor(map, "Notes/Other.md"), "22".repeat(16), "a sibling stays behind");
  assert.equal(dm.domainFor(map, "Notes/Deep/Nested.md"), "22".repeat(16));
  assert.equal(dm.domainFor(map, "Journal/Today.md"), "11".repeat(16), "the default catches the rest");
  // A prefix claims a folder, not a name that merely starts the same way.
  assert.equal(dm.domainFor(map, "Notesboard.md"), "11".repeat(16));
  // v0.1 syncs one domain and says so rather than syncing part of a vault.
  assert.equal(dm.soleDomain(map), null);
});

test("a map round-trips through the server and the server sees no path", async () => {
  const { server, transport } = rig();
  const k = await keys();
  const map = twoDomains(KEYS.domainId);

  assert.equal(await dm.loadDomainMap(transport, k.map), null, "no map before one is written");
  const versionId = await dm.saveDomainMap(transport, k.map, map);
  assert.deepEqual(await dm.loadDomainMap(transport, k.map), map);

  // The map is one version of one reserved file, with no chunks: it fits in
  // the slot a manifest occupies and the server stores it the same way.
  const stored = server.files.get(k.map.fileId);
  assert.equal(stored.heads.length, 1);
  assert.equal(stored.heads[0], versionId);
  assert.deepEqual(stored.versions[0].sids, []);
  assert.equal(server.chunks.size, 0);
  assert.equal(stored.domain_id, k.map.domainId, "the reserved domain, not the vault's");
  assert.notEqual(k.map.fileId, KEYS.domainId);

  // Nothing the server can read carries a path. `manifest_ct` is the one
  // opaque field, so it is excluded and then checked separately.
  for (const request of server.requests) {
    if (request.json === null) continue;
    const clear = JSON.parse(request.json);
    delete clear.manifest_ct;
    const text = JSON.stringify(clear);
    assert.equal(text.includes(SHARED), false, request.target);
    assert.equal(text.includes("Shared"), false, request.target);
    assert.equal(text.includes("paths"), false, request.target);
  }
  // …and the claim is not vacuous: the path really is in there, under a key
  // that derives from VRK and from nothing a recipient will ever hold.
  const head = stored.versions[0];
  const binder = await c.contentVersionId(k.map.fileId, head.parents, head.sids);
  const json = await c.decryptDomainMap(
    k.map.key,
    k.map.fileId,
    binder,
    c.unhex(head.manifest_nonce),
    c.unbase64(head.manifest_ct),
  );
  assert.equal(json.includes(SHARED), true);
  assert.deepEqual(JSON.parse(json), map);

  // No domain key opens it, and the map key opens no domain's manifests.
  await assert.rejects(() =>
    c.decryptDomainMap(k.domainKey, k.map.fileId, binder, c.unhex(head.manifest_nonce), c.unbase64(head.manifest_ct)),
  );
  await assert.rejects(() =>
    c.decryptManifest(k.manifestKey, k.map.fileId, binder, c.unhex(head.manifest_nonce), c.unbase64(head.manifest_ct)),
  );
});

test("a map that cannot be read unambiguously stops the device", async () => {
  const { server, transport } = rig();
  const k = await keys();
  await dm.saveDomainMap(transport, k.map, dm.defaultDomainMap(KEYS.domainId));

  // A second head: two devices wrote different maps and nothing says which
  // is current. The device refuses rather than picking a key.
  const stored = server.files.get(k.map.fileId);
  stored.heads.push("ff".repeat(32));
  await assert.rejects(
    () => dm.loadDomainMap(transport, k.map),
    (error) => error.name === "DomainMapError" && error.reason === "conflicted",
  );
  stored.heads.pop();

  // A map this device cannot decrypt is not a map it may ignore.
  const wrong = { ...k.map, key: k.domainKey };
  await assert.rejects(
    () => dm.loadDomainMap(transport, wrong),
    (error) => error.name === "DomainMapError" && error.reason === "undecryptable",
  );

  // A head the file does not carry.
  stored.heads[0] = "ee".repeat(32);
  await assert.rejects(
    () => dm.loadDomainMap(transport, k.map),
    (error) => error.name === "DomainMapError" && error.reason === "head_missing",
  );
});

test("rewriting the map replaces the head, and an identical write is one version", async () => {
  const { server, transport } = rig();
  const k = await keys();
  const first = await dm.saveDomainMap(transport, k.map, dm.defaultDomainMap(KEYS.domainId));

  // The derived nonce makes an identical map an identical version: two
  // devices creating the same map collide harmlessly (5.1 item 3).
  const again = await dm.saveDomainMap(transport, k.map, dm.defaultDomainMap(KEYS.domainId));
  assert.equal(again, first);
  assert.equal(server.files.get(k.map.fileId).versions.length, 1);

  // A real change is a new version with the old head as its parent.
  const next = await dm.saveDomainMap(transport, k.map, twoDomains(KEYS.domainId), [first]);
  assert.notEqual(next, first);
  assert.deepEqual(server.files.get(k.map.fileId).heads, [next]);
  assert.deepEqual(await dm.loadDomainMap(transport, k.map), twoDomains(KEYS.domainId));
});
