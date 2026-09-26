/**
 * A case-only FOLDER rename between two devices, on a REAL case-folding
 * filesystem, driven by the engine's own feed and its periodic scan.
 *
 * WHY THIS FILE EXISTS. `case-rename.test.mjs` proves the same behaviour
 * against the hand-written vault, and a hand-written vault is exactly what
 * hid this defect: its `move` rewrote its own listing to the whole requested
 * path, so a per-file rename appeared to re-case a DIRECTORY component. No
 * filesystem does that. `rename(2)` resolves the directory components of its
 * destination -- a volume that folds case finds the directory by either
 * spelling and leaves the name it keeps alone -- and renames only the last
 * component, so the receiving device kept the old spelling on disk while its
 * records carried the new one, its scan published that difference back as a
 * rename, and the two devices bounced one rename between them every
 * `SCAN_MS` forever, re-downloading every note under the folder each time
 * (review round 1, finding 1; reproduced by the reviewer on this laptop's
 * APFS). The fake now models `rename(2)`; this file is the second, harder
 * proof: the REAL `ObsidianHost` over a REAL directory, with the real
 * `SyncEngine` above it.
 *
 * WHERE IT RUNS. Wherever the temporary directory's filesystem folds case,
 * which is detected here by creating `a` and asking for `A` -- macOS APFS and
 * the owner's laptop do; an ext4 CI runner does not, and there the two
 * spellings are two entries and there is nothing to converge. A filesystem
 * that keeps them apart therefore RECORDS a skip that names its subject, and
 * still asserts that the detection itself ran, so a detection that silently
 * broke cannot pass as a skip.
 *
 * WHAT IT DOES NOT PROVE. No vault events are delivered here: Obsidian's
 * watcher is the app's, and this harness is the filesystem plus the engine.
 * The echo suppression that answers those events is proved in
 * `case-rename.test.mjs` against the vault that fires them.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeTimers, KEYS, STEP_MS, published, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pushFile, pushFolder } = require("../build/sync/push.js");
const { SyncEngine, SCAN_MS } = require("../build/sync/engine.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);
const ONE = "ONE SENTINEL BODY\n";
const TWO = "TWO SENTINEL BODY\n";
const OTHER_DEVICE = "ffffffffffffffffffffffffffffffff";
const DOMAIN = "0123456789abcdef0123456789abcdef";

/** The subject a skip has to name, so a skipped run says what went untested. */
const SUBJECT =
  "a case-only folder rename applied by the engine's feed over a case-folding filesystem, " +
  "and the periodic scan that must not publish it back";

/**
 * Does this filesystem fold case? Asked of the filesystem the test will use,
 * by making one name and looking for the other -- never inferred from the
 * platform, because a macOS volume can be formatted either way.
 */
function foldsCase(root) {
  const at = join(root, "a");
  writeFileSync(at, "");
  const folds = existsSync(join(root, "A"));
  rmSync(at);
  return folds;
}

/** Every file under the vault root, with the spelling the DIRECTORY keeps. */
function walk(root, folder = "") {
  const out = { files: [], folders: [] };
  const at = folder === "" ? root : join(root, folder);
  for (const name of readdirSync(at)) {
    if (name.startsWith(".")) continue;
    const path = folder === "" ? name : `${folder}/${name}`;
    const found = statSync(join(root, path));
    if (found.isDirectory()) {
      out.folders.push(path);
      const below = walk(root, path);
      out.files.push(...below.files);
      out.folders.push(...below.folders);
    } else {
      out.files.push({ path, stat: { mtime: Math.round(found.mtimeMs), size: found.size } });
    }
  }
  return out;
}

/**
 * A CASE-FOLDING VOLUME over whatever the temporary directory is (#150), so a
 * test that needs one runs on an ext4 runner too: every path handed to the
 * filesystem resolves, one component at a time, to the entry the directory
 * keeps, exactly as APFS resolves it. Only a path's FIRST argument is folded,
 * which is every call the listing and a push make.
 */
