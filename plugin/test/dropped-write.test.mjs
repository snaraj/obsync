/**
 * The empty file a phone's dropped write leaves is never sent, whatever becomes
 * of the parked record (#242; review of 90d2042, finding 2).
 *
 * The guard once lived in the parked record's reason, and two things change
 * that reason or end the record while the empty file still stands: a later
 * head too large to fetch under the pull lock goes to the download lane
 * (`downloading`), and a rename on another device lands the version under a
 * new name and releases the record. The reviewer's probes, kept as tests: a
 * zero-byte version under the original file id in the first case, and a new
 * zero-byte note under the old name in the second.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { DEVICE_B, FakeTimers, KEYS, STEP_MS, pair, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine, LARGE_APPLY_BYTES } = require("../build/sync/engine.js");
const { Transport } = require("../build/transport.js");
const { decodeRecordManifest } = require("../build/sync/pull.js");
const { pushDelete, pushFile } = require("../build/sync/push.js");
const { bytesSource, chunkStream } = require("../build/chunker.js");
const c = require("../build/crypto.js");

const ID = "17".repeat(16);
const PATH = "Notes/n17.md";
const NEXT = "Notes/renamed.md";
const enc = (text) => new TextEncoder().encode(text);

/**
 * What this device published after journal position `before` that would take
 * a note's text from every other device -- an empty version or a tombstone --
 * decrypted from the frames themselves.
 */
async function emptied(r, before) {
  const empty = [];
  for (const frame of r.server.journal.slice(before)) {
    if (frame.device_id !== KEYS.deviceId) continue;
    // DECRYPTED, NOT ADMITTED: every note frame is read whatever its path, and
    // a renamed selected folder's own tombstone -- which names a folder outside
    // the selection that followed it (issue #240) -- is no receiver's question.
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(
      r.keys.manifestKey, frame.file_id, binder, c.unhex(frame.manifest_nonce), c.unbase64(frame.manifest_ct),
    ));
    if (manifest.v === 1 && (manifest.deleted || manifest.size === 0)) empty.push({ path: manifest.path, fileId: frame.file_id, deleted: !!manifest.deleted });
  }
  return empty;
}

/**
 * A phone whose writes of `PATH` stay empty, with a download of it parked as
 * `write_dropped`. With `pushAt`, the watcher reads the empty file and its push
 * decides while the write is still under way: inside the commit, before the
 * refusal ("commit"), or inside the abort that follows it, before `park`
 * ("abort") -- where a loaded phone's slow writes let it happen (E6, live).
 */
