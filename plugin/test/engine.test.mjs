/**
 * The sync engine end to end against a fake vault and a fake obsyncd.
 *
 * The fake server verifies every signature, every uploaded chunk's sid and
 * every posted version id, so these tests exercise the real transport, the
 * real crypto and the real version-id preimage. What is faked is Obsidian and
 * the socket, nothing else.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, keys, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine, HEARTBEAT_MS } = require("../build/sync/engine.js");
const { pushDelete, pushFile } = require("../build/sync/push.js");
const { applyChange, fetchRemoteOnly, remoteOnlyList, commonAncestor } = require("../build/sync/pull.js");
const c = require("../build/crypto.js");
const dm = require("../build/domainmap.js");

const enc = (text) => new TextEncoder().encode(text);

/**
 * What the server can READ of a request body: every field except the AES-GCM
 * ciphertext, which is opaque to it by construction.
 *
 * Scanning the ciphertext for a short word is not a test, it is a coin toss:
 * `manifest_ct` is base64 of a fresh random-nonce encryption, so a three
 * letter word like `vrk` turns up in it about once every 540 posted versions
 * (measured: 37 hits in 20 000 encryptions of one manifest). That is what
 * made this suite flake. The claim worth pinning is about the CLEAR fields —
 * ids, sizes, hashes — and it is exact.
 */
function clearFields(json) {
  if (json === null) return "";
  const parsed = JSON.parse(json);
  delete parsed.manifest_ct;
  return JSON.stringify(parsed);
}

/** Every manifest the server holds, decrypted the way another device reads it. */
async function postedPaths(server, k) {
  const paths = [];
  for (const frame of server.journal) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const json = await c.decryptManifest(
      k.manifestKey,
      frame.file_id,
      binder,
      Uint8Array.from(Buffer.from(frame.manifest_nonce, "hex")),
      c.unbase64(frame.manifest_ct),
    );
    paths.push(JSON.parse(json).path);
  }
  return paths;
}

test("a push uploads ciphertext and posts a version the server recomputes", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed("Notes/Ideas.md", "# Ideas\nthe plaintext marker\n", 1000);
  const outcome = await pushFile(context, "Notes/Ideas.md");

  assert.equal(outcome.status, "pushed");
  assert.equal(server.chunks.size, 1);
  assert.deepEqual(server.vaultFiles().length, 1);
  const record = state.fileByPath("Notes/Ideas.md");
  assert.equal(record.versionId, outcome.versionId);
  assert.equal(record.size, 29);

  // Blind server: no chunk body, and no readable JSON field, carries the
  // plaintext or the path.
  for (const chunk of server.chunks.values()) {
    assert.equal(Buffer.from(chunk).includes("plaintext marker"), false);
  }
  for (const request of server.requests) {
    const clear = clearFields(request.json);
    assert.equal(clear.includes("Ideas"), false, request.target);
    assert.equal(clear.includes("Notes/"), false, request.target);
  }
  // And the path really is inside the ciphertext: the claim above is about
  // what the server can read, not about the path having gone missing.
  assert.deepEqual(await postedPaths(server, k), ["Notes/Ideas.md"]);
});

test("pushing an unchanged file posts nothing", async () => {
  const { host, server, context } = await rig();
  host.seed("a.md", "same", 1000);
  await pushFile(context, "a.md");
  const versions = server.journal.length;
  host.files.get("a.md").mtime = 2000;
  const second = await pushFile(context, "a.md");
  assert.equal(second.status, "unchanged");
  assert.equal(server.journal.length, versions);
});

test("a large file is chunked, and a resumed upload sends only what is missing", async () => {
  const { host, server, context } = await rig();
  const size = 12 << 20;
  const data = new Uint8Array(size);
  let x = 0x1234abcd;
  for (let i = 0; i < size; i++) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    data[i] = x & 0xff;
  }
  host.seed("big.bin", data, 1000);

  // Pretend a previous run uploaded the first chunk before dying.
  const { chunkStream, bytesSource } = require("../build/chunker.js");
  const first = (await chunkStream(bytesSource(data)).next()).value;
  const sealed = await c.encryptChunk(context.domainKey, first);
  server.chunks.set(sealed.sid, sealed.ciphertext);

  await pushFile(context, "big.bin");
  const puts = server.requests.filter((request) => request.method === "PUT");
  assert.ok(server.chunks.size >= 2, "the file is more than one chunk");
  assert.equal(puts.length, server.chunks.size - 1, "the chunk already present was not re-sent");
});