function folding(root) {
  const real = (path) => {
    if (typeof path !== "string" || !path.startsWith(root)) return path;
    let at = root;
    for (const segment of path.slice(root.length).split(nodePath.sep).filter(Boolean)) {
      let names = [];
      try { names = readdirSync(at); } catch { /* not a directory: the call itself answers */ }
      at = join(at, names.includes(segment) ? segment : names.find((name) => name.toLowerCase() === segment.toLowerCase()) ?? segment);
    }
    return at;
  };
  return { promises: Object.fromEntries(Object.entries(fsPromises).map(([name, value]) =>
    [name, typeof value === "function" ? (path, ...rest) => value(real(path), ...rest) : value])) };
}

/**
 * A real vault directory under the real desktop host, with the rig's state,
 * server and keys behind it. The vault surface is Obsidian's, answered from
 * the filesystem: its index IS the directory here, which is what makes a
 * spelling the directory keeps and a spelling the record keeps comparable.
 */
async function vault(t, folderOnDisk, { fold = false } = {}) {
  const r = await rig();
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-realfs-case-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(box.home, { recursive: true, force: true });
  });
  const folds = fold || foldsCase(root);
  mkdirSync(join(root, folderOnDisk));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const logs = [];
  const notices = [];
  const adapter = {
    exists: async (path, sensitive) => {
      if (sensitive !== true) return existsSync(join(root, path));
      const at = path.lastIndexOf("/");
      const folder = at === -1 ? "" : path.slice(0, at);
      if (!existsSync(join(root, folder))) return false;
      return readdirSync(join(root, folder)).includes(path.slice(at + 1));
    },
    rename: async (from, to) => fsPromises.rename(join(root, from), join(root, to)),
    mkdir: async (path) => fsPromises.mkdir(join(root, path), { recursive: true }),
    stat: async (path) => {
      if (!existsSync(join(root, path))) return null;
      const found = statSync(join(root, path));
      return { type: found.isFile() ? "file" : "folder", mtime: Math.round(found.mtimeMs), size: found.size };
    },
    readBinary: async (path) => {
      const bytes = readFileSync(join(root, path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    writeBinary: async (path, data, options) => {
      writeFileSync(join(root, path), new Uint8Array(data));
      if (options?.mtime) utimesSync(join(root, path), options.mtime / 1000, options.mtime / 1000);
    },
    remove: (path) => fsPromises.unlink(join(root, path)),
    rmdir: (path) => fsPromises.rmdir(join(root, path)),
    list: async (path) => {
      const below = walk(root, path);
      return { files: below.files.map((file) => file.path), folders: below.folders };
    },
  };
  const { TFolder } = box.require("obsidian");
  const vaultApi = {
    adapter,
    getFiles: () => walk(root).files,
    getAllFolders: () => walk(root).folders.map((path) => ({ path })),
    // A FOLDER by the exact spelling the directory keeps, as Obsidian's index
    // holds it (#150); files, and every other spelling, are not looked up here.
    getAbstractFileByPath: (path) => (walk(root).folders.includes(path) ? Object.assign(new TFolder(), { path, children: [] }) : null),
    getFileByPath: (path) =>
      existsSync(join(root, path)) && statSync(join(root, path)).isFile() ? { path } : null,
    getFolderByPath: (path) =>
      existsSync(join(root, path)) && statSync(join(root, path)).isDirectory() ? { path } : null,
    createBinary: async (path, data, options) => {
      writeFileSync(join(root, path), new Uint8Array(data), { flag: "wx" });
      if (options?.mtime) utimesSync(join(root, path), options.mtime / 1000, options.mtime / 1000);
      const found = statSync(join(root, path));
      return { path, stat: { mtime: Math.round(found.mtimeMs), size: found.size } };
    },
  };
  const plugin = {
    state: r.state,
    log: (line) => logs.push(line),
    app: {
      vault: vaultApi,
      workspace: { getLeavesOfType: () => [] },
      fileManager: {
        trashFile: async (file) => {
          const target = join(root, file.path);
          if (statSync(target).isDirectory()) await fsPromises.rmdir(target);
          else await fsPromises.unlink(target);
        },
      },
    },
    manifest: { version: "1.1.0" },
    platformName: () => "macos",
    deviceName: () => "sentinel-device",
  };
  const host = new ObsidianHost(plugin, { base: root, path: nodePath, fs: fold ? folding(root) : { promises: fsPromises } });
  host.notify = (message) => notices.push(message);
  r.context.host = host;
  // The two counters an assertion about "nothing was downloaded" and one
  // about "the scan really ran" need; silence is not evidence of either.
  const counts = { fetched: 0, scans: 0 };
  const getChunk = r.transport.getChunk.bind(r.transport);
  r.transport.getChunk = async (...args) => {
    counts.fetched++;
    return getChunk(...args);
  };
  const scan = host.scan.bind(host);
  host.scan = async () => {
    counts.scans++;
    return scan();
  };
  const seed = (path, text, mtime) => {
    writeFileSync(join(root, path), text);
    utimesSync(join(root, path), mtime / 1000, mtime / 1000);
  };
  const names = () => readdirSync(root).filter((name) => !name.startsWith("."));
  return { ...r, root, host, folds, seed, names, logs, notices, counts, box };
}

/** The peer's folder record, exactly as `pushFolder` builds one. */
const folderRecord = async (r, path, { deleted = false, parents = [] } = {}) =>
  r.server.publishManifest({
    fileId: await c.folderFileId(r.keys.manifestKey, path),
    manifest: { v: 2, kind: "directory", path, domain: DOMAIN, size: 0, chunks: [], sha256: "", deleted },
    sids: [],
    parents,
    deviceId: OTHER_DEVICE,
    manifestKey: r.keys.manifestKey,
    bytes: 0,
  });

/** The peer's move of one note: the same bytes under the folder's new name. */
const movedNote = (r, record, path, body, mtime) =>
  r.server.publish({
    fileId: record.fileId,
    path,
    bytes: enc(body),
    mtime,
    parents: [record.versionId],
    domainKey: r.keys.domainKey,
    manifestKey: r.keys.manifestKey,
  });

/** Every version this device published for a note, oldest first. */
const versions = (r, fileId) => published(r.server, fileId, r.keys.manifestKey);

const story = (r) =>
  [`disk=${JSON.stringify(walk(r.root).files.map((file) => file.path))}`,
    `folders=${JSON.stringify(walk(r.root).folders)}`,
    `records=${JSON.stringify(Object.keys(r.state.data.files))}`,
    `journal=${r.server.journal.length}`,
    `scans=${r.counts.scans}`,
    `fetched=${r.counts.fetched}`].join(" ");

/**
 * Both directions, because the defect was symmetric: the device that made
 * the rename applied the bounce back as another no-op and published again.
 */
const directions = [
  { onDisk: "Team docs", incoming: "team docs" },
  { onDisk: "team docs", incoming: "Team docs" },
];

for (const { onDisk, incoming } of directions) {
  test(`real filesystem: a peer's case-only folder rename (${onDisk} -> ${incoming}) is applied to the DIRECTORY and never published back`, async (t) => {
    const r = await vault(t, onDisk);
    if (!r.folds) {
      // A skip that says what went untested, and proves its own detection ran
      // rather than having thrown or answered nothing.
      assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
      assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
      t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
      t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
      return;
    }
    r.seed(`${onDisk}/One.md`, ONE, 1000);
    r.seed(`${onDisk}/Two.md`, TWO, 1000);
    await pushFile(r.context, `${onDisk}/One.md`);
    await pushFile(r.context, `${onDisk}/Two.md`);
    const one = r.state.fileByPath(`${onDisk}/One.md`);
    const two = r.state.fileByPath(`${onDisk}/Two.md`);

    // The peer renames the folder by capitalisation alone. A device on this
    // version publishes the FOLDER record first and the moves under it after
    // (`main.ts`), because only the folder record can re-case a directory.
    const created = await folderRecord(r, onDisk);
    await folderRecord(r, onDisk, { deleted: true, parents: [created.version_id] });
    await folderRecord(r, incoming);
    await movedNote(r, one, `${incoming}/One.md`, ONE, 1000);
    await movedNote(r, two, `${incoming}/Two.md`, TWO, 1000);

    const timers = new FakeTimers();
    const engine = new SyncEngine({
      state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
    });
    t.after(async () => {
      engine.stop();
      r.server.releaseFeed();
      await engine.stopAndWait();
    });
    await engine.start();
    await timers.run(STEP_MS, () =>
      r.state.pathByFileId(one.fileId) === `${incoming}/One.md` &&
      r.state.pathByFileId(two.fileId) === `${incoming}/Two.md`);

    // THE DIRECTORY ENTRY ITSELF, which is the whole repair: `readdir` is the
    // filesystem's own answer, not the record's and not the manifest's.
    assert.deepEqual(r.names(), [incoming], `the directory kept its old spelling: ${story(r)}`);
    assert.equal(readFileSync(join(r.root, `${incoming}/One.md`), "utf8"), ONE, story(r));
    assert.equal(readFileSync(join(r.root, `${incoming}/Two.md`), "utf8"), TWO, story(r));
    assert.equal(r.counts.fetched, 0, `a rename that changed no byte downloaded one: ${story(r)}`);
    assert.ok(
      r.logs.some((line) => line.includes("path_class=folder") && line.includes("decision=case_renamed")),
      r.logs.filter((line) => line.startsWith("folder")).join(" | "),
    );

    // TWO FULL SCAN CYCLES. The bounce was one new version per note per
    // `SCAN_MS` on both devices; two cycles with a frozen journal is the
    // assertion that answers it.
    const settled = r.server.journal.length;
    const scansBefore = r.counts.scans;
    await timers.run(SCAN_MS);
    await timers.run(SCAN_MS);

    assert.ok(r.counts.scans >= scansBefore + 2, `the periodic scan did not run: ${story(r)}`);
    assert.equal(r.server.journal.length, settled, `the scan published the rename back: ${story(r)}`);
    assert.equal(
      r.logs.filter((line) => line.startsWith("scan decision=queued")).every((line) => line.includes("moved=0")),
      true,
      r.logs.filter((line) => line.startsWith("scan")).join(" | "),
    );
    // ONE VERSION PER NOTE for what this device did: its own push and the
    // peer's move, and nothing of its own after that.
    for (const record of [one, two]) {
      const all = await versions(r, record.fileId);
      assert.equal(all.length, 2, `a note grew a version per scan: ${story(r)}`);
      assert.equal(all[all.length - 1].path, `${incoming}/${all[all.length - 1].path.split("/")[1]}`, story(r));
    }
    assert.deepEqual(
      Object.keys(r.state.data.files).sort(),
      [`${incoming}/One.md`, `${incoming}/Two.md`],
      `the records disagree with the directory: ${story(r)}`,
    );
    assert.equal(r.counts.fetched, 0, `the scan cycles downloaded something: ${story(r)}`);
  });
}

test("real filesystem: a case-only folder move from a device that publishes no folder record changes nothing, and is not published back", async (t) => {
  const r = await vault(t, "Team docs");
  if (!r.folds) {
    assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
    assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
    t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
    t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
    return;
  }
  r.seed("Team docs/One.md", ONE, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const one = r.state.fileByPath("Team docs/One.md");

  // A device older than 1.1.0 publishes no folder record at all: the rename
  // reaches this device as the moves alone, and a note's version does not
  // get to re-case a directory that holds other notes.
  await movedNote(r, one, "team docs/One.md", ONE, 1000);

  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
  });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  await engine.start();
  await timers.run(STEP_MS, () =>
    r.logs.some((line) => line.includes("decision=case_move_refused")));

  assert.deepEqual(r.names(), ["Team docs"], `the directory was re-cased by a note's move: ${story(r)}`);
  assert.equal(r.state.pathByFileId(one.fileId), "Team docs/One.md", `the record left the directory behind: ${story(r)}`);
  assert.equal(r.state.fileByPath("Team docs/One.md").versionId, one.versionId, story(r));
  assert.equal(r.counts.fetched, 0, `a refused move downloaded the note: ${story(r)}`);
  assert.equal(
    r.notices.filter((message) => message.includes("capitalisation")).length,
    1,
    `the user was told ${r.notices.length} times, or not at all: ${r.notices.join(" | ")}`,
  );

  const settled = r.server.journal.length;
  const scansBefore = r.counts.scans;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.ok(r.counts.scans >= scansBefore + 2, `the periodic scan did not run: ${story(r)}`);
  assert.equal(r.server.journal.length, settled, `the refusal was published back as a rename: ${story(r)}`);
  assert.equal((await versions(r, one.fileId)).length, 2, `the note grew a version: ${story(r)}`);
});

/**
 * A NOTE CREATED ON THE OTHER DEVICE WHILE THE TWO SPELL THE FOLDER
 * DIFFERENTLY (review round 2, finding 3).
 *
 * The refusal path covers the notes this device already TRACKS: their moves
 * are refused, nothing is written, and the records stay where the vault shows
 * them. A note this device has never seen is not refused -- it is a new file
 * id, it belongs in the vault, and it is written. The directory it lands in
 * is the one this vault shows, because creating a directory that is already
 * there changes nothing; the record used to take the manifest's spelling
 * instead, so the very next scan paired the difference as a move and this
 * device published a rename the other one never made. A device that folds
 * case answers that rename with a conflict copy, so both devices gained a
 * duplicate of every note created in that folder. The record now follows the
 * vault (`pull.ts`, `landedAt`), and the scan declines the pairing whatever a
 * record says (`engine.ts`, `recordsOnly`).
 */
test("real filesystem: a NEW note from a device that publishes no folder record lands under the folder this vault shows, and nothing is published back", async (t) => {
  const r = await vault(t, "Team docs");
  if (!r.folds) {
    assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
    assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
    t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
    t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
    return;
  }
  r.seed("Team docs/One.md", ONE, 1000);
  await pushFile(r.context, "Team docs/One.md");
  const newId = "1234567890abcdef1234567890abcdef";
  await r.server.publish({
    fileId: newId, path: "team docs/New.md", bytes: enc(TWO), mtime: 1500, parents: [],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
  });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  await engine.start();
  await timers.run(STEP_MS, () =>
    r.state.pathByFileId(newId) !== undefined && r.state.folderByPath("Team docs") !== undefined);

  const settledAt = r.server.journal.length;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(
    r.state.pathByFileId(newId),
    "Team docs/New.md",
    `the record spells the folder a way the vault does not show: ${story(r)}`,
  );
  assert.deepEqual(
    walk(r.root).files.map((file) => file.path).sort(),
    ["Team docs/New.md", "Team docs/One.md"],
    `the note landed somewhere else: ${story(r)}`,
  );
  assert.equal(readFileSync(join(r.root, "Team docs/New.md"), "utf8"), TWO, story(r));
  assert.equal(
    r.server.journal.length,
    settledAt,
    `this device published a rename the peer never made: ${story(r)}`,
  );
});

/**
 * THE ECHO MARKS A RE-CASE ARMS, ON A HOST THAT REPORTS NOTHING (review round
 * 2, finding 5).
 *
 * `recaseFolder` marks every file it moves and every folder record it carries
 * before it renames the directory, because on a vault that answers back each
 * one returns as a vault event and an unmarked event is published straight
 * back at the device that made the rename. This harness has no watcher at all
 * -- and neither, for this operation, does the real desktop app: the fan-out
 * in `main.ts` finds no records under the old prefix by the time Obsidian
 * notices, if it notices. The marks were then left armed for events that
 * never come, and the next genuine rename, deletion or creation of exactly
 * those paths was suppressed instead. They are now bounded by one whole scan
 * cycle: the second pass that still finds one expires it, and says how many.
 */
test("real filesystem: the echo marks a re-case arms for events this host never reports expire with the next scans", async (t) => {
  const r = await vault(t, "Team docs");
  if (!r.folds) {
    assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
    assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
    t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
    t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
    return;
  }
  mkdirSync(join(r.root, "Team docs/Sub"));
  r.seed("Team docs/One.md", ONE, 1000);
  r.seed("Team docs/Sub/Two.md", TWO, 1000);
  await pushFile(r.context, "Team docs/One.md");
  await pushFile(r.context, "Team docs/Sub/Two.md");
  const one = r.state.fileByPath("Team docs/One.md");
  const two = r.state.fileByPath("Team docs/Sub/Two.md");
  const created = await folderRecord(r, "Team docs");
  await folderRecord(r, "Team docs/Sub");
  await folderRecord(r, "Team docs", { deleted: true, parents: [created.version_id] });
  await folderRecord(r, "team docs");
  await movedNote(r, one, "team docs/One.md", ONE, 1000);
  await movedNote(r, two, "team docs/Sub/Two.md", TWO, 1000);

  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
  });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  await engine.start();
  await timers.run(STEP_MS, () => r.state.pathByFileId(one.fileId) === "team docs/One.md");
  const context = engine.context;

  // The defect's own shape, recorded before it is repaired: marks armed for
  // events that are never coming.
  assert.ok(
    context.moved.size + context.trashed.size + context.createdFolders.size > 0,
    `nothing was armed, so this test proves nothing: ${story(r)}`,
  );
  assert.deepEqual(r.names(), ["team docs"], `the directory kept its old spelling: ${story(r)}`);

  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(context.moved.size, 0, `a file echo stayed armed: ${story(r)}`);
  assert.equal(context.trashed.size, 0, `a folder tombstone echo stayed armed: ${story(r)}`);
  assert.equal(context.createdFolders.size, 0, `a folder creation echo stayed armed: ${story(r)}`);
  assert.ok(
    r.logs.some((line) => line.includes("decision=echo_expired")),
    r.logs.filter((line) => line.startsWith("scan")).join(" | "),
  );
});