async function dropped(t, existing, syncFolders = null, pushAt = null, code = "write_dropped") {
  const r = await rig({ isMobile: true });
  if (syncFolders !== null) r.state.data.syncFolders = syncFolders;
  const timers = new FakeTimers();
  let block = false, blocked = false, release;
  const wire = new Promise((done) => { release = done; });
  const transport = new Transport({
    request: async (request) => {
      const target = request.url.replace(/^https?:\/\/[^/]+/, "");
      if (block && ((request.method === "GET" && target.startsWith("/v1/chunks/")) ||
        (request.method === "POST" && target === "/v1/chunks/get"))) { blocked = true; await wire; }
      return r.server.request(request);
    },
    serverUrl: () => r.state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [], now: () => r.host.clock, sleep: async () => undefined, maxAttempts: 2,
  });
  const engine = new SyncEngine({ state: r.state, host: r.host, transport, timers, now: () => r.host.clock });
  t.after(async () => { engine.stop(); block = false; release(); await engine.stopAndWait(); });
  const foreign = (path, text, parents = []) => r.server.publish({ fileId: ID, path, bytes: enc(text),
    mtime: 1757200001000, parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  const base = existing ? await foreign(PATH, "original remote text") : null;
  r.host.seed("Notes/starter.md", "starter", 1000);
  await engine.start();
  await timers.run(1000, () => r.state.fileByPath("Notes/starter.md") !== undefined &&
    (!existing || r.host.text(PATH) === "original remote text"));
  const pushes = async () => {
    const logged = r.host.logs.length, posted = r.server.journal.length;
    engine.changed(PATH);
    for (let turn = 0; !r.host.logs.slice(logged).some((line) => line.startsWith("push ")) && r.server.journal.length === posted; turn++) {
      if (turn > 200000) throw new Error("the watcher's push never decided");
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path, size) => {
    const pending = await writer(path, size);
    if (path !== PATH) return pending;
    return { ...pending,
      commit: async () => {
        if (code === "write_dropped") r.host.seed(PATH, "", 9000);
        if (pushAt === "commit") await pushes();
        throw Object.assign(new Error(`${code}: sentinel`), { code });
      },
      abort: async () => {
        if (pushAt === "abort") await pushes();
        return pending.abort();
      } };
  };
  const beforeDrop = r.server.journal.length;
  const first = await foreign(PATH, "new remote text", base ? [base.version_id] : []);
  await timers.run(1000, () => r.state.data.lastSeq >= first.seq && r.state.data.parked[ID]?.reason === code);
  if (code === "write_dropped") assert.equal(r.host.text(PATH), "");
  return { ...r, timers, engine, foreign, first, writer, beforeDrop,
    block: () => { block = true; }, blocked: () => blocked,
    ours: () => r.server.journal.filter((frame) => frame.device_id === KEYS.deviceId && frame.file_id === ID) };
}

for (const existing of [false, true]) {
  test(`a rename on another device leaves the empty file unsent under the old name (existing=${existing})`, async (t) => {
    const r = await dropped(t, existing);
    const moved = await r.foreign(NEXT, "new remote text", [r.first.version_id]);
    await r.timers.run(1000, () => r.state.data.lastSeq >= moved.seq);
    r.host.writer = r.writer;
    const before = r.server.journal.length;
    if (r.host.text(PATH) !== null) await r.engine.pushOne(PATH);
    const empty = await emptied(r, before);
    assert.deepEqual(empty, [], `parked=${JSON.stringify(r.state.data.parked)} files=${JSON.stringify([...r.host.files.keys()])}`);
  });
}

for (const existing of [false, true]) {
  test(`a local rename takes the mark with the empty file, and it stays unsent (existing=${existing}, review of d62f201)`, async (t) => {
    const r = await dropped(t, existing);
    assert.equal(r.state.data.dropped[PATH], ID);
    const before = r.server.journal.length;
    assert.equal(await r.host.move(PATH, NEXT), "moved");
    r.engine.renamed(PATH, NEXT);
    await r.timers.run(1000);
    const empty = await emptied(r, before);
    assert.deepEqual(empty, [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    assert.deepEqual(r.state.data.dropped, { [NEXT]: ID });
    assert.deepEqual((await r.reload()).data.dropped, { [NEXT]: ID }, "the moved mark was not saved for the next start");
  });
}

test("a larger head sent to the download lane keeps the empty file unsent", async (t) => {
  const r = await dropped(t, true);
  const bytes = new Uint8Array(LARGE_APPLY_BYTES + 1).fill(73);
  const chunks = [];
  for await (const plaintext of chunkStream(bytesSource(bytes))) {
    const part = await c.encryptChunk(r.keys.domainKey, plaintext);
    r.server.chunks.set(part.sid, part.ciphertext);
    chunks.push({ sid: part.sid, cid: c.hex(part.cid), len: plaintext.length });
  }
  const manifest = { v: 1, path: PATH, size: bytes.length, mtime: 12000, domain: KEYS.domainId,
    chunks, sha256: c.hex(await c.sha256(bytes)), deleted: false };
  r.block();
  const large = await r.server.publishManifest({ fileId: ID, manifest, sids: chunks.map((chunk) => chunk.sid),
    parents: [r.first.version_id], deviceId: "ff".repeat(16), manifestKey: r.keys.manifestKey, bytes: bytes.length });
  await r.timers.run(1000, () => r.state.data.lastSeq >= large.seq && r.blocked());
  const parked = JSON.stringify(r.state.data.parked);
  const before = r.ours().length;
  let done = false;
  const pushing = r.engine.pushOne(PATH).catch(() => undefined).finally(() => { done = true; });
  await r.timers.run(1000, () => done || r.ours().length > before);
  assert.deepEqual(r.ours().slice(before).map((frame) => ({ bytes: frame.bytes, parents: frame.parents })), [],
    `the empty file was sent while parked=${parked}`);
  assert.ok(r.host.logs.includes(`push path_class=file decision=skipped reason=write_dropped file=${ID}`), r.host.logs.join(" | "));
  await pushing;
});

for (const existing of [false, true]) {
  test(`a folder renamed here takes the mark with the empty file under it (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing, ["Notes"]);
    const before = r.server.journal.length;
    const selection = r.state.data.syncFolders;
    assert.equal(await r.host.moveFolder("Notes", "Renamed"), "moved");
    r.engine.renamedFolder("Notes", "Renamed", selection);
    r.engine.folderRenamed("Notes", "Renamed", selection);
    await r.timers.run(1000);
    await r.engine.syncNow();
    await r.timers.run(1000);
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    assert.equal(r.state.data.dropped["Renamed/n17.md"], ID);
    assert.equal((await r.reload()).data.dropped["Renamed/n17.md"], ID, "the moved mark was not saved for the next start");
  });

  test(`a move out of the selected folders and back takes the mark with the empty file (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing, ["Notes"]);
    const before = r.server.journal.length;
    assert.equal(await r.host.move(PATH, "Outside/n17.md"), "moved");
    r.engine.renamed(PATH, "Outside/n17.md");
    await r.timers.run(10);
    assert.deepEqual((await r.reload()).data.dropped, { "Outside/n17.md": ID }, "the mark did not leave the selection with its file, saved");
    assert.equal(await r.host.move("Outside/n17.md", NEXT), "moved");
    r.engine.renamed("Outside/n17.md", NEXT);
    await r.timers.run(1000);
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    assert.deepEqual((await r.reload()).data.dropped, { [NEXT]: ID }, "the mark did not come back with its file, saved");
  });
}

for (const existing of [false, true]) {
  test(`deleting the empty file a dropped write left deletes nothing on other devices (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing);
    const before = r.server.journal.length;
    r.host.files.delete(PATH);
    r.engine.deleted(PATH);
    await r.timers.run(1000);
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    const next = await r.reload();
    assert.equal(next.fileByPath(PATH), undefined, "the placeholder's record was kept");
    assert.deepEqual(next.data.dropped, {}, "the placeholder's mark was kept");
  });

  // While the mark stands, deleting the file is local cleanup: text typed into
  // it and deleted before it was sent never left this device, and the note
  // stays on the server and every other device as they hold it.
  test(`text typed into the empty file and deleted before it was sent never leaves the device (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing);
    const before = r.server.journal.length;
    r.host.seed(PATH, "typed here, never sent", 9500);
    r.engine.changed(PATH);
    r.host.files.delete(PATH);
    r.engine.deleted(PATH);
    await r.timers.run(1000);
    assert.deepEqual(r.server.journal.slice(before).filter((frame) => frame.device_id === KEYS.deviceId), [], "this device posted something");
    const next = await r.reload();
    assert.equal(next.fileByPath(PATH), undefined);
    assert.deepEqual(next.data.dropped, {});
  });

  // Once a landed retry or a sent edit ends the mark, deletion is ordinary.
  test(`once the retry lands, deleting the note publishes its deletion (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing);
    r.host.writer = r.writer;
    await r.engine.syncNow();
    await r.timers.run(1000, () => Object.keys(r.state.data.parked).length === 0 && r.host.text(PATH) === "new remote text");
    assert.deepEqual(r.state.data.dropped, {}, "the landed retry left its mark");
    const before = r.server.journal.length;
    r.host.files.delete(PATH);
    r.engine.deleted(PATH);
    await r.timers.run(1000, () => r.server.journal.length > before);
    assert.deepEqual((await emptied(r, before)).map((entry) => [entry.fileId, entry.deleted]), [[ID, true]]);
  });

  test(`once typed text is sent, deleting the note publishes its deletion (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing);
    // Writes work again, as they do between Android's drops. With every write
    // still dropped, a held note's edit settles against the other device's
    // version by writing the merge, which drops and marks the file again:
    // the rule applying once more, not this case.
    r.host.writer = r.writer;
    const typed = r.server.journal.length;
    r.host.seed(PATH, "typed here and sent", 9500);
    r.engine.changed(PATH);
    // Sent, and everything it settles posted, before the deletion: a held
    // note's record exists throughout, so the mark ending alone is too early.
    // Small steps keep the virtual clock short of the parked retry.
    await r.timers.run(10, () => r.state.data.dropped[PATH] === undefined && r.server.journal.length > typed);
    await r.timers.run(10);
    assert.equal(r.state.data.dropped[PATH], undefined, "the file was marked again before the deletion");
    const sent = r.state.fileByPath(PATH).fileId;
    const before = r.server.journal.length;
    r.host.files.delete(PATH);
    r.engine.deleted(PATH);
    await r.timers.run(10, () => r.server.journal.length > before);
    await r.timers.run(10);
    assert.deepEqual((await emptied(r, before)).map((entry) => [entry.fileId, entry.deleted]), [[sent, true]]);
  });
}

test("with a mark standing at another name, a recorded note and an intentionally empty one each publish their deletion (review of 2e4cdca)", async (t) => {
  const r = await dropped(t, false);
  r.host.seed("Notes/blank.md", "", 9100);
  r.engine.changed("Notes/blank.md");
  await r.timers.run(1000, () => r.state.fileByPath("Notes/blank.md") !== undefined);
  const paths = ["Notes/starter.md", "Notes/blank.md"];
  const ids = paths.map((path) => r.state.fileByPath(path).fileId).sort();
  const before = r.server.journal.length;
  for (const path of paths) {
    r.host.files.delete(path);
    r.engine.deleted(path);
  }
  await r.timers.run(1000, () => r.server.journal.length >= before + 2);
  const deleted = (await emptied(r, before)).filter((entry) => entry.deleted).map((entry) => entry.fileId).sort();
  assert.deepEqual(deleted, ids);
  assert.equal(r.state.data.dropped[PATH], ID, "a deletion elsewhere ended the standing mark");
});

test("a note whose folder was renamed here, and whose retry the selection then released, is not deleted everywhere with its empty file (review of 2e4cdca)", async (t) => {
  const r = await dropped(t, true, ["Notes"]);
  const selection = r.state.data.syncFolders;
  assert.equal(await r.host.moveFolder("Notes", "Renamed"), "moved");
  r.engine.renamedFolder("Notes", "Renamed", selection);
  r.engine.folderRenamed("Notes", "Renamed", selection);
  await r.timers.run(1000);
  r.host.writer = r.writer;
  await r.engine.syncNow();
  await r.timers.run(2000, () => Object.keys(r.state.data.parked).length === 0);
  assert.equal(r.state.fileByPath("Renamed/n17.md")?.fileId, ID, "the record did not move with the folder");
  assert.equal(r.host.text("Renamed/n17.md"), "");
  const before = r.server.journal.length;
  r.host.files.delete("Renamed/n17.md");
  r.engine.deleted("Renamed/n17.md");
  await r.timers.run(1000);
  assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
});

// A folder deleted on the phone decides each dropped write's empty file under
// it as a file deletion does, through the plugin's own vault events: recorded
// or not, nothing is sent, and the mark and any record end, saved.
for (const existing of [false, true]) {
  test(`a folder deleted on a phone agrees with a file deletion for a dropped write's empty file (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const devices = await pair(t);
    const { a: desk, b: phone, timers } = devices;
    const NOTE = "Drop/n17.md";
    if (existing) desk.host.write(NOTE, "first text\n", 1000);
    desk.host.write("Notes/kept.md", "a note that stays\n", 1000);
    await desk.engine.start();
    await phone.engine.start();
    await timers.run(STEP_MS, () => phone.host.text("Notes/kept.md") !== null && (!existing || phone.host.text(NOTE) === "first text\n"));
    const writer = phone.host.writer.bind(phone.host);
    phone.host.writer = async (path, size) => {
      const pending = await writer(path, size);
      if (path !== NOTE) return pending;
      return { ...pending, commit: async () => {
        phone.host.seed(NOTE, "", 9000);
        throw Object.assign(new Error("write_dropped: sentinel"), { code: "write_dropped" });
      } };
    };
    desk.host.write(NOTE, "the desktop's text\n", 2000);
    await timers.run(STEP_MS, () => phone.state.data.dropped[NOTE] !== undefined && phone.host.text(NOTE) === "");
    const before = devices.server.journal.length;
    phone.host.removeFolder("Drop");
    await timers.run(STEP_MS, () => phone.host.logs.some((line) => line.includes("path_class=tombstone decision=skipped reason=write_dropped")));
    await timers.run(STEP_MS);
    const context = phone.engine.context;
    for (const frame of devices.server.journal.slice(before).filter((entry) => entry.device_id === DEVICE_B)) {
      const manifest = await decodeRecordManifest(context, frame);
      assert.notEqual(manifest.path, NOTE, `the phone posted ${JSON.stringify(manifest)}`);
    }
    assert.equal(desk.host.text(NOTE), "the desktop's text\n", "the note left the desktop");
    const next = await phone.reload();
    assert.equal(next.fileByPath(NOTE), undefined, "the placeholder's record was kept");
    assert.deepEqual(next.data.dropped, {}, "the placeholder's mark was kept");
  });
}

for (const existing of [false, true]) {
  test(`a delete reported while the empty file is still there keeps its mark, and it stays unsent (existing=${existing}, review of 2e4cdca)`, async (t) => {
    const r = await dropped(t, existing);
    const before = r.server.journal.length;
    r.engine.deleted(PATH);
    await r.timers.run(1000);
    assert.equal(r.host.text(PATH), "");
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    assert.equal(r.state.data.dropped[PATH], ID, "the mark ended while its empty file stood");
    assert.equal((await r.reload()).data.dropped[PATH], ID, "the standing mark was not kept for the next start");
  });
}

// The reviewer's interleaving: the person deletes the empty file while the
// deletion's own look at it is awaited. That look saw the file, so nothing is
// decided yet; the real delete event that follows is local cleanup.
for (const existing of [false, true]) {
  test(`a marked file deleted while the deletion looks at it stays local: one look decides (existing=${existing}, review of 5c9dc82)`, async (t) => {
    const r = await dropped(t, existing);
    const before = r.server.journal.length;
    const stat = r.host.stat.bind(r.host);
    let looks = 0;
    r.host.stat = async (path) => {
      const seen = await stat(path);
      if (path === PATH && looks++ === 0) {
        r.host.files.delete(PATH);
        r.engine.deleted(PATH);
      }
      return seen;
    };
    assert.equal(await pushDelete(r.engine.context, PATH), null);
    r.host.stat = stat;
    await r.timers.run(1000);
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
    const next = await r.reload();
    assert.equal(next.fileByPath(PATH), undefined, "the placeholder's record was kept");
    assert.deepEqual(next.data.dropped, {}, "the placeholder's mark was kept");
  });
}

// E6, live under load: the phone's three writes of an empty download took
// seconds, the watcher pushed the empty file between them, and the mark set at
// the refusal came too late. The name is marked from the first write.
for (const pushAt of ["commit", "abort"]) {
  for (const existing of [false, true]) {
    test(`a push that reads the empty file while the phone is still writing it sends nothing (${pushAt}, existing=${existing}, review of 5c9dc82)`, async (t) => {
      const r = await dropped(t, existing, null, pushAt);
      assert.ok(r.host.logs.some((line) => line.startsWith("push ") && line.includes("reason=write_dropped")), "the push under the write never decided");
      assert.deepEqual(await emptied(r, r.beforeDrop), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
      assert.equal(r.state.data.dropped[PATH], ID);
    });
  }
}

// The reviewer's interleaving (review of c4668d4): a push looks at a note that
// holds text, and a newer download of it is dropped while that look is
// awaited -- the guard's stat, or the push's own read. What the push sends is
// judged by the bytes it read and the mark as it stands after them.
for (const at of ["stat", "read"]) {
  test(`a download dropped while a push looks at the note sends nothing (${at}, review of c4668d4)`, async (t) => {
    const r = await dropped(t, true);
    const dropping = r.host.writer;
    r.host.writer = r.writer;
    await r.engine.syncNow();
    await r.timers.run(1000, () => Object.keys(r.state.data.parked).length === 0 && r.host.text(PATH) === "new remote text");
    r.host.writer = dropping;
    const look = r.host[at].bind(r.host);
    let armed = true, next = null;
    const drop = async () => {
      armed = false;
      next = await r.foreign(PATH, "newer remote text", [r.first.version_id]);
      await r.timers.run(1000, () => r.state.data.lastSeq >= next.seq && r.state.data.parked[ID]?.reason === "write_dropped");
    };
    r.host[at] = async (path, ...rest) => {
      if (at === "read" && path === PATH && armed) await drop();
      const seen = await look(path, ...rest);
      if (at === "stat" && path === PATH && armed) await drop();
      return seen;
    };
    const before = r.server.journal.length;
    await r.engine.pushOne(PATH);
    r.host[at] = look;
    assert.ok(next !== null && r.host.text(PATH) === "", "the download was not dropped under the push's look");
    const abandoned = r.host.logs.findIndex((line) => line.startsWith(`push path_class=file decision=abandoned reason=write_dropped file=${ID} `));
    assert.ok(abandoned >= 0, r.host.logs.join(" | "));
    // Nothing was sent, so the engine looks again, and this time sees the drop.
    const skipped = `push path_class=file decision=skipped reason=write_dropped file=${ID}`;
    await r.timers.run(10, () => r.host.logs.slice(abandoned).includes(skipped));
    assert.ok(r.host.logs.slice(abandoned).includes(skipped), "the push that read the drop was not looked at again");
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
  });
}

// Not every publication passes the engine's guard: restore's re-send, a held
// note's publication and a conflict copy call `pushFile` directly. It answers
// a dropped write's empty file itself: nothing is sent, and the caller is told
// to look again rather than that the note was published or unchanged.
for (const existing of [false, true]) {
  test(`pushFile itself sends nothing of a dropped write's empty file, and says to look again (existing=${existing}, review of c4668d4)`, async (t) => {
    const r = await dropped(t, existing);
    const before = r.server.journal.length;
    const outcome = await pushFile(r.engine.context, PATH, true);
    assert.deepEqual([outcome.status, outcome.versionId], ["growing", ""]);
    assert.deepEqual(await emptied(r, before), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
  });
}

// A write takes back only a mark it set itself: a retry that fails for another
// reason leaves the first drop's mark on the empty file, which stays unsent.
for (const existing of [false, true]) {
  test(`a retry that fails for another reason keeps the mark the first drop left (existing=${existing}, review of 5c9dc82)`, async (t) => {
    const r = await dropped(t, existing);
    const writer = r.writer;
    r.host.writer = async (path, size) => {
      const pending = await writer(path, size);
      if (path !== PATH) return pending;
      return { ...pending, commit: async () => { throw Object.assign(new Error("EBUSY: sentinel"), { code: "EBUSY" }); } };
    };
    await r.engine.syncNow();
    await r.timers.run(10, () => r.state.data.parked[ID]?.reason === "EBUSY");
    assert.equal(r.state.data.dropped[PATH], ID, "the failed retry took the first drop's mark");
    r.engine.changed(PATH);
    await r.timers.run(10, () => r.host.logs.some((line) => line.startsWith("push ") && line.includes("reason=write_dropped")));
    assert.deepEqual(await emptied(r, r.beforeDrop), [], `marked=${JSON.stringify(r.state.data.dropped)}`);
  });
}

// The early mark is this write's alone: a download that fails for another
// reason takes it back, and no mark is left on a name it never wrote.
for (const existing of [false, true]) {
  test(`a download that fails for another reason leaves no mark on its name (existing=${existing}, review of 5c9dc82)`, async (t) => {
    const r = await dropped(t, existing, null, null, "EBUSY");
    assert.equal(r.state.data.parked[ID]?.reason, "EBUSY");
    assert.deepEqual(r.state.data.dropped, {}, "a failed write left its early mark");
  });
}