test("a pull writes the other device's file and records its version", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const frame = await server.publish({
    fileId: "11".repeat(16),
    path: "Notes/From iPhone.md",
    bytes: enc("written elsewhere\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "applied");
  assert.equal(host.text("Notes/From iPhone.md"), "written elsewhere\n");
  assert.equal(state.fileByPath("Notes/From iPhone.md").versionId, frame.version_id);
  assert.equal(context.written.has("Notes/From iPhone.md:1757200001000:18"), true, "the write is echo-tagged");
});

test("a pull refuses content whose plaintext hash does not match its manifest", async () => {
  const { host, server, context, keys: k } = await rig();
  const frame = await server.publish({
    fileId: "12".repeat(16),
    path: "Notes/Tampered.md",
    bytes: enc("honest bytes\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  // Swap the stored chunk for a different, correctly encrypted one: the
  // manifest's cid no longer matches, so the chunk must be refused.
  const other = await c.encryptChunk(k.domainKey, enc("substituted bytes\n"));
  server.chunks.set(frame.sids[0], other.ciphertext);
  await assert.rejects(() => applyChange(context, frame));
  assert.equal(host.files.has("Notes/Tampered.md"), false, "nothing unverified reached the vault");
});

test("a manifest that lies about its plaintext hash is refused before the write", async () => {
  const { host, server, context, keys: k } = await rig();
  const content = enc("honest bytes\n");
  const { cid, sid, ciphertext } = await c.encryptChunk(k.domainKey, content);
  server.chunks.set(sid, ciphertext);
  const frame = await server.publishManifest({
    fileId: "17".repeat(16),
    manifest: {
      v: 1,
      path: "Notes/Lying.md",
      size: content.length,
      mtime: 1757200001000,
      domain: "0123456789abcdef0123456789abcdef",
      chunks: [{ sid, cid: c.hex(cid), len: content.length }],
      sha256: "00".repeat(32),
      deleted: false,
    },
    sids: [sid],
    parents: [],
    deviceId: "ffffffffffffffffffffffffffffffff",
    manifestKey: k.manifestKey,
    bytes: content.length,
  });
  await assert.rejects(() => applyChange(context, frame), /plaintext hash mismatch/);
  assert.equal(host.files.has("Notes/Lying.md"), false, "nothing unverified reached the vault");
});

test("an encrypted manifest for a path outside the vault is refused, and nothing is written", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const fileId = "18".repeat(16);
  // The reviewer's mutant: a manifest this vault's key would decrypt happily,
  // naming a path two levels above the vault root.
  const frame = await server.publish({
    fileId,
    path: "../../outside-the-vault.md",
    bytes: enc("attacker bytes\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });

  assert.equal(await applyChange(context, frame), "refused");
  assert.equal(host.files.size, 0, "not one byte reached a writer");
  assert.deepEqual(host.trashed, [], "and nothing was deleted either");
  assert.deepEqual(Object.keys(state.data.files), [], "the version was not recorded");
  assert.deepEqual(Object.keys(state.data.remoteOnly), []);
  assert.ok(
    host.logs.some((line) => line.includes(`decision=refused reason=path_dot_segment file=${fileId}`)),
    `the refusal names the file id and the rule: ${host.logs.join(" | ")}`,
  );
  assert.match(host.notices.join(" "), /refused a change from another device/);
});

test("every escaping, hidden or malformed manifest path is refused the same way", async () => {
  const cases = [
    ["/etc/obsync-escape.md", "path_absolute"],
    ["a/../../b.md", "path_dot_segment"],
    [".obsidian/plugins/obsync/main.js", "path_hidden_segment"],
    [".obsidian/plugins/obsync/data.json", "path_hidden_segment"],
    ["Notes/pass\u0000wd.md", "path_control_character"],
    ["..\\..\\Windows\\evil.md", "path_backslash"],
    ["C:/Windows/evil.md", "path_drive_letter"],
    ["", "path_empty"],
    ["Notes//Ideas.md", "path_empty_segment"],
  ];
  const { host, server, context, keys: k } = await rig();
  for (const [index, [path, reason]] of cases.entries()) {
    const fileId = String(index).padStart(2, "0").repeat(16);
    const frame = await server.publish({
      fileId,
      path,
      bytes: enc(`payload ${index}\n`),
      mtime: 1757200001000,
      domainKey: k.domainKey,
      manifestKey: k.manifestKey,
    });
    assert.equal(await applyChange(context, frame), "refused", path);
    assert.ok(
      host.logs.some((line) => line.includes(`reason=${reason} file=${fileId}`)),
      `${path} should be refused as ${reason}: ${host.logs.join(" | ")}`,
    );
  }
  assert.equal(host.files.size, 0, "none of them reached the vault");
  assert.equal(host.notices.length, cases.length, "each hostile file is reported once");
});

test("a refused file is reported once, however many versions it sends", async () => {
  const { host, server, context, keys: k } = await rig();
  const fileId = "19".repeat(16);
  for (let attempt = 0; attempt < 3; attempt++) {
    const frame = await server.publish({
      fileId,
      path: ".obsidian/plugins/obsync/main.js",
      bytes: enc(`attempt ${attempt}\n`),
      mtime: 1757200001000 + attempt,
      domainKey: k.domainKey,
      manifestKey: k.manifestKey,
    });
    assert.equal(await applyChange(context, frame), "refused");
  }
  assert.equal(host.notices.length, 1, "one notice per file, not per version");
  assert.equal(
    host.logs.filter((line) => line.includes("decision=refused")).length,
    3,
    "every refusal is still logged",
  );
});

test("a manifest whose fields are the wrong shape is refused before a chunk is fetched", async () => {
  const { host, server, context, keys: k } = await rig();
  const content = enc("honest bytes\n");
  const { cid, sid, ciphertext } = await c.encryptChunk(k.domainKey, content);
  server.chunks.set(sid, ciphertext);
  const frame = await server.publishManifest({
    fileId: "1a".repeat(16),
    manifest: {
      v: 1,
      path: "Notes/Malformed.md",
      size: "quite large",
      mtime: 1757200001000,
      domain: "0123456789abcdef0123456789abcdef",
      chunks: [{ sid, cid: c.hex(cid), len: content.length }],
      sha256: "",
      deleted: false,
    },
    sids: [sid],
    parents: [],
    deviceId: "ffffffffffffffffffffffffffffffff",
    manifestKey: k.manifestKey,
    bytes: content.length,
  });

  assert.equal(await applyChange(context, frame), "refused");
  assert.ok(host.logs.some((line) => line.includes("reason=size file=1a1a")), host.logs.join(" | "));
  assert.equal(host.files.has("Notes/Malformed.md"), false);
  assert.equal(
    server.requests.some((request) => request.target.startsWith("/v1/chunks/get")),
    false,
    "the shape is checked before any chunk is downloaded",
  );
});

test("our own versions are dropped on the way back down the feed", async () => {
  const { host, server, context } = await rig();
  host.seed("echo.md", "mine", 1000);
  const outcome = await pushFile(context, "echo.md");
  context.authored.add(outcome.versionId);
  const frame = server.journal[server.journal.length - 1];

  assert.equal(await applyChange(context, frame), "echo");
  assert.equal(context.authored.has(outcome.versionId), false, "the echo is consumed once");
  // Even without the authored set, the device id alone stops it.
  assert.equal(await applyChange(context, frame), "echo");
});

test("a tombstone deletes locally", async () => {
  const { host, server, state, context, keys: k } = await rig();
  const created = await server.publish({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    bytes: enc("bye\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  await applyChange(context, created);
  const tombstone = await server.publishTombstone({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    manifestKey: k.manifestKey,
    parents: [created.version_id],
  });
  assert.equal(await applyChange(context, tombstone), "deleted");
  assert.deepEqual(host.trashed, ["Notes/Doomed.md"]);
  assert.equal(state.fileByPath("Notes/Doomed.md"), undefined);
});

test("a delete pushes a tombstone with no sids", async () => {
  const { host, server, state, context } = await rig();
  host.seed("gone.md", "content", 1000);
  await pushFile(context, "gone.md");
  host.files.delete("gone.md");
  const outcome = await pushDelete(context, "gone.md");
  assert.ok(outcome);
  const frame = server.journal[server.journal.length - 1];
  assert.equal(frame.deleted, true);
  assert.deepEqual(frame.sids, []);
  assert.equal(state.fileByPath("gone.md"), undefined);
});

test("a policy ceiling makes a file remote-only, and a fetch overrides it", async () => {
  const { host, server, state, context, keys: k } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 16, totalBudgetBytes: 0 },
  });
  const frame = await server.publish({
    fileId: "14".repeat(16),
    path: "Attachments/large.bin",
    bytes: enc("this payload is larger than sixteen bytes"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");
  assert.equal(host.files.has("Attachments/large.bin"), false);
  assert.deepEqual(state.data.remoteOnly["14".repeat(16)], { path: "Attachments/large.bin", size: 41 });

  const listed = remoteOnlyList(context);
  assert.equal(listed.length, 1);
  assert.match(listed[0].why, /per-file ceiling/);

  const path = await fetchRemoteOnly(context, "14".repeat(16));
  assert.equal(path, "Attachments/large.bin");
  assert.equal(host.text("Attachments/large.bin"), "this payload is larger than sixteen bytes");
  assert.equal(state.data.remoteOnly["14".repeat(16)], undefined, "it is no longer remote-only");
});

test("a total budget also holds files back", async () => {
  const { server, context, keys: k } = await rig({
    isMobile: true,
    policy: { perFileMaxBytes: 0, totalBudgetBytes: 8 },
  });
  const frame = await server.publish({
    fileId: "15".repeat(16),
    path: "big.txt",
    bytes: enc("nine bytes"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, frame), "remote_only");
  assert.match(remoteOnlyList(context)[0].why, /total budget/);
});

test("concurrent edits with a common ancestor merge, keeping both", async () => {
  const { host, server, state, context, keys: k } = await rig();
  host.seed("Notes/Shared.md", "one\ntwo\nthree\n", 1000);
  const base = await pushFile(context, "Notes/Shared.md");

  // The other device edits the last line from the same base.
  const theirs = await server.publish({
    fileId: base.fileId,
    path: "Notes/Shared.md",
    bytes: enc("one\ntwo\nTHREE\n"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  // We edit the first line locally, without seeing theirs.
  host.seed("Notes/Shared.md", "ONE\ntwo\nthree\n", 2000);
  const mine = await pushFile(context, "Notes/Shared.md");
  assert.equal(mine.ack.conflicted, true, "the server keeps both heads");

  const head = server.journal.find((frame) => frame.version_id === theirs.version_id);
  const result = await applyChange(context, { ...head, conflicted: true });
  assert.equal(result, "merged");
  assert.equal(host.text("Notes/Shared.md"), "ONE\ntwo\nTHREE\n");
  assert.match(host.notices.join(" "), /merged concurrent edits/);

  const merged = server.journal[server.journal.length - 1];
  assert.deepEqual([...merged.parents].sort(), [mine.versionId, theirs.version_id].sort());
  assert.equal(state.fileByPath("Notes/Shared.md").versionId, merged.version_id);
});

test("overlapping edits keep both sides as a named conflict copy", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed("Notes/Clash.md", "line\n", 1000);
  const base = await pushFile(context, "Notes/Clash.md");
  const theirs = await server.publish({
    fileId: base.fileId,
    path: "Notes/Clash.md",
    bytes: enc("their line\n"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  host.seed("Notes/Clash.md", "my line\n", 2000);
  await pushFile(context, "Notes/Clash.md");

  const head = server.journal.find((frame) => frame.version_id === theirs.version_id);
  assert.equal(await applyChange(context, { ...head, conflicted: true }), "conflict_copy");
  assert.equal(host.text("Notes/Clash.md"), "my line\n", "our edit is untouched");
  const copy = [...host.files.keys()].find((path) => path.includes("conflict from"));
  assert.match(copy, /^Notes\/Clash \(conflict from iPhone, \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
  assert.equal(host.text(copy), "their line\n");
  assert.match(host.notices.join(" "), /kept both versions/);
});

test("a binary conflict is never merged", async () => {
  const { host, server, context, keys: k } = await rig();
  host.seed("image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 1000);
  const base = await pushFile(context, "image.png");
  const theirs = await server.publish({
    fileId: base.fileId,
    path: "image.png",
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [base.versionId],
  });
  host.seed("image.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x03]), 2000);
  await pushFile(context, "image.png");
  const head = server.journal.find((frame) => frame.version_id === theirs.version_id);
  assert.equal(await applyChange(context, { ...head, conflicted: true }), "conflict_copy");
  assert.ok([...host.files.keys()].some((path) => path.startsWith("image (conflict from iPhone")));
});

/**
 * The fake server, wrapped so it spends nonces exactly as obsyncd does and
 * loses one answer. `before` loses the request instead, so the server never
 * saw it: the two together are the whole ambiguity a lost answer creates.
 */
function lossy(server, host, state, { target, before = false }) {
  const spent = new Set();
  let lost = false;
  return new Transport({
    request: async (request) => {
      const nonce = request.headers["X-Obsync-Nonce"];
      if (nonce !== undefined) {
        if (spent.has(nonce)) {
          return {
            status: 401,
            headers: {},
            text: JSON.stringify({ error: "replayed_nonce", detail: "seen within 600 s" }),
            arrayBuffer: new ArrayBuffer(0),
          };
        }
        spent.add(nonce);
      }
      const losing = !lost && request.url.endsWith(target);
      if (losing && before) {
        lost = true;
        throw new Error("the request never arrived");
      }
      const response = await server.request(request);
      if (losing) {
        lost = true;
        throw new Error("the answer was lost");
      }
      return response;
    },
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
}

test("a version post the server accepted but never acknowledged stores one version", async () => {
  const { host, server, state, context } = await rig();
  const lossyContext = { ...context, transport: lossy(server, host, state, { target: "/versions" }) };
  host.seed("Notes/Lost.md", "one line\n", 1000);

  const outcome = await pushFile(lossyContext, "Notes/Lost.md");

  assert.equal(outcome.status, "pushed");
  const file = server.files.get(outcome.fileId);
  assert.equal(file.versions.length, 1);
  assert.deepEqual(file.heads, [outcome.versionId], "it did not fork the file");
  assert.equal(
    posts(server, outcome.fileId),
    1,
    "the answer was read back, not bought with a second write and a second nonce",
  );
  assert.equal(
    host.logs.some((line) => line.includes("status=401") || line.includes("replayed_nonce")),
    false,
    "no refusal this device manufactured for itself",
  );
  assert.ok(host.logs.some((line) => line.includes("decision=reconciled") && line.includes("committed=true")));
});

/** How many version posts of `fileId` the server actually received. */
function posts(server, fileId) {
  return server.requests.filter(
    (request) => request.method === "POST" && request.target === `/v1/files/${fileId}/versions`,
  ).length;
}

test("a version post that never arrived is posted again under a fresh signature", async () => {
  const { host, server, state, context } = await rig();
  const lossyContext = { ...context, transport: lossy(server, host, state, { target: "/versions", before: true }) };
  host.seed("Notes/Never.md", "one line\n", 1000);

  const outcome = await pushFile(lossyContext, "Notes/Never.md");

  assert.equal(outcome.status, "pushed");
  assert.equal(server.files.get(outcome.fileId).versions.length, 1);
  assert.equal(posts(server, outcome.fileId), 1, "the server saw the post exactly once: the re-post");
  assert.ok(host.logs.some((line) => line.includes("decision=reconciled") && line.includes("committed=false")));
  assert.equal(host.logs.some((line) => line.includes("status=401")), false);
});

test("the common ancestor walk finds the shared base, or nothing", () => {
  const versions = [
    { version_id: "c", parents: ["a"] },
    { version_id: "b", parents: ["a"] },
    { version_id: "a", parents: [] },
  ];
  assert.equal(commonAncestor(versions, "b", "c"), "a");
  assert.equal(commonAncestor([{ version_id: "x", parents: [] }, { version_id: "y", parents: [] }], "x", "y"), null);
});

test("the common ancestor is the newest both heads reach, not the oldest", () => {
  // A diamond: `main` and `side` fork from `root`, `merge` joins them, and a
  // head hangs off each side. Both `side` and `root` are common; only one of
  // them replays no edits into the merge.
  const versions = [
    { version_id: "left-head", parents: ["merge"] },
    { version_id: "right-head", parents: ["side"] },
    { version_id: "merge", parents: ["main", "side"] },
    { version_id: "side", parents: ["root"] },
    { version_id: "main", parents: ["root"] },
    { version_id: "root", parents: [] },
  ];
  assert.equal(commonAncestor(versions, "left-head", "right-head"), "side", "root is common too, and older");
  assert.equal(commonAncestor(versions, "merge", "side"), "root", "a head is never its own ancestor");
});

/** `n` versions newest first; the oldest names `tail` as its parents. */
function chain(prefix, n, tail) {
  const versions = [];
  for (let i = n - 1; i >= 0; i--) {
    versions.push({ version_id: `${prefix}${i}`, parents: i === 0 ? tail : [`${prefix}${i - 1}`] });
  }
  return versions;
}

test("the common ancestor walk stays linear over a 2 000-version history", () => {
  // Two heads with 25 private versions each over a 1 950-version shared
  // trunk: the file a conflict actually lands on is the file with history.
  const versions = [...chain("r", 25, ["v1949"]), ...chain("l", 25, ["v1949"]), ...chain("v", 1950, [])];
  assert.equal(versions.length, 2000);
  const byId = new Map(versions.map((version) => [version.version_id, version.parents]));
  let lookups = 0;
  const parentsOf = (id) => {
    lookups++;
    return byId.get(id) ?? [];
  };

  assert.equal(commonAncestor(versions, "l24", "r24", parentsOf), "v1949");
  assert.ok(lookups >= versions.length, `the seam counts the walk, it is not dead (${lookups})`);
  assert.ok(
    lookups <= 2 * versions.length,
    `one walk per side, never one per candidate (${lookups} lookups over ${versions.length} versions)`,
  );
});

test("a wait for an outcome gives up on a wall clock and says so", async () => {
  const timers = new FakeTimers();
  const started = Date.now();
  await assert.rejects(
    () => timers.run(1000, () => false, 50),
    /waited 50 ms of real time and the condition never held/,
    "an exhausted wait is a clear failure, not a quiet false",
  );
  assert.ok(Date.now() - started >= 50, "it waited the budget it was given");
});

test("a wait for nothing drains a real window without walking the clock into the heartbeat", async () => {
  const timers = new FakeTimers();
  let fired = 0;
  timers.set(() => fired++, HEARTBEAT_MS);
  await timers.run(1000);
  assert.equal(fired, 0, "an hour of virtual time never elapsed");
  assert.ok(timers.now <= 41 * 1000, `the virtual clock stayed bounded (${timers.now} ms)`);
});

test("the engine queues, debounces and pushes what the watcher reports", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
      maxAttempts: 2,
    }),
    host,
    now: () => host.clock,
    timers,
    onStatus: (status) => statuses.push(status.kind),
  });

  host.seed("Existing.md", "already here", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("Existing.md") !== undefined);
  assert.equal(server.heartbeats, 1);
  assert.ok(host.logs.includes("heartbeat decision=reported policy_schema=v1"));
  assert.equal(state.fileByPath("Existing.md") !== undefined, true, "startup reconciliation pushed it");

  host.seed("New.md", "typed just now", 2000);
  engine.changed("New.md");
  await timers.run(1000, () => state.fileByPath("New.md") !== undefined);
  assert.equal(state.fileByPath("New.md") !== undefined, true);
  assert.ok(statuses.includes("syncing"));
  assert.equal(statuses[statuses.length - 1], "idle");
  engine.stop();
});

test("the growing-file guard waits for a file to stop changing", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    timers,
  });
  await engine.start();

  // Every stat reports a different size, as a file being copied would.
  let calls = 0;
  const realStat = host.stat.bind(host);
  host.stat = async (path) => {
    const stat = await realStat(path);
    if (stat && path === "Copying.bin") stat.size += calls++;
    return stat;
  };
  host.seed("Copying.bin", "growing", 3000);
  engine.changed("Copying.bin");
  await timers.run(1000, () => calls >= 4);
  assert.equal(state.fileByPath("Copying.bin"), undefined, "nothing torn was uploaded");
  assert.ok(calls >= 4, `the guard kept re-checking instead of pushing (${calls} stats)`);

  host.stat = realStat;
  await timers.run(1000, () => state.fileByPath("Copying.bin") !== undefined);
  assert.equal(state.fileByPath("Copying.bin") !== undefined, true, "it pushes once the file settles");
  engine.stop();
});

/** The engine, wired to one rig. The domain comes from the vault's map. */
function engineOf({ host, server, state }, timers, extra = {}) {
  return new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
      maxAttempts: 2,
    }),
    host,
    now: () => host.clock,
    timers,
    ...extra,
  });
}

test("a vault with no domain map gets one, and syncs under the domain it declares", async () => {
  const rigged = await rig();
  const { host, server, state, transport, keys: k } = rigged;
  // A vault nobody has synced yet: no map on the server at all.
  server.files.delete(k.map.fileId);
  server.mapFileId = null;
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  host.seed("First.md", "the first note\n", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("First.md") !== undefined);

  // The map the engine wrote is readable, is one default domain, and is the
  // domain the note was actually pushed under.
  const map = await dm.loadDomainMap(transport, k.map);
  assert.notEqual(map, null, "the engine wrote the vault's map");
  const domainId = dm.soleDomain(map);
  assert.equal(c.isHex(domainId, 16), true);
  assert.equal(engine.context.domainId, domainId);
  const fileId = state.fileByPath("First.md").fileId;
  assert.equal(server.files.get(fileId).domain_id, domainId);
  assert.ok(host.logs.some((line) => line.includes("domainmap decision=created")));

  // A second start reads the map instead of writing another one.
  engine.stop();
  const again = engineOf(rigged, timers);
  await again.start();
  assert.equal(again.context.domainId, domainId, "the map is the authority, not a fresh guess");
  assert.ok(host.logs.some((line) => line.includes("domainmap decision=loaded")));
  assert.equal(server.files.get(k.map.fileId).versions.length, 1, "one map, one version");
  again.stop();
});

test("a map declaring more than one domain stops this version instead of syncing part of it", async () => {
  const rigged = await rig();
  const { host, server, state, transport, keys: k } = rigged;
  const head = server.files.get(k.map.fileId).heads[0];
  await dm.saveDomainMap(
    transport,
    k.map,
    {
      v: 1,
      domains: [
        { id: KEYS.domainId, paths: [""] },
        { id: "9876543210abcdef9876543210abcdef", paths: ["Shared"] },
      ],
    },
    [head],
  );

  const engine = engineOf(rigged, new FakeTimers());
  host.seed("Untouched.md", "still here\n", 1000);
  await assert.rejects(
    () => engine.start(),
    (error) => error.name === "DomainMapError" && error.reason === "more_than_one_domain",
  );
  assert.equal(engine.context, null, "no keys were derived");
  assert.equal(state.fileByPath("Untouched.md"), undefined, "and nothing was pushed");
  assert.equal(server.vaultFiles().length, 0);
  assert.ok(host.notices.some((notice) => notice.includes("more than one sharing domain")));
});

test("the domain map on the feed is skipped, not written into the vault", async () => {
  const rigged = await rig();
  const { host, server, state, transport, keys: k } = rigged;
  const engine = engineOf(rigged, new FakeTimers());
  await engine.start();

  // Another device rewrote the map: it rides the same feed as any version.
  const head = server.files.get(k.map.fileId).heads[0];
  await dm.saveDomainMap(transport, k.map, dm.defaultDomainMap(KEYS.domainId), [head]);
  const frame = server.journal[server.journal.length - 1];
  assert.equal(frame.file_id, k.map.fileId);

  const before = host.files.size;
  assert.equal(await applyChange(engine.context, frame), "skipped");
  assert.equal(host.files.size, before, "nothing was written into the vault");
  assert.equal(Object.keys(state.data.files).length, 0);
  assert.equal(host.notices.length, 0, "and it is not reported as a refusal");
  assert.ok(host.logs.some((line) => line.includes("path_class=domainmap decision=skipped")));
  engine.stop();
});

test("a write made by the pull path does not bounce back up", async () => {
  const { host, server, state, keys: k } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    timers,
  });
  // The vault is empty, so startup has nothing to push: this only lets the
  // start-up timers fire before the pull below.
  await engine.start();
  await timers.run();

  const frame = await server.publish({
    fileId: "16".repeat(16),
    path: "Pulled.md",
    bytes: enc("from elsewhere\n"),
    mtime: 1757200005000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  await applyChange(engine.context, frame);
  const before = server.journal.length;

  // Obsidian now reports the write the pull just made.
  engine.changed("Pulled.md");
  await timers.run(1000, () => host.logs.some((line) => line.includes("echo_suppressed")));
  assert.equal(server.journal.length, before, "no version was posted for our own write");
  assert.ok(host.logs.some((line) => line.includes("echo_suppressed")));
  engine.stop();
});

test("a rename keeps the file id and moves the path inside the manifest", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    timers,
  });
  host.seed("Old name.md", "stable content", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("Old name.md") !== undefined);
  const fileId = state.fileByPath("Old name.md").fileId;

  host.files.set("New name.md", host.files.get("Old name.md"));
  host.files.delete("Old name.md");
  engine.renamed("Old name.md", "New name.md");
  await timers.run(1000, () => (server.files.get(fileId)?.versions.length ?? 0) === 2);

  assert.equal(state.fileByPath("Old name.md"), undefined);
  assert.equal(state.fileByPath("New name.md").fileId, fileId, "the file kept its identity");
  assert.equal(server.vaultFiles().length, 1, "no second file was created");
  assert.equal(server.files.get(fileId).versions.length, 2);
  engine.stop();
});

test("a rename whose target is hidden is not synced, and neither is the plugin's own state", async () => {
  const { host, server, state, keys: k } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    timers,
  });
  host.seed("Notes/Secret.md", "content", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("Notes/Secret.md") !== undefined);
  const posted = server.journal.length;

  // The vault key lives in this file. A watcher event for it must never
  // become an upload, and moving a note into a hidden folder must not either.
  host.seed(".obsidian/plugins/obsync/data.json", '{"vrk":"0f0f0f0f"}', 2000);
  engine.changed(".obsidian/plugins/obsync/data.json");
  host.files.set(".obsidian/Secret.md", host.files.get("Notes/Secret.md"));
  host.files.delete("Notes/Secret.md");
  engine.renamed("Notes/Secret.md", ".obsidian/Secret.md");
  await timers.run(1000);

  assert.equal(server.journal.length, posted, "nothing hidden was posted");
  assert.equal(state.fileByPath(".obsidian/Secret.md"), undefined, "the hidden path is not tracked");
  assert.equal(state.fileByPath("Notes/Secret.md") !== undefined, true, "the record stayed where it was");
  assert.ok(
    host.logs.some((line) => line.includes("decision=not_synced reason=hidden_segment event=change")),
    host.logs.join(" | "),
  );
  assert.ok(
    host.logs.some((line) => line.includes("decision=not_synced reason=hidden_segment event=rename_to")),
    host.logs.join(" | "),
  );
  // The plugin's own data file holds the vault key, so what matters is that
  // it was never posted. Both halves of that are exact: no manifest the
  // server holds names a hidden path, and no field the server can read
  // carries the key itself (64 hex characters, not a three-letter word).
  assert.deepEqual(await postedPaths(server, k), ["Notes/Secret.md"], "only the ordinary note was posted");
  for (const request of server.requests) {
    assert.equal(clearFields(request.json).includes(KEYS.vrk), false, request.target);
  }

  // Startup reconciliation walks the same gate: the hidden files it sees are
  // counted as skipped, never queued.
  await engine.reconcile();
  await timers.run(1000);
  assert.ok(host.logs.some((line) => line.includes("reconcile decision=queued") && line.includes("skipped=2")));
  engine.stop();
});

test("a path the host cannot sync is skipped by the watcher and by reconciliation", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    timers,
  });
  // What the desktop host reports for a path under a symlinked folder: the
  // string is a fine vault path, the filesystem says otherwise.
  host.seed("Linked/note.md", "through a symlink", 1000);
  host.unsyncable.add("Linked/note.md");
  host.seed("Notes/ok.md", "an ordinary note", 1000);

  await engine.start();
  await timers.run(1000, () => state.fileByPath("Notes/ok.md") !== undefined);
  assert.equal(state.fileByPath("Linked/note.md"), undefined, "reconciliation left it alone");
  assert.equal(server.journal.length, 1, "only the ordinary note was posted");
  assert.ok(host.logs.some((line) => line.includes("reconcile decision=queued") && line.includes("skipped=1")));

  engine.changed("Linked/note.md");
  await timers.run(1000);
  assert.equal(server.journal.length, 1, "the watcher did not push it either");
  assert.equal(state.fileByPath("Linked/note.md"), undefined);
  engine.stop();
});

test("startup reconciliation tombstones a file deleted while Obsidian was closed", async () => {
  const { host, server, state } = await rig();
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
    }),
    host,
    timers,
  });
  host.seed("Removed.md", "content", 1000);
  await engine.start();
  await timers.run(1000, () => server.journal.length === 1);
  assert.equal(server.journal.length, 1);

  host.files.delete("Removed.md");
  await engine.reconcile();
  await timers.run(1000, () => server.journal.length === 2);
  assert.equal(server.journal[server.journal.length - 1].deleted, true);
  assert.equal(state.fileByPath("Removed.md"), undefined);
  engine.stop();
});