/**
 * THE WRITE ITSELF, with no scan anywhere near it. The pass above proves the
 * device publishes nothing; this proves the record is right the moment it is
 * written, which is what keeps the pairing from ever arising.
 */
test("real filesystem: a file written into a folder this vault spells another way is recorded the way the vault spells it", async (t) => {
  const r = await vault(t, "Team docs");
  if (!r.folds) {
    assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
    assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
    t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
    t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
    return;
  }
  const newId = "1234567890abcdef1234567890abcdef";
  const change = await r.server.publish({
    fileId: newId, path: "team docs/New.md", bytes: enc(TWO), mtime: 1500, parents: [],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });

  assert.equal(await applyChange(r.context, change), "applied");

  assert.equal(
    r.state.pathByFileId(newId),
    "Team docs/New.md",
    `the record took the manifest's spelling: ${story(r)}`,
  );
  assert.deepEqual(
    walk(r.root).files.map((file) => file.path),
    ["Team docs/New.md"],
    `the note landed somewhere else: ${story(r)}`,
  );
  assert.equal(readFileSync(join(r.root, "Team docs/New.md"), "utf8"), TWO, story(r));
  assert.deepEqual(walk(r.root).folders, ["Team docs"], `a second directory was created: ${story(r)}`);
});

/**
 * AN EMPTY FOLDER, AND THE TWO ORDERS ITS RECORDS CAN ARRIVE IN (review
 * round 3, finding 2).
 *
 * A folder with nothing in it is the one case where a tombstone for the old
 * spelling can reach a folding receiver with the new spelling already on
 * disk -- there are no files to keep it non-empty and no moves to order it
 * against. `trashFolder` resolves the name it is given to the ONE directory
 * entry this filesystem holds, so the tombstone for `Team docs` was aimed at
 * the folder the re-case had just produced: real APFS, real `ObsidianHost`,
 * and `readdir` empty afterwards while the record for the new spelling
 * survived -- which this device's next pass then tombstoned, so the folder
 * was gone on every device.
 *
 * Both orders are proved here because both occur: the handler's order for a
 * rename Obsidian reported, and -- until this repair -- the reverse for one
 * the start-up pass discovered. The sender now emits the handler's order in
 * both cases (`engine.ts`, `recaseFolders`); the receiver must hold either
 * way, because a device on any earlier 1.1.0 build sends the other one.
 */
