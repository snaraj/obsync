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
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

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
  // The note, and then the folder it was the last thing in. No device ever
  // published a record for `Notes`, so nothing will ever tombstone it and the
  // note leaving is the only signal there is (issue #104, `pruneEmptyParents`).
  assert.deepEqual(host.trashed, ["Notes/Doomed.md", "Notes"]);
  assert.equal(state.fileByPath("Notes/Doomed.md"), undefined);
});

/**
 * DELETE VERSUS EDIT KEEPS BOTH, and a deletion is the one change that keeps
 * nothing (`docs/architecture.md`, section 4).
 *
 * A tombstone says the file was deleted on ANOTHER device. It says nothing
 * about what this one has written since, and the file standing here may hold
 * bytes no version holds -- typed while Obsidian was closed, or while this
 * folder was outside the selection, which a widening then replays the whole
 * feed against. Three placements below: the file has moved under its record,
 * the tombstone forks from the version this device holds, and a save lands
 * inside the removal itself.
 */
const doomed = async (options) => {
  const r = await rig(options);
  const created = await r.server.publish({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    bytes: enc("bye\n"),
    mtime: 1757200001000,
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });
  await applyChange(r.context, created);
  return { ...r, created };
};

test("a tombstone does not take an edit this device never published", async () => {
  const { host, state, server, context, keys: k, created } = await doomed();
  // Typed while nothing was watching: the record still describes the version
  // above, and the push that would carry these bytes has not run.
  host.seed("Notes/Doomed.md", "TYPED WHILE CLOSED SENTINEL\n", 1757200009000);
  const tombstone = await server.publishTombstone({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    manifestKey: k.manifestKey,
    parents: [created.version_id],
  });

  assert.equal(await applyChange(context, tombstone), "skipped");

  assert.deepEqual(host.trashed, [], "a file holding bytes that exist nowhere else was deleted");
  assert.equal(host.text("Notes/Doomed.md"), "TYPED WHILE CLOSED SENTINEL\n");
  assert.ok(state.fileByPath("Notes/Doomed.md"), "the record was dropped, so nothing will publish those bytes");
  assert.ok(
    host.logs.some((line) => line.includes("path_class=tombstone decision=local_edit_kept reason=local_edit")),
    host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  // COMPOSED BEHAVIOUR (#106 meeting #98). Keeping the bytes is no longer
  // the whole answer: they are published again under the SAME file id, so
  // the note returns on every device instead of waiting for the next push.
  // The weaker "did not delete" notice is what a revive that could not
  // reach the server falls back to, and the test below is that side.
  assert.match(host.notices.join(" "), /was kept and published again/);
  assert.ok(
    host.logs.some((line) => line.includes("decision=local_edit_kept reason=local_edit published=pushed")),
    host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("a tombstone whose revive cannot publish keeps the file and says only that", async () => {
  const { host, state, server, context, keys: k, created } = await doomed();
  host.seed("Notes/Doomed.md", "TYPED WHILE CLOSED SENTINEL\n", 1757200009000);
  // The note is still being written when the tombstone arrives, so the
  // revive's own end-of-read guard abandons it (issue #99). Nothing was
  // published, so the notice must not claim the note is back everywhere --
  // it says the true, weaker thing, and the next push carries the bytes.
  const realRead = host.read.bind(host);
  host.read = async (path) => {
    const bytes = await realRead(path);
    host.seed(path, "TYPED WHILE CLOSED SENTINEL, AND STILL TYPING\n", 1757200010000);
    return bytes;
  };
  const tombstone = await server.publishTombstone({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    manifestKey: k.manifestKey,
    parents: [created.version_id],
  });

  assert.equal(await applyChange(context, tombstone), "skipped");

  assert.deepEqual(host.trashed, [], "a file holding bytes that exist nowhere else was deleted");
  assert.ok(state.fileByPath("Notes/Doomed.md"), "the record was dropped, so nothing will publish those bytes");
  assert.ok(
    host.logs.some((line) => line.includes("decision=local_edit_kept reason=local_edit published=growing")),
    host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  assert.match(host.notices.join(" "), /did not delete Notes\/Doomed\.md: it holds changes this device has not uploaded yet/);
  assert.doesNotMatch(
    host.notices.join(" "),
    /published again/,
    "the user was told the note is back on every device when nothing was published",
  );
});

test("a tombstone that forks from the version this device holds is one side of a fork", async () => {
  const { host, state, server, context, keys: k, created } = await doomed();
  // Published from here, so the record moves on: the tombstone below is a
  // sibling of that version, not its descendant, which is what a replayed
  // feed hands a device that edited after the deletion it never saw.
  host.seed("Notes/Doomed.md", "PUBLISHED FROM HERE SENTINEL\n", 1757200009000);
  await pushFile(context, "Notes/Doomed.md");
  const tombstone = await server.publishTombstone({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    manifestKey: k.manifestKey,
    parents: [created.version_id],
  });

  assert.equal(await applyChange(context, tombstone), "skipped");

  assert.deepEqual(host.trashed, [], "a version newer than the deletion was deleted by it");
  assert.equal(host.text("Notes/Doomed.md"), "PUBLISHED FROM HERE SENTINEL\n");
  assert.ok(state.fileByPath("Notes/Doomed.md"));
  assert.ok(
    host.logs.some((line) => line.includes("path_class=tombstone decision=local_edit_kept reason=delete_vs_edit")),
    host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
  // And the notice says what happened (issue #173): the version here is
  // already on the server, so there is nothing "not uploaded yet" to upload.
  assert.equal(host.notices.length, 1);
  assert.match(host.notices[0], /did not delete Notes\/Doomed\.md: another device deleted it without having seen/);
  assert.doesNotMatch(host.notices[0], /not uploaded|uploaded as a new version/);
});

test("a save landing between the tombstone's check and its removal is kept", async () => {
  const { host, state, server, context, keys: k, created } = await doomed();
  const stat = host.stat.bind(host);
  let asked = 0;
  host.stat = async (path) => {
    const answer = await stat(path);
    // The first answer is the check's, and the save lands right after it: the
    // file the removal then names is not the file that was checked.
    if (path === "Notes/Doomed.md" && ++asked === 1) return answer;
    if (path === "Notes/Doomed.md") return { ...answer, mtime: 1757200009000, size: 99 };
    return answer;
  };
  const tombstone = await server.publishTombstone({
    fileId: "13".repeat(16),
    path: "Notes/Doomed.md",
    manifestKey: k.manifestKey,
    parents: [created.version_id],
  });

  assert.equal(await applyChange(context, tombstone), "skipped");

  assert.deepEqual(host.trashed, [], "the removal was not bound to the bytes it was told to remove");
  assert.ok(state.fileByPath("Notes/Doomed.md"), "the record was dropped for a file that is still there");
  assert.ok(
    host.logs.some((line) => line.includes("decision=local_edit_kept reason=source_changed_in_trash")),
    host.logs.filter((line) => line.startsWith("pull")).join(" | "),
  );
});

test("a host that cannot bind a removal still applies the deletion", async () => {
  for (const options of [{ isMobile: true }, undefined]) {
    const { host, state, server, context, keys: k, created } = await doomed(options);
    if (options === undefined) {
      // A desktop whose filesystem refuses the hold or the move answers
      // `unheld`: nothing was removed, and the deletion must still apply
      // rather than be dropped by a feed that never delivers it again.
      const trash = host.trash.bind(host);
      host.trash = async (path, expect) => (expect === undefined ? await trash(path) : "unheld");
    }
    const tombstone = await server.publishTombstone({
      fileId: "13".repeat(16),
      path: "Notes/Doomed.md",
      manifestKey: k.manifestKey,
      parents: [created.version_id],
    });

    assert.equal(await applyChange(context, tombstone), "deleted");

    // THE EMPTY PARENT GOES WITH IT (issue #104). A folder this device holds no
    // record for exists only to hold the file that is leaving, and nothing will
    // ever tombstone it, so the pull path takes it once the last file under it
    // is gone. A vault that has finished a startup reconciliation has a record
    // for every folder and the walk stops at the first one, which is why a
    // folder on a real device goes only by its own tombstone.
    assert.deepEqual(host.trashed, ["Notes/Doomed.md", "Notes"], JSON.stringify(options));
    assert.equal(state.fileByPath("Notes/Doomed.md"), undefined);
  }
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
 * `meanwhile` is what happens on this device while the loss is being settled
 * -- it runs once, before the first request after the loss.
 */
function lossy(server, host, state, { target, before = false, meanwhile = null }) {
  const spent = new Set();
  let lost = false;
  return new Transport({
    request: async (request) => {
      if (lost && meanwhile !== null) {
        const run = meanwhile;
        meanwhile = null;
        await run();
      }
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

/**
 * A DELETION WHOSE FIRST SEND WAS LOST IS DECIDED AGAIN BEFORE IT IS SENT
 * AGAIN (issue #173). Settling a lost answer reads the file back with retries
 * -- 45 seconds of them in the battery -- and the note can come back in that
 * time: restored here, or rewritten by another device's change pulled in the
 * meantime. The re-send used to go out on the first send's word, deleting a
 * note that was back and forking its file on the server for good.
 */
async function lostDeletion(path, meanwhile) {
  const r = await rig();
  r.host.seed(path, "one line\n", 1000);
  const created = await pushFile(r.context, path);
  r.host.files.delete(path);
  const transport = lossy(r.server, r.host, r.state, { target: "/versions", before: true, meanwhile: () => meanwhile(r, created) });
  const outcome = await pushDelete({ ...r.context, transport }, path);
  return { ...r, created, outcome };
}

test("a lost deletion is sent again only while the note is still gone", async () => {
  const { host, server, state, created, outcome } = await lostDeletion("Notes/Gone.md", async () => undefined);

  assert.ok(outcome, "a deletion that is still true was dropped");
  assert.equal(posts(server, created.fileId), 2, "the create and the one re-send");
  assert.equal(server.journal.at(-1).deleted, true);
  assert.equal(state.fileByPath("Notes/Gone.md"), undefined);
  assert.ok(host.logs.includes(`push path_class=tombstone decision=resent reason=still_gone file=${created.fileId} age_ms=0`), host.logs.join(" | "));
});

test("a lost deletion is not sent again once the note is back on the disk", async () => {
  const { host, server, state, created, outcome } = await lostDeletion("Notes/Back.md", async ({ host }) => {
    host.seed("Notes/Back.md", "one line\n", 1000);
  });

  assert.equal(outcome, null, "a stale deletion was sent for a note that is back");
  assert.equal(posts(server, created.fileId), 1, "the deletion was re-sent");
  assert.deepEqual(server.files.get(created.fileId).heads, [created.versionId]);
  assert.equal(host.text("Notes/Back.md"), "one line\n");
  assert.ok(state.fileByPath("Notes/Back.md"), "the record of a note that is here was dropped");
  assert.ok(host.logs.includes(`push path_class=tombstone decision=withdrawn reason=file_present file=${created.fileId} age_ms=0`), host.logs.join(" | "));
  // The user put it back: nothing happened that they do not already know.
  assert.deepEqual(host.notices, []);
});

test("a lost deletion is not sent again once another device's change brought the note back", async () => {
  // The battery's shape (S79): deleted here while offline, edited and renamed
  // on the other devices, and pulled back under its new name while this
  // device was still settling its lost deletion.
  const { host, server, created, outcome } = await lostDeletion("Notes/n13.md", async ({ server, context, host, keys: k }, created) => {
    host.clock += 45000;
    const renamed = await server.publish({
      fileId: created.fileId,
      path: "Notes/n13-final.md",
      bytes: enc("one line\nA-line\n"),
      mtime: 1757200002000,
      domainKey: k.domainKey,
      manifestKey: k.manifestKey,
      parents: [created.versionId],
    });
    await applyChange(context, renamed);
  });

  assert.equal(outcome, null, "a stale deletion was sent for a note another device changed");
  const file = server.files.get(created.fileId);
  assert.equal(file.heads.length, 1, "the file forked on the server");
  assert.equal(server.journal.some((frame) => frame.deleted), false);
  assert.equal(host.text("Notes/n13-final.md"), "one line\nA-line\n");
  assert.ok(host.logs.includes(`push path_class=tombstone decision=withdrawn reason=record_changed file=${created.fileId} age_ms=45000`), host.logs.join(" | "));
  // Said on the device where it happened: the note it deleted is back.
  assert.equal(host.notices.length, 1, host.notices.join(" | "));
  assert.match(host.notices[0], /Notes\/n13\.md/);
  assert.match(host.notices[0], /Notes\/n13-final\.md/);
  assert.match(host.notices[0], /changed on another device/);
});

test("a lost deletion withdrawn for another device's edit at the same name says the note is back, not back under its own name", async () => {
  const { host, created, outcome } = await lostDeletion("Notes/Same.md", async ({ server, context, keys: k }, created) => {
    const edited = await server.publish({
      fileId: created.fileId,
      path: "Notes/Same.md",
      bytes: enc("one line\nedited elsewhere\n"),
      mtime: 1757200002000,
      domainKey: k.domainKey,
      manifestKey: k.manifestKey,
      parents: [created.versionId],
    });
    await applyChange(context, edited);
  });

  assert.equal(outcome, null);
  assert.equal(host.text("Notes/Same.md"), "one line\nedited elsewhere\n");
  assert.equal(host.notices.length, 1, host.notices.join(" | "));
  assert.match(host.notices[0], /changed on another device before this deletion reached the server, so the note is back here\.$/);
});

test("a lost deletion is not sent again once the note has moved past the version it was decided from", async () => {
  // Another device's edit is pulled in while the loss is settled, and the
  // note is deleted here again at once: the path is empty again, but the
  // first send's tombstone names a version the note has moved past, and sent
  // it would fork the file -- the second deletion is the one to publish.
  const { host, server, created, outcome } = await lostDeletion("Notes/Twice.md", async ({ server, context, host, keys: k }, created) => {
    const edited = await server.publish({
      fileId: created.fileId,
      path: "Notes/Twice.md",
      bytes: enc("one line\nB-line\n"),
      mtime: 1757200002000,
      domainKey: k.domainKey,
      manifestKey: k.manifestKey,
      parents: [created.versionId],
    });
    await applyChange(context, edited);
    host.files.delete("Notes/Twice.md");
  });

  assert.equal(outcome, null, "a tombstone for a version the note has moved past was sent");
  assert.equal(server.files.get(created.fileId).heads.length, 1, "the file forked on the server");
  assert.equal(server.journal.some((frame) => frame.deleted), false);
  assert.ok(host.logs.includes(`push path_class=tombstone decision=withdrawn reason=record_changed file=${created.fileId} age_ms=0`), host.logs.join(" | "));
  // Nothing came back here, so there is nothing to tell.
  assert.deepEqual(host.notices, []);
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

/**
 * A SAVE THE MODIFICATION TIME CANNOT SEE (issue #175). FAT32 keeps a file's
 * modification time to the even second, so a second save of the same size
 * inside one step leaves `(mtime, size)` exactly as the first push recorded
 * it, and nothing that compares those two numbers can tell it happened. The
 * engine's clock here is the timers' own, so "later" means the same thing to
 * the push that measures an age and to the timer that fires on it.
 */
const STEP = 1790244622000;

function coarseRig(rigged, timers, start = STEP + 300) {
  Object.defineProperty(rigged.host, "clock", { get: () => start + timers.now, configurable: true });
  const reads = [];
  const read = rigged.host.read.bind(rigged.host);
  rigged.host.read = async (path) => {
    reads.push(path);
    return await read(path);
  };
  return reads;
}

const rechecks = (host) => host.logs.filter((line) => line.startsWith("push path_class=file decision=recheck"));

test("a second save of the same size inside one coarse mtime step is still sent", async () => {
  const rigged = await rig();
  const { host, state } = rigged;
  const timers = new FakeTimers();
  const reads = coarseRig(rigged, timers);
  const engine = engineOf(rigged, timers);

  host.seed("Notes/n05.md", "LINE 3\nline 4\n", STEP);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/n05.md") !== undefined);
  const first = state.fileByPath("Notes/n05.md");

  // 0.6 s later, the same number of bytes, and the volume stamps it with the
  // same even second.
  host.seed("Notes/n05.md", "LINE 3\nLINE 4\n", STEP);
  engine.changed("Notes/n05.md");
  await timers.run(100, () => state.fileByPath("Notes/n05.md").versionId !== first.versionId);

  const now = state.fileByPath("Notes/n05.md");
  assert.equal(now.mtime, first.mtime, "the time never moved");
  assert.notEqual(now.sha256, first.sha256, "and the bytes that were sent are the second save's");
  assert.deepEqual(reads, ["Notes/n05.md", "Notes/n05.md"], "one read to publish, one when the step closed");
  assert.equal(rechecks(host).length, 1, host.logs.join(" | "));
  assert.match(rechecks(host)[0], /reason=coarse_mtime delay_ms=1[0-9]{3}$/);
  engine.stop();
});

test("a file whose modification time can still move is never read twice", async () => {
  const rigged = await rig();
  const { host, state } = rigged;
  const timers = new FakeTimers();
  const reads = coarseRig(rigged, timers);
  const engine = engineOf(rigged, timers);

  // A fine-grained stamp (APFS, NTFS, ext4), a whole second long past, and a
  // whole second far ahead of this clock: none of them can hide a save.
  host.seed("Notes/fine.md", "a fine stamp\n", STEP + 123);
  host.seed("Notes/old.md", "an old stamp\n", STEP - 60_000);
  host.seed("Notes/ahead.md", "a stamp ahead\n", STEP + 86_400_000);
  await engine.start();
  await timers.run(100, () => ["fine", "old", "ahead"].every((name) => state.fileByPath(`Notes/${name}.md`) !== undefined));
  await timers.run(1000);

  assert.equal(reads.length, 3, reads.join(", "));
  assert.deepEqual(rechecks(host), []);
  engine.stop();
});

test("each start clears an interrupted write's leftovers before it lists the vault, and a failed clean-up stops nothing", async () => {
  const rigged = await rig();
  const { host } = rigged;
  const order = [];
  host.sweep = async () => { order.push("sweep"); };
  const list = host.list.bind(host);
  host.list = async () => {
    order.push("list");
    return await list();
  };
  const engine = engineOf(rigged, new FakeTimers());
  await engine.start();
  engine.stop();
  assert.deepEqual(order, ["sweep", "list"]);

  // A walk that stops part way -- a file this user cannot stat -- is logged,
  // and the start goes on.
  host.sweep = async () => {
    order.push("sweep");
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  order.length = 0;
  const again = engineOf(rigged, new FakeTimers());
  await again.start();
  again.stop();
  assert.deepEqual(order, ["sweep", "list"]);
  assert.ok(host.logs.includes("host path_class=temp decision=failed reason=sweep code=EACCES"), host.logs.join(" | "));
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
  // Both records the ordinary note produces -- itself and its folder -- so
  // the snapshot below counts everything sync legitimately posts.
  await timers.run(1000, () =>
    state.fileByPath("Notes/Secret.md") !== undefined && state.folderByPath("Notes") !== undefined);
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
  // The note is ALIVE, under a name this device may not sync. Keeping the
  // record here is what made the next scan publish a tombstone for it, and
  // every other device obeys a tombstone (issue #91), so the record goes and
  // nothing is published for either name.
  assert.equal(state.fileByPath("Notes/Secret.md"), undefined, "the record for the moved note is dropped");
  assert.ok(
    host.notices.some((notice) => notice.includes("moved out of the folders this device syncs")),
    host.notices.join(" | "),
  );
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
  // The note and the folder holding it, and nothing hidden: `.obsidian` and
  // every folder under it fail the same gate its files fail.
  assert.deepEqual(
    (await postedPaths(server, k)).sort(),
    ["Notes", "Notes/Secret.md"],
    "only the ordinary note and its folder were posted",
  );
  for (const request of server.requests) {
    assert.equal(clearFields(request.json).includes(KEYS.vrk), false, request.target);
  }

  // Startup reconciliation walks the same gate: the hidden files it sees are
  // counted as skipped, never queued.
  await engine.reconcile();
  await timers.run(1000);
  assert.ok(host.logs.some((line) => line.includes("reconcile decision=queued") && line.includes("skipped=2")));
  // And the scan cannot infer the deletion either: the note's absence from
  // `Notes/` is a move it already refused to publish.
  assert.equal(server.journal.filter((frame) => frame.deleted).length, 0, "the scan published a tombstone for a live note");
  // `.obsidian`, `.obsidian/plugins` and `.obsidian/plugins/obsync` fail the
  // same gate their files fail, and are counted apart from the files so the
  // two numbers stay readable (requirement 12).
  assert.ok(
    host.logs.some((line) => line.includes("reconcile decision=queued") && line.includes("folders_skipped=3")),
    host.logs.filter((line) => line.startsWith("reconcile")).join(" | "),
  );
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
  // The folder is what the link IS, so the host refuses the folder and the
  // file through it, exactly as `ObsidianHost.syncable` does.
  host.unsyncable.add("Linked/note.md");
  host.unsyncable.add("Linked");
  host.seed("Notes/ok.md", "an ordinary note", 1000);

  await engine.start();
  await timers.run(1000, () => state.fileByPath("Notes/ok.md") !== undefined);
  await timers.run(1000, () => state.folderByPath("Notes") !== undefined);
  assert.equal(state.fileByPath("Linked/note.md"), undefined, "reconciliation left it alone");
  assert.equal(state.folderByPath("Linked"), undefined, "and its folder was not published either");
  assert.equal(server.journal.length, 2, "only the ordinary note and its folder were posted");
  assert.ok(host.logs.some((line) => line.includes("reconcile decision=queued") && line.includes("skipped=1")));

  engine.changed("Linked/note.md");
  await timers.run(1000);
  assert.equal(server.journal.length, 2, "the watcher did not push it either");
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

/**
 * The scan lists the vault ONCE and then walks the state, and the pull path
 * writes between the two.
 *
 * `reconcileLocal` takes a listing, walks it, and then treats every recorded
 * path that listing did not contain as a file the vault no longer has -- which
 * is how an edit made while Obsidian was closed reaches the server, and is
 * right. But a version arriving from another device is written and recorded
 * while the scan is still walking, so its path is in the record and not in
 * the listing, and the inference names a file that is on the disk. The
 * tombstone that follows deletes it on EVERY device.
 *
 * The listing below is held open across exactly one pull, which is the same
 * interleaving a slow device reaches on its own: it was a hosted run of the
 * scope suite, on a loaded two-core runner, that produced it.
 */
test("a file the pull writes while the scan is listing is not published as a tombstone", async () => {
  const { host, server, state, context, keys: k } = await rig();
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
  host.seed("Notes/Here.md", "already here", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("Notes/Here.md") !== undefined);
  const posted = server.journal.length;

  const frame = await server.publish({
    fileId: "1a".repeat(16),
    path: "Notes/Arrived.md",
    bytes: enc("written by the other device\n"),
    mtime: 1757200001000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  const list = host.list.bind(host);
  let raced = false;
  host.list = async () => {
    const files = await list();
    // The listing is taken; the pull lands after it and before the state walk.
    if (!raced) {
      raced = true;
      assert.equal(await applyChange(context, frame), "applied");
    }
    return files;
  };

  await engine.reconcile();
  await timers.run(1000);

  assert.ok(raced, "the test never reached the window it exists for");
  assert.equal(host.text("Notes/Arrived.md"), "written by the other device\n");
  assert.notEqual(
    state.fileByPath("Notes/Arrived.md"),
    undefined,
    "the scan dropped the record of a file the pull had just written",
  );
  assert.deepEqual(
    server.journal.slice(posted).filter((frame) => frame.deleted),
    [],
    "the scan published a tombstone for a file that is on the disk",
  );
  assert.ok(
    host.logs.some((line) => line.includes("push path_class=tombstone decision=refused reason=file_present")),
    host.logs.filter((line) => line.includes("tombstone")).join(" | "),
  );
  engine.stop();
});

/**
 * The other half of the same guard: a deletion that is refused is still a
 * path with something at it, and something at a path is a CHANGE.
 *
 * A delete event queues a tombstone, and the file can be back before the
 * queue reaches it -- restored by the user, or written by the pull path a
 * moment later. Refusing the tombstone is only half an answer: the file that
 * is there now has bytes no version holds, and dropping the work would leave
 * them on this device alone until something else touched the file.
 */
test("a deletion refused because the file came back is published as the change it is", async () => {
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
  host.seed("Notes/Back.md", "the first text\n", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("Notes/Back.md") !== undefined);
  const first = state.fileByPath("Notes/Back.md").versionId;
  // BY FILE ID, not by position. From 1.1.0 the folder holding this note is
  // published as a record of its own (#104), so the note's versions are no
  // longer the whole journal and no longer at a fixed index in it.
  const noteId = state.fileByPath("Notes/Back.md").fileId;
  const posted = () => server.journal.filter((frame) => frame.file_id === noteId);

  host.files.delete("Notes/Back.md");
  // Back between the queue and the push, with text the server has never
  // seen: the window is the vault's, so the test opens it in the vault.
  const stat = host.stat.bind(host);
  let returned = false;
  host.stat = async (path) => {
    if (path === "Notes/Back.md" && !returned) {
      returned = true;
      host.seed("Notes/Back.md", "and the text it has now\n", 3000);
    }
    return stat(path);
  };
  engine.deleted("Notes/Back.md");

  // AND NOT BY THE PERIODIC SCAN. A dirty file is queued by the scan every
  // `SCAN_MS` (#101), so "a second version exists" is true even if the
  // refused deletion was dropped rather than republished as the change it
  // is. The scan count is taken here and asserted unchanged below, so what
  // is proved is this path and not that one.
  const queuedByScan = () =>
    host.logs.filter((line) => /^scan decision=queued .* queued=[1-9]/.test(line)).length;
  const scansBefore = queuedByScan();
  await timers.run(1000, () => posted().length === 2);
  assert.ok(returned, "the test never reached the window it exists for");
  assert.equal(queuedByScan(), scansBefore,
    "the periodic scan published this change, so nothing here proves the refusal was republished");

  assert.equal(posted().length, 2, "the change was never published");
  assert.notEqual(posted()[1].deleted, true, "a tombstone was posted for a file that is there");
  assert.equal(state.fileByPath("Notes/Back.md").versionId, posted()[1].version_id);
  assert.notEqual(state.fileByPath("Notes/Back.md").versionId, first, "the new text was not published");
  assert.ok(
    host.logs.some((line) => line.includes("push path_class=tombstone decision=refused reason=file_present")),
    host.logs.filter((line) => line.includes("tombstone")).join(" | "),
  );
  engine.stop();
});

test("a failed rename bookkeeping save is handled and stops the engine", async () => {
  const r = await rig(), timers = new FakeTimers();
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, timers });
  r.host.seed("Old.md", "stable content", 1000);
  await engine.start();
  await timers.run(1000, () => r.state.fileByPath("Old.md") !== undefined);
  r.state.save = async () => { throw new Error("fixture rename persistence failed"); };
  engine.renamed("Old.md", "New.md");
  await new Promise(setImmediate);
  assert.equal(engine.started, false);
  assert.ok(r.host.logs.includes("rename decision=failed reason=state_not_saved"));
});

/**
 * "Sync now" while a drain is already running (issue #121).
 *
 * `host.read` is the seam both tests below hold: a push that cannot read its
 * file cannot finish, so what the queue holds at every step is a fact rather
 * than a race. The engine takes its first batch in the same turn as the
 * enqueue that starts the drain, so one path is in flight and the rest of the
 * queue waits for the next batch of the SAME drain.
 */
function heldReads(host) {
  const gate = deferred();
  const reads = [];
  const real = host.read.bind(host);
  host.read = async (path) => {
    reads.push(path);
    await gate.promise;
    return real(path);
  };
  return { reads, release: () => { host.read = real; gate.resolve(); } };
}

/**
 * Hold the change feed's long poll open, as a server with nothing to report
 * holds it. The feed also posts an idle status for every page that carries
 * changes -- including this device's own versions coming back -- and the test
 * below uses the idle status as its seam, so the feed must not supply one.
 */
function parkedFeed(server) {
  const real = server.request;
  server.request = async (request) => {
    if (request.url.includes("/v1/changes?") && request.url.includes("wait=55")) return new Promise(() => {});
    return real(request);
  };
}

test("sync now waits for the drain already running, and says which decision it took", async () => {
  const rigged = await rig();
  const { host, server, state } = rigged;
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  await engine.start();
  await timers.run();

  const held = heldReads(host);
  host.seed("One.md", "the first note\n", 2000);
  host.seed("Two.md", "the second note\n", 2000);
  engine.changed("One.md");
  engine.changed("Two.md");
  await timers.run(1000, () => held.reads.length === 1);
  assert.equal(server.journal.length, 0, "the drain is running and has posted nothing yet");

  let resolved = false;
  const now = engine.syncNow().then(() => { resolved = true; });
  await timers.run();
  assert.equal(resolved, false, "sync now returned while the drain it asked for still held the queue");
  assert.equal(server.journal.length, 0);

  held.release();
  await timers.run(1000, () => resolved);
  await now;
  assert.equal(state.fileByPath("One.md") !== undefined, true, "the first queued path was pushed");
  assert.equal(state.fileByPath("Two.md") !== undefined, true, "and so was the second");
  assert.deepEqual((await postedPaths(server, rigged.keys)).sort(), ["One.md", "Two.md"]);
  assert.ok(
    host.logs.some((line) =>
      line.startsWith("sync_now decision=joined_running_drain queued=2 in_flight=1 follow_up=0")),
    host.logs.join(" | "),
  );

  // The other decision, so the line distinguishes two states rather than
  // always naming one: nothing queued, no drain running.
  await engine.syncNow();
  assert.ok(
    host.logs.some((line) => line.startsWith("sync_now decision=drained queued=0 in_flight=0 follow_up=0")),
    host.logs.join(" | "),
  );
  engine.stop();
});

test("sync now drains again for work queued after the drain it joined took its last batch", async () => {
  const rigged = await rig();
  const { host, server, state } = rigged;
  const timers = new FakeTimers();
  // The window a join cannot cover: the drain's loop has ended, so an
  // enqueue landing in it joins a drain that will never look at the queue
  // again. In the field that enqueue is a debounce timer, a settled vault
  // deletion or a rename firing in the turn between the drain finishing and
  // "Sync now" resuming; here it is a rename -- the one of the three a vault
  // event queues in the same turn, since a deletion now waits for the other
  // half of a move (#139) -- made from the idle status the drain posts
  // inside that same turn.
  let armed = false;
  parkedFeed(server);
  const engine = engineOf(rigged, timers, {
    onStatus: (status) => {
      if (status.kind !== "idle" || !armed) return;
      armed = false;
      host.files.set("Moved.md", host.files.get("Gone.md"));
      host.files.delete("Gone.md");
      engine.renamed("Gone.md", "Moved.md");
    },
  });
  host.seed("Gone.md", "renamed while the drain ran\n", 1000);
  await engine.start();
  await timers.run(1000, () => state.fileByPath("Gone.md") !== undefined);
  const goneId = state.fileByPath("Gone.md").fileId;

  const held = heldReads(host);
  host.seed("One.md", "the first note\n", 2000);
  host.seed("Two.md", "the second note\n", 2000);
  engine.changed("One.md");
  engine.changed("Two.md");
  await timers.run(1000, () => held.reads.length === 1);
  armed = true;

  let movedAtReturn = null;
  const now = engine.syncNow().then(() => {
    movedAtReturn = server.journal.filter((frame) => frame.file_id === goneId).length === 2;
  });
  held.release();
  await timers.run(1000, () => movedAtReturn !== null);
  await now;

  assert.equal(armed, false, "the rename really was queued inside that window");
  assert.equal(movedAtReturn, true, "sync now returned before the path queued mid-drain was pushed");
  assert.equal(state.fileByPath("Moved.md").fileId, goneId, "and the move was recorded");
  assert.equal(state.fileByPath("One.md") !== undefined, true);
  assert.equal(state.fileByPath("Two.md") !== undefined, true);
  assert.ok(
    host.logs.some((line) =>
      line.startsWith("sync_now decision=joined_running_drain queued=2 in_flight=1 follow_up=1")),
    host.logs.join(" | "),
  );
  engine.stop();
});