for (const [order, reversed] of [["tombstone then record", false], ["record then tombstone", true]]) {
  test(`real filesystem: an EMPTY folder re-cased by a peer survives, whatever the order (${order})`, async (t) => {
    const r = await vault(t, "Team docs");
    if (!r.folds) {
      assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
      assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
      t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
      t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
      return;
    }
    // This device holds the folder and its record, exactly as a device that
    // has run 1.1.0 once does; nothing is inside it.
    await pushFolder(r.context, "Team docs");
    const created = r.state.data.folders["Team docs"];
    assert.ok(created !== undefined, "the folder record was never published");
    const published = r.server.journal.length;

    const tombstone = async () => folderRecord(r, "Team docs", { deleted: true, parents: [created.versionId] });
    const record = async () => folderRecord(r, "team docs");
    if (reversed) { await record(); await tombstone(); } else { await tombstone(); await record(); }

    const timers = new FakeTimers();
    const engine = new SyncEngine({
      state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
    });
    t.after(async () => {
      engine.stop();
      r.server.releaseFeed();
      await engine.stopAndWait();
    });
    await engine.start();
    // WAITED FOR THE WHOLE FEED, not for the first of the two frames: the
    // one that deleted the folder was the SECOND, and a test that stopped at
    // the first would assert before the damage.
    const last = r.server.journal[r.server.journal.length - 1].seq;
    await timers.run(STEP_MS, () => r.state.data.lastSeq >= last);

    // THE DIRECTORY ITSELF, from `readdir`: the folder is still here, under
    // the name the peer gave it.
    assert.deepEqual(r.names(), ["team docs"], `the folder was deleted: ${story(r)}`);
    assert.equal(r.state.data.folders["Team docs"], undefined, `the old record outlived the rename: ${story(r)}`);
    if (reversed) {
      assert.ok(
        r.logs.some((line) => line.includes("decision=kept") && line.includes("reason=vault_spelling")),
        r.logs.filter((line) => line.startsWith("folder")).join(" | "),
      );
    }

    // AND THIS DEVICE NEVER TELLS THE OTHERS THE FOLDER IS GONE. Two whole
    // scan cycles: the pass that reads Obsidian's own index is the one that
    // tombstoned the record it had just written.
    const settled = r.server.journal.length;
    await timers.run(SCAN_MS);
    await timers.run(SCAN_MS);
    assert.deepEqual(r.names(), ["team docs"], `a later pass removed the folder: ${story(r)}`);
    assert.equal(
      r.server.journal.length,
      settled,
      `this device published something about the folder: ${r.server.journal.slice(published).map((frame) => `${frame.seq}${frame.deleted ? ":tombstone" : ""}`).join(",")}`,
    );
    assert.equal(r.counts.fetched, 0, `a folder rename downloaded something: ${story(r)}`);
  });
}

/**
 * THE WRITE MARKS A PULL LEAVES BEHIND, and the one that is never consumed
 * (review round 3, finding 4c).
 *
 * `landedAt` registers the echo key under BOTH spellings of a file that
 * landed in a directory this vault spells another way, because which of them
 * the vault reports back is the vault's business. One is consumed by the
 * watcher event; the other never is, and it stayed in the set until the
 * plugin was reloaded -- harmless, because only an identical `mtime:size` at
 * that exact path could ever consume it, and unbounded, which is the part
 * that is not allowed. The sweep that bounds every other mark now bounds
 * these too. It takes a real filesystem to produce the pair at all: the
 * folding of a DIRECTORY component on the way to a write is the thing the
 * hand-written vault does not have.
 */
test("real filesystem: the write marks a pull leaves behind expire with the next scan cycles", async (t) => {
  const r = await vault(t, "Team docs");
  if (!r.folds) {
    assert.equal(typeof r.folds, "boolean", "the case-folding detection did not run");
    assert.equal(foldsCase(r.root), false, "the detection disagrees with itself");
    t.diagnostic(`skipped: this filesystem keeps two spellings apart, so ${SUBJECT} cannot occur here`);
    t.skip(`case-sensitive filesystem; untested here: ${SUBJECT}`);
    return;
  }
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
  });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  await engine.start();
  const context = engine.context;

  // A NEW note from a device that spells the folder the other way, applied by
  // the ENGINE'S OWN FEED: this engine is running, and a second writer racing
  // its feed for one path is a fixture defect rather than a test.
  const newId = "1234567890abcdef1234567890abcdef";
  await r.server.publish({
    fileId: newId, path: "team docs/New.md", bytes: enc(TWO), mtime: 1500, parents: [],
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  await timers.run(STEP_MS, () => r.state.pathByFileId(newId) !== undefined);
  assert.equal(r.state.pathByFileId(newId), "Team docs/New.md", `the record took the manifest's spelling: ${story(r)}`);
  assert.equal(context.written.size, 2, `only one spelling was armed, so this test proves nothing: ${story(r)}`);

  const settled = r.server.journal.length;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.equal(context.written.size, 0, `a write mark outlived two scan cycles: ${story(r)}`);
  assert.ok(
    r.logs.some((line) => line.includes("decision=echo_expired")),
    r.logs.filter((line) => line.startsWith("scan")).join(" | "),
  );
  // The cost of expiring one, measured: nothing on the wire, because a push
  // of a file whose recorded digest has not changed posts nothing.
  assert.equal(r.server.journal.length, settled, `expiring a write mark published a version: ${story(r)}`);
});

/**
 * A SELECTION TYPED IN ANOTHER CASE THAN THE VAULT'S FOLDER (#150, S30a).
 *
 * `notes`, typed for the real `Notes` and saved by 1.1.2 as it was typed. On
 * a volume that folds case the scan's walk from the selection's own spelling
 * reached `Notes/` anyway and reported every note in it as `notes/...`: paths
 * no record held, so the device published the whole folder again under the
 * other spelling, carrying its OLDER text over the other device's newer edit.
 * The walk now starts only from a folder Obsidian's index holds under exactly
 * the selected name -- the question `list()` already asks -- so a selection
 * the vault spells differently syncs nothing from here, and publishes nothing.
 */
test("a selected folder typed in another case than the vault's is never walked, so nothing is published: 0 pushes", async (t) => {
  const r = await vault(t, "Notes", { fold: true });
  r.seed("Notes/x1.md", ONE, 1000);
  r.seed("Notes/x2.md", TWO, 1000);
  await pushFile(r.context, "Notes/x1.md");
  await pushFile(r.context, "Notes/x2.md");

  // The control: the vault's own spelling is walked, so a skip below is the rule and not a broken listing.
  r.state.data.syncFolders = ["Notes"];
  assert.deepEqual((await r.host.scan()).map((file) => file.path).sort(), ["Notes/x1.md", "Notes/x2.md"]);
  r.state.data.syncFolders = ["notes"];
  assert.deepEqual(await r.host.scan(), [], `the typed spelling was walked: ${story(r)}`);
  assert.ok(r.logs.includes("scan decision=skipped reason=not_a_vault_folder"), r.logs.join(" | "));

  const settled = r.server.journal.length;
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state: r.state, transport: r.transport, host: r.host, now: () => timers.now, timers,
  });
  t.after(async () => {
    engine.stop();
    r.server.releaseFeed();
    await engine.stopAndWait();
  });
  await engine.start();
  const scansBefore = r.counts.scans;
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);

  assert.ok(r.counts.scans >= scansBefore + 2, `the periodic scan did not run: ${story(r)}`);
  assert.equal(r.server.journal.length, settled, `the folder was published under the typed spelling: ${story(r)}`);
  assert.deepEqual(Object.keys(r.state.data.files).sort(), ["Notes/x1.md", "Notes/x2.md"], story(r));
  assert.deepEqual(walk(r.root).files.map((file) => file.path).sort(), ["Notes/x1.md", "Notes/x2.md"], story(r));
});
