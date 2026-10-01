/**
 * The periodic filesystem scan, and the external move it exists for (#101).
 *
 * A note moved into a subfolder from outside Obsidian -- a file manager, or
 * `mv` while the desktop app is running -- took about four minutes to reach
 * the other device, while an external EDIT of the same note took seconds. The
 * end state was correct, so nothing was broken; the latency was.
 *
 * WHERE THE LATENCY WAS. The plugin's watcher is Obsidian's vault events, and
 * `VaultHost.list()` is Obsidian's vault INDEX. Both say the same thing at
 * the same moment: a change the app has not noticed yet is in neither. So a
 * periodic pass over `list()` converges nothing the watcher did not already
 * have, and the plugin had no other view of the vault at all -- until a
 * restart or Sync now. `ObsidianHost.scan()` is that other view on desktop:
 * one `readdir` per directory and one no-follow `lstat` per entry, which is
 * the only thing on the device that can see a move Obsidian has not.
 *
 * WHAT IS PROVEN HERE. The engine's convergence, bounded by `SCAN_MS`, and
 * the host's listing against a real temporary vault. What is NOT proven here
 * is Obsidian's own external-change detection latency on a real device: this
 * suite has no Obsidian, and the four minutes were measured on one. The
 * residual is stated in the pull request.
 *
 * PLATFORM. `scan()` is desktop only -- mobile reaches the vault solely
 * through the adapter and answers `null`, so the periodic pass there falls
 * back to Obsidian's listing and converges only what the watcher dropped.
 * Both are exercised below.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeTimers, KEYS, diskWatchdog, rig, sandbox, until } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SCAN_MS, SyncEngine } = require("../build/sync/engine.js");
const { applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const c = require("../build/crypto.js");

function engineOf({ host, server, state }, timers) {
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
      log: (line) => host.logs.push(line),
    }),
    host,
    now: () => host.clock,
    timers,
  });
}

/** Every path a version was published for, in order. */
async function postedPaths(server, k) {
  const paths = [];
  for (const frame of server.journal) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    const manifest = JSON.parse(await c.decryptManifest(
      k.manifestKey, frame.file_id, binder, c.unhex(frame.manifest_nonce), c.unbase64(frame.manifest_ct),
    ));
    paths.push({ path: manifest.path, deleted: manifest.deleted, fileId: frame.file_id, folder: manifest.v === 2 });
  }
  return paths;
}

/**
 * The NOTE versions among them. Folders are published in their own right
 * from 1.1.0 (#104), so startup reconciliation posts a record for every
 * folder this vault holds; these tests are about what happens to the notes,
 * and each one asserts separately that NOTHING was tombstoned, folders
 * included, so the split hides nothing.
 */
const notes = (posted) => posted.filter((version) => !version.folder);

/** How many NOTE versions the server holds. Folder records are not notes. */
const noteVersions = async (server, k) => notes(await postedPaths(server, k)).length;

/**
 * A host whose OWN listing is the filesystem and whose `list()` is a stale
 * index, which is exactly the shape the defect has on a real desktop.
 */
function withScan(host) {
  const truth = new Map();
  host.scan = async () => [...truth.entries()].map(([path, file]) => ({ path, mtime: file.mtime, size: file.bytes.length }));
  const index = new Map();
  host.list = async () => [...index.entries()].map(([path, file]) => ({ path, mtime: file.mtime, size: file.bytes.length }));
  return {
    /** Put a file in the vault and let the index know about it, as usual. */
    seed(path, text, mtime) {
      const file = { bytes: new TextEncoder().encode(text), mtime };
      host.files.set(path, file);
      truth.set(path, file);
      index.set(path, file);
    },
    /** Move a file with a tool Obsidian does not see: the index goes stale. */
    moveUnseen(from, to) {
      const file = truth.get(from);
      truth.delete(from);
      truth.set(to, file);
      host.files.delete(from);
      host.files.set(to, file);
    },
  };
}

test("a move Obsidian never reported converges as a MOVE within one scan", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  const vault = withScan(host);
  // Count the passes. What "within one scan" means is that the FIRST pass
  // after the move converged it, and that is a fact about the engine. The
  // virtual clock is not: see the assertion below.
  let scans = 0;
  const scanning = host.scan;
  host.scan = async () => {
    scans++;
    return await scanning();
  };
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  vault.seed("Notes/Moved.md", "the note that travels\n", 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/Moved.md") !== undefined);
  const fileId = state.fileByPath("Notes/Moved.md").fileId;
  const before = timers.now;

  // Passes that ran while the vault was still settling are not this move's.
  const scansBefore = scans;
  // `mv Notes/Moved.md Notes/Archive/Moved.md` outside the app: no vault
  // event, and Obsidian's index still lists the old path.
  vault.moveUnseen("Notes/Moved.md", "Notes/Archive/Moved.md");

  // The pass that converged it, captured AS it converges rather than after,
  // so a later pass cannot be counted against it.
  let scansToConverge = 0;
  await timers.run(1000, () => {
    if (scansToConverge === 0 && state.fileByPath("Notes/Archive/Moved.md") !== undefined) {
      scansToConverge = scans - scansBefore;
    }
    return scansToConverge !== 0;
  });
  await timers.run(1000, () => (state.fileByPath("Notes/Archive/Moved.md")?.mtime ?? -1) !== -1);
  const latency = timers.now - before;

  // WAIT ON WHAT IS ASSERTED, NOT ON A PROXY FOR IT. The record is written
  // when the scan decides; the version reaches the server a few turns later.
  // The assertions below are about the JOURNAL, so stopping at the record
  // asserts on a push still in flight -- which holds or not depending on how
  // many turns the apply took, a property of the machine rather than of the
  // product. The frame's `file_id` is in the clear, so this counts versions
  // of THIS note without decrypting anything: one for the original, one for
  // the move. `>=` rather than `==` because a count is sampled between
  // rounds and a test must not depend on catching one.
  const publishedHere = () => server.journal.filter((frame) => frame.file_id === fileId).length;
  await timers.run(1000, () => publishedHere() >= 2);
  engine.stop();

  assert.equal(state.fileByPath("Notes/Moved.md"), undefined, "the old path is forgotten");
  assert.equal(state.fileByPath("Notes/Archive/Moved.md").fileId, fileId, "the same file id moved");
  const posted = await postedPaths(server, k);
  assert.equal(posted.some((version) => version.deleted), false,
    "the scan published a tombstone, for a note or for a folder");
  assert.deepEqual(
    notes(posted).map((version) => `${version.deleted ? "-" : "+"}${version.path}`),
    ["+Notes/Moved.md", "+Notes/Archive/Moved.md"],
    "a move, never a tombstone and a new file",
  );
  assert.equal(new Set(notes(posted).map((version) => version.fileId)).size, 1, "one file id throughout");
  // THE CLAIM IS "WITHIN ONE SCAN", AND THIS IS HOW IT IS MEASURED. It used
  // to be `latency <= SCAN_MS + 5000`, and that bound is not a property of
  // the product: `latency` is VIRTUAL time, and `FakeTimers` advances the
  // virtual clock by `advanceMs` on every round that fires nothing, so the
  // number grows with how many idle rounds this machine needed -- which
  // grows with LOAD. Five rounds of headroom is what `+ 5000` bought, and a
  // loaded machine spends six: it failed at 36000 of 35000 with nothing
  // wrong, and any `not ok` is counted as a kill by the mutation runner, so
  // a bound like that manufactures kills on a busy CI box. The pass count
  // cannot drift that way. One scan noticed the move; the defect this test
  // is about took the scan out of the picture entirely and waited minutes
  // for something else to notice.
  assert.equal(
    scansToConverge, 1,
    `it took ${scansToConverge} scan passes to converge, ${latency} virtual ms of a ${SCAN_MS} ms interval`,
  );
  const line = host.logs.find((entry) => entry.startsWith("scan decision=queued"));
  assert.ok(line, host.logs.join(" | "));
  assert.match(line, /moved=1 removed=0/);
  assert.match(line, /budget_ms=\d+ duration_ms=\d+/);
  assert.ok(host.logs.some((entry) => /^scan decision=start interval_ms=\d+ budget_ms=\d+$/.test(entry)));
});

test("the periodic scan never publishes a tombstone, whatever its listing omits", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  const vault = withScan(host);
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  vault.seed("Notes/Kept.md", "a note nobody touched\n", 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/Kept.md") !== undefined);
  const versions = await noteVersions(server, rigged.keys);

  // A directory the scan could not read comes back as an absent file. It is
  // not a deletion, and the scan may never treat it as one.
  let scans = 0;
  host.scan = async () => { scans++; return []; };
  await timers.run(SCAN_MS, () => scans >= 2);
  await timers.run(1000);
  engine.stop();
  assert.ok(scans >= 2, `the scan really ran over the empty listing (${scans})`);

  assert.equal(await noteVersions(server, rigged.keys), versions, "no version was posted at all");
  assert.equal((await postedPaths(server, k)).some((version) => version.deleted), false);
  assert.notEqual(state.fileByPath("Notes/Kept.md"), undefined, "and the record is untouched");
});

test("two files sharing a size and an mtime are never paired as a move", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  const vault = withScan(host);
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  vault.seed("Notes/One.md", "same-length body\n", 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/One.md") !== undefined);

  // The note vanishes and TWO candidates appear with identical (mtime, size).
  // Guessing which one moved would publish the wrong path for the file id.
  vault.moveUnseen("Notes/One.md", "Notes/A.md");
  host.files.set("Notes/B.md", { bytes: new TextEncoder().encode("same-length body\n"), mtime: 1000 });
  const scan = host.scan;
  host.scan = async () => [...(await scan()), { path: "Notes/B.md", mtime: 1000, size: 17 }];

  await timers.run(1000, () => state.fileByPath("Notes/A.md") !== undefined && state.fileByPath("Notes/B.md") !== undefined);
  await timers.run(1000);
  engine.stop();

  const posted = await postedPaths(server, k);
  assert.equal(posted.some((version) => version.deleted), false, "the scan still publishes no tombstone");
  const ids = new Set(notes(posted).map((version) => version.fileId));
  assert.equal(ids.size, 3, "three file ids: the original and two new notes, none of them guessed");
  assert.ok(host.logs.some((line) => /^scan decision=queued .*moved=0 /.test(line)), host.logs.join(" | "));
});

// A note whose name carries an accent has two spellings on a Mac. Obsidian's
// index reports the composed one -- every path it hands out has been through
// `normalizePath`, which ends in `.normalize("NFC")` -- while a file manager
// writing that name through Cocoa leaves it DECOMPOSED on the volume, which
// is what `readdir` then reports. One note, two strings.
// Both are written as escapes on purpose: an editor that normalised this
// file would otherwise make them one string, and the tests below vacuous.
const NFC = "Notes/Espa\u00f1ol.md";
const NFD = "Notes/Espan\u0303ol.md";
const ACCENTED = "una nota con acento\n";

test("a listing that spells a recorded name differently is never a move", async () => {
  const rigged = await rig();
  const { host, server, state } = rigged;
  const vault = withScan(host);
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  vault.seed(NFC, ACCENTED, 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath(NFC) !== undefined);
  const fileId = state.fileByPath(NFC).fileId;
  const versions = await noteVersions(server, rigged.keys);

  // The host's own listing reports the decomposed spelling: the same bytes,
  // the same (mtime, size), a name the record has never held. Paired as a
  // move it would publish a rename to the other spelling, and the device
  // applying it writes one path and trashes the other -- the same file on
  // every volume that ignores the difference, so the note would be gone.
  let scans = 0;
  const listing = host.scan;
  host.scan = async () => { scans++; return listing(); };
  vault.moveUnseen(NFC, NFD);

  // Wait for the PASS, not for the line: a wait on the line would report a
  // removed refusal as a timeout instead of as the rename it published.
  await timers.run(SCAN_MS, () => scans >= 2);
  await timers.run(1000);
  engine.stop();

  assert.equal(await noteVersions(server, rigged.keys), versions,
    "no rename was published, and no version at all");
  assert.equal(state.fileByPath(NFD), undefined, "the other spelling was never queued");
  assert.equal(state.fileByPath(NFC)?.fileId, fileId, "and the record still holds the name Obsidian has");
  assert.ok(
    host.logs.includes("scan decision=skipped reason=normalisation_only files=1"),
    host.logs.join(" | "),
  );
  assert.equal(
    host.logs.some((line) => /^scan decision=queued .*moved=[1-9]/.test(line)),
    false,
    host.logs.join(" | "),
  );
});

test("a spelling twin is a candidate for nothing else either", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  const vault = withScan(host);
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  vault.seed(NFC, ACCENTED, 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath(NFC) !== undefined);
  const fileId = state.fileByPath(NFC).fileId;

  // The note is reported under its other spelling, and an unrelated note of
  // exactly the same (mtime, size) turns up in the same pass. The record is
  // not gone -- the twin IS it -- so pairing it with the newcomer would
  // publish a rename carrying the note to a name it has never had.
  vault.moveUnseen(NFC, NFD);
  vault.seed("Notes/Nueva.md", ACCENTED, 1000);

  await timers.run(1000, () => state.fileByPath("Notes/Nueva.md") !== undefined);
  await timers.run(1000, () => (state.fileByPath("Notes/Nueva.md")?.mtime ?? -1) !== -1);
  engine.stop();

  assert.equal(state.fileByPath(NFD), undefined, "the twin was never queued");
  assert.equal(state.fileByPath(NFC)?.fileId, fileId, "and the record never moved");
  const posted = await postedPaths(server, k);
  assert.equal(posted.some((version) => version.deleted), false,
    "the scan published a tombstone, for a note or for a folder");
  assert.deepEqual(
    notes(posted).map((version) => `${version.deleted ? "-" : "+"}${version.path}`),
    [`+${NFC}`, "+Notes/Nueva.md"],
  );
  assert.equal(new Set(notes(posted).map((version) => version.fileId)).size, 2, "two notes, two ids: nothing was renamed");
});

test("an accented note that really moved is still one rename", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  const vault = withScan(host);
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  const moved = "Notes/Archive/Espa\u00f1ol.md";

  vault.seed(NFC, ACCENTED, 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath(NFC) !== undefined);
  const fileId = state.fileByPath(NFC).fileId;

  // The same name, in the same spelling, in another folder: a real move, and
  // the refusal above must not swallow it.
  vault.moveUnseen(NFC, moved);

  await timers.run(1000, () => state.fileByPath(moved) !== undefined);
  await timers.run(1000, () => (state.fileByPath(moved)?.mtime ?? -1) !== -1);
  engine.stop();

  assert.equal(state.fileByPath(NFC), undefined, "the old path is forgotten");
  assert.equal(state.fileByPath(moved).fileId, fileId, "the same file id moved");
  const posted = await postedPaths(server, k);
  assert.equal(posted.some((version) => version.deleted), false,
    "the scan published a tombstone, for a note or for a folder");
  assert.deepEqual(
    notes(posted).map((version) => `${version.deleted ? "-" : "+"}${version.path}`),
    [`+${NFC}`, `+${moved}`],
    "exactly one rename, and never a tombstone",
  );
  assert.equal(host.logs.some((line) => line.includes("reason=normalisation_only")), false, host.logs.join(" | "));
  assert.ok(host.logs.some((line) => /^scan decision=queued .*moved=1 /.test(line)), host.logs.join(" | "));
});

test("a scan with nothing to say says nothing, and an overrun still speaks", async () => {
  const rigged = await rig();
  const { host, state } = rigged;
  withScan(host).seed("Notes/Quiet.md", "unchanged\n", 1000);
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/Quiet.md") !== undefined);
  host.logs.length = 0;

  await timers.run(SCAN_MS, () => timers.now > SCAN_MS * 2);
  engine.stop();

  assert.deepEqual(
    host.logs.filter((line) => line.startsWith("scan decision=queued")),
    [],
    "one line every 30 seconds about an unchanged vault buries the lines that matter",
  );
});

test("a host with no filesystem view of its own falls back to the vault listing", async () => {
  const rigged = await rig({ isMobile: true });
  const { host, state } = rigged;
  assert.equal(host.scan, undefined, "the fake mobile host has no scan, as the real one has none");
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  await engine.start();

  // A vault event the watcher dropped: the listing still has it, so the
  // periodic pass is what converges it.
  host.seed("Notes/Dropped.md", "never announced\n", 4000);
  await timers.run(1000, () => state.fileByPath("Notes/Dropped.md") !== undefined);
  engine.stop();
  assert.notEqual(state.fileByPath("Notes/Dropped.md"), undefined);
});

// --- the desktop host's own listing -----------------------------------------

function nativeHost(t, folders) {
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-scan-"));
  const outside = mkdtempSync(join(tmpdir(), "obsync-scan-outside-"));
  t.after(() => {
    rmSync(box.home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { TFolder } = box.require("obsidian");
  const logs = [];
  // Obsidian's index holds no FILE here, and a folder only under the exact
  // name its directory keeps: the scan walks a selected folder the index holds
  // (#150).
  const indexed = (path) => {
    try {
      return readdirSync(nodePath.dirname(join(root, path))).includes(nodePath.basename(path)) && statSync(join(root, path)).isDirectory();
    } catch {
      return false;
    }
  };
  const plugin = {
    state: { data: { syncFolders: folders } },
    app: { vault: { adapter: {}, getFiles: () => [], getAbstractFileByPath: (path) => (indexed(path) ? new TFolder() : null) } },
    log: (line) => logs.push(line),
  };
  const opened = [];
  const statted = [];
  const watched = {
    promises: {
      ...fs,
      readdir: async (path) => { opened.push(String(path)); return fs.readdir(path); },
      lstat: async (path, ...options) => { statted.push(String(path)); return fs.lstat(path, ...options); },
    },
  };
  const host = new ObsidianHost(plugin, { fs: watched, path: nodePath, base: root });
  return { host, root, outside, logs, plugin, opened, statted };
}

test("the desktop listing reads the filesystem, including a file the vault index has never seen", async (t) => {
  const { host, root } = nativeHost(t, undefined);
  mkdirSync(join(root, "Notes", "Archive"), { recursive: true });
  writeFileSync(join(root, "Notes", "Archive", "Moved.md"), "moved from outside\n");
  writeFileSync(join(root, "Top.md"), "at the root\n");

  const scanned = await host.scan();

  // `list()` is Obsidian's index and this stub has nothing in it; the scan
  // is the independent view, and that difference is the whole fix.
  assert.deepEqual(await host.list(), []);
  assert.deepEqual(
    scanned.map((file) => file.path).sort(),
    ["Notes/Archive/Moved.md", "Top.md"],
  );
  assert.equal(scanned.find((file) => file.path === "Top.md").size, 12);
  assert.ok(scanned.every((file) => Number.isInteger(file.mtime) && file.mtime > 0));
});

test("the desktop listing reports a decomposed name the way Obsidian's index holds it", async (t) => {
  const { host, root, statted } = nativeHost(t, undefined);
  mkdirSync(join(root, "Notes"), { recursive: true });
  // Written the way a Cocoa app writes it: the accent left decomposed.
  writeFileSync(join(root, "Notes", "Espan\u0303ol.md"), ACCENTED);

  // What this test rests on: the volume kept the name it was given. A volume
  // that composed it on the way in is not the case under test, and saying so
  // here is cheaper than an assertion below that could never fail.
  assert.deepEqual(await fs.readdir(join(root, "Notes")), ["Espan\u0303ol.md"]);

  const scanned = await host.scan();
  assert.deepEqual(scanned.map((file) => file.path), [NFC], "the listing speaks the index's spelling");
  assert.equal(scanned[0].size, Buffer.byteLength(ACCENTED));
  // And the syscall still took the name the directory gave: composing it
  // first works on a volume that ignores the difference and is a missing
  // file on one that does not.
  assert.ok(statted.includes(join(root, "Notes", "Espan\u0303ol.md")), statted.join(" | "));
  assert.equal(statted.includes(join(root, "Notes", "Espa\u00f1ol.md")), false, statted.join(" | "));
});

test("the desktop listing skips hidden names, symlinks and everything outside the selection", async (t) => {
  const { host, root, outside, logs, plugin, opened } = nativeHost(t, ["Notes"]);
  mkdirSync(join(root, "Notes"), { recursive: true });
  mkdirSync(join(root, "Other"), { recursive: true });
  mkdirSync(join(root, ".obsidian", "plugins"), { recursive: true });
  writeFileSync(join(root, "Notes", "Inside.md"), "inside the selection\n");
  // A hidden FILE inside a selected folder: the one shape the folder rule
  // cannot refuse, and the shape the plugin's own `data.json` has.
  writeFileSync(join(root, "Notes", ".hidden.md"), "a dotfile beside the notes\n");
  writeFileSync(join(root, "Other", "Outside.md"), "outside it\n");
  writeFileSync(join(root, ".obsidian", "plugins", "data.json"), "{}\n");
  writeFileSync(join(outside, "Elsewhere.md"), "not in the vault at all\n");
  symlinkSync(outside, join(root, "Notes", "Linked"));
  symlinkSync(join(outside, "Elsewhere.md"), join(root, "Notes", "Link.md"));

  assert.deepEqual((await host.scan()).map((file) => file.path), ["Notes/Inside.md"]);
  assert.deepEqual(opened, [join(root, "Notes")], "and nothing outside the selection was even enumerated");

  // The whole vault: still no hidden name, still no symlink, and the hidden
  // folder holding this plugin's own data.json is never opened at all.
  opened.length = 0;
  plugin.state.data.syncFolders = undefined;
  assert.deepEqual(
    (await host.scan()).map((file) => file.path).sort(),
    ["Notes/Inside.md", "Other/Outside.md"],
  );
  assert.equal(
    opened.some((path) => path.includes(".obsidian")),
    false,
    `the hidden folder was enumerated: ${opened.join(", ")}`,
  );
  assert.equal(logs.some((line) => line.includes(".obsidian")), false, "and no path reached the log");
});

test("a path the scan proposes is still refused by the filesystem gate before anything is queued", async () => {
  // The scan LISTS; `syncable` decides. Whatever a listing proposes -- a
  // path under a symlinked folder, a path a later refactor let through --
  // the engine walks every component of it before it queues anything, which
  // is the same gate the watcher and startup reconciliation pass.
  const rigged = await rig();
  const { host, server, state } = rigged;
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  host.seed("Notes/ok.md", "an ordinary note\n", 1000);
  host.seed("Linked/through.md", "behind a symlinked folder\n", 1000);
  host.unsyncable.add("Linked/through.md");
  host.scan = async () => [
    { path: "Notes/ok.md", mtime: 1000, size: 18 },
    { path: "Linked/through.md", mtime: 1000, size: 26 },
  ];

  await engine.start();
  await timers.run(1000, () => state.fileByPath("Notes/ok.md") !== undefined);
  await timers.run(SCAN_MS, () => host.logs.some((line) => line.startsWith("scan decision=queued")));
  engine.stop();

  assert.equal(state.fileByPath("Linked/through.md"), undefined, "it was never queued");
  assert.equal(await noteVersions(server, rigged.keys), 1, "and never published");
  assert.match(host.logs.find((line) => line.startsWith("scan decision=queued")), /skipped=[1-9]/);
});

test("a directory the desktop host cannot read is skipped and said, never reported empty", async (t) => {
  const { host, root } = nativeHost(t, undefined);
  const logs = [];
  mkdirSync(join(root, "Notes"), { recursive: true });
  writeFileSync(join(root, "Notes", "Readable.md"), "readable\n");
  const failing = {
    promises: {
      ...fs,
      readdir: async (path) => {
        if (String(path).endsWith("Notes")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return fs.readdir(path);
      },
    },
  };
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const blocked = new ObsidianHost(
    { state: { data: {} }, app: { vault: { adapter: {} } }, log: (line) => logs.push(line) },
    { fs: failing, path: nodePath, base: root },
  );

  assert.deepEqual(await blocked.scan(), [], "the unreadable subtree contributes nothing");
  assert.ok(logs.some((line) => line === "scan decision=skipped reason=unreadable_directory"), `logs=[${logs.join(" | ")}]`);
  assert.deepEqual((await host.scan()).map((file) => file.path), ["Notes/Readable.md"], "and a readable one still works");
});

test("a host with no Node filesystem has no listing of its own", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const host = new ObsidianHost({ state: { data: {} }, app: { vault: { adapter: {} } } }, null);
  assert.equal(await host.scan(), null, "mobile answers null and the engine falls back to the index");
});

test("the engine's stop ends a desktop walk at its next read of the disk: the scan rejects, the sweep removes nothing and says so (#287)", async (t) => {
  const { host, root, logs, opened, statted } = nativeHost(t, undefined);
  mkdirSync(join(root, "Notes", "Deep"), { recursive: true });
  writeFileSync(join(root, "Notes", "Deep", "a.md"), "a note\n");
  const temp = `.obsync-write-${"ab".repeat(8)}.tmp`;
  writeFileSync(join(root, temp), "left by a quit\n");

  // A stop the walk sees as the signal it is handed: aborted once `stopped()` holds.
  const stopWhen = (stopped) => ({ get aborted() { return stopped(); }, throwIfAborted() { if (stopped()) throw new Error("stopped"); } });
  const fresh = () => { opened.length = 0; statted.length = 0; };

  // Stopped before it began: nothing is read.
  await assert.rejects(host.scan(AbortSignal.abort()));
  assert.deepEqual([opened.length, statted.length], [0, 0], "a stopped walk read the disk");

  // Stopped once the first directory has been read: no entry of it is looked at.
  const afterRead = stopWhen(() => opened.length > 0);
  await assert.rejects(host.scan(afterRead), /stopped/);
  assert.deepEqual([opened.length, statted.length], [1, 0], "the walk read on after its stop");

  // Stopped inside a folder: the folders below it are not read.
  fresh();
  await assert.rejects(host.scan(stopWhen(() => opened.some((path) => path.endsWith(`${nodePath.sep}Notes`)))), /stopped/);
  assert.equal(opened.some((path) => path.endsWith("Deep")), false, "a subfolder was read after the stop");

  // A sweep stopped at its first read: nothing is looked at, and that is said.
  fresh();
  await host.sweep(afterRead);
  assert.equal(statted.length, 0, "the sweep's walk read on after its stop");
  assert.match(logs.at(-1), /^host path_class=temp decision=deferred reason=stopped files=0 duration_ms=\d+$/);

  // One stopped right after it found the temp: it is left for the next start.
  fresh();
  await host.sweep(stopWhen(() => statted.some((path) => path.endsWith(".tmp"))));
  assert.ok(readdirSync(root).includes(temp), "a stopped sweep removed a file");
  assert.match(logs.at(-1), /^host path_class=temp decision=deferred reason=stopped files=0 duration_ms=\d+$/);
  assert.equal(logs.some((line) => line.startsWith("host path_class=temp decision=removed")), false);
});

/**
 * One call that never answers, made by `outcome`'s operation: it is still
 * waiting a millisecond before its budget, fails with `disk_stalled` and one
 * line naming it at its budget, and the watchdog stops with nothing left in
 * flight. The clock is back at its start afterwards.
 */
const stallsAt = async (dog, label, outcome, name, budget, logs) => {
  assert.notEqual(dog.tick, null, `${label}: no watchdog is armed for the call`);
  const settled = () => Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20))]);
  dog.at(budget - 1);
  dog.tick();
  assert.equal(await settled(), "still waiting", `${label} failed before its budget of ${budget} ms`);
  dog.at(budget);
  dog.tick();
  const error = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting after its budget"), 2000))]);
  assert.equal(error?.code, "disk_stalled", `${label}: ${error === "answered" ? "went on past it" : `failed as ${error}`}`);
  assert.equal(error.message, "This device's disk did not answer in time. obsync tries again by itself.");
  assert.ok(logs.includes(`host decision=stalled call=${name} duration_ms=${budget} budget_ms=${budget}`), logs.join(" | "));
  assert.equal(dog.tick, null, `${label}: the watchdog runs on with nothing in flight`);
  dog.at(0);
};

/**
 * One change to the disk that never answers, made by `outcome`'s operation:
 * nothing is said a millisecond before its budget; at its budget one line
 * says it overran, the watchdog stops with nothing left to watch, and the
 * change is still awaited -- never failed, so no caller acts on a guess about
 * whether it landed (review of a0dc7fc2, finding 1). The clock is back at its
 * start afterwards.
 */
const overrunsAt = async (dog, label, outcome, name, budget, logs) => {
  assert.notEqual(dog.tick, null, `${label}: no watchdog is armed for the change`);
  const settled = () => Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20))]);
  dog.at(budget - 1);
  dog.tick();
  assert.equal(logs.some((line) => line.startsWith("host decision=overrun")), false, `${label} overran before its budget of ${budget} ms`);
  dog.at(budget);
  dog.tick();
  assert.ok(logs.includes(`host decision=overrun call=${name} duration_ms=${budget} budget_ms=${budget} outcome=awaited`), logs.join(" | "));
  assert.equal(await settled(), "still waiting", `${label} was let go at its budget`);
  assert.equal(dog.tick, null, `${label}: the watchdog runs on with nothing left to watch`);
  dog.at(0);
};

/**
 * A READ OF THE WALK THAT NEVER ANSWERS FAILS THE WALK (#302). Closing a
 * separate Settings window (Obsidian 1.13) focused the main one while it was
 * torn down, and the reads the focus walk made then never answered: the walk
 * held the pull chain, and the device received nothing until Obsidian
 * restarted. Each read has the seam's `DISK_CALL_MS` (#307); one that runs
 * out fails the scan and the sweep with a line naming the call, and is never
 * taken for an unreadable folder or a folder that is no vault, which the walk
 * goes past.
 */
test("a walk read that never answers fails the walk within its budget, never read as an unreadable folder or a plain one (#302)", async (t) => {
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-scan-stall-"));
  t.after(() => { rmSync(box.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, "Notes", "Sub", ".cfg"), { recursive: true });
  writeFileSync(join(root, "Notes", "a.md"), "a note\n");
  // One read, named by its path, never answers; every other read is the disk's.
  const hang = { readdir: null, lstat: null };
  const never = (kind, path) => {
    if (String(path) !== hang[kind]) return false;
    hang[kind] = null;
    return true;
  };
  const refused = new Set();
  const stalling = { promises: { ...fs,
    readdir: (path) => (never("readdir", path)
      ? new Promise(() => {})
      : refused.has(String(path)) ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) : fs.readdir(path)),
    lstat: (path, ...options) => (never("lstat", path) ? new Promise(() => {}) : fs.lstat(path, ...options)),
  } };
  const logs = [];
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const host = new ObsidianHost({ state: { data: {} }, app: { vault: { adapter: {} } }, log: (line) => logs.push(line) }, { fs: stalling, path: nodePath, base: root });
  const dog = diskWatchdog(t);

  // Every read that answered took its entry back, a refused one too.
  refused.add(join(root, "Notes", "Sub"));
  assert.deepEqual((await host.scan()).map((file) => file.path), ["Notes/a.md"]);
  assert.ok(logs.includes("scan decision=skipped reason=unreadable_directory"), logs.join(" | "));
  assert.notEqual(dog.tick, null, "the walk's reads armed no watchdog");
  dog.tick();
  assert.equal(dog.tick, null, "a read that answered left its entry in flight");
  refused.clear();

  const stalled = async (kind, path, walk) => {
    hang[kind] = path;
    logs.length = 0;
    const outcome = walk().then(() => "answered", (error) => error);
    await until(() => hang[kind] === null);
    assert.equal(hang[kind], null, `the walk never asked for ${kind} ${path}`);
    await stallsAt(dog, `the walk's ${kind} of ${path}`, outcome, kind, 15_000, logs);
    assert.equal(logs.includes("scan decision=skipped reason=unreadable_directory"), false, "a stall read as an unreadable folder");
  };
  await stalled("readdir", root, () => host.scan());
  await stalled("lstat", join(root, "Notes", "a.md"), () => host.scan());
  // The nested-vault check asks of a folder before the walk enters it.
  await stalled("readdir", join(root, "Notes", "Sub"), () => host.scan());
  await stalled("lstat", join(root, "Notes", "Sub", ".cfg"), () => host.scan());
  await stalled("readdir", root, () => host.sweep());
});

/**
 * EVERY DISK CALL OF THE DESKTOP HOST IS WATCHED (#307), AND ONLY A READ IS
 * LET GO. The walk's reads were bounded (#302), and then a first sync stopped
 * for good on the page apply's read of a file it compared: the calls in
 * flight when the Settings window closes never answer, whichever path made
 * them. So every call, and every call on a handle the seam opens, has 15 s,
 * plus a millisecond per KiB a read, a write or a sync moves. A read that
 * never answers fails at its budget; one that answers after it is logged, and
 * a handle it brings is closed. A CHANGE -- a create, a rename, a link, an
 * unlink, a write -- is logged at its budget and awaited still: it may have
 * landed, and what its caller releases next depends on which (review of
 * a0dc7fc2, finding 1). A call that answers in time answers as the disk does,
 * and takes its entry back.
 */
test("a read of the desktop filesystem seam fails at its budget when it never answers, a change is awaited past it, and each answers as the disk does, late too (#307)", async (t) => {
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-seam-stall-"));
  t.after(() => { rmSync(box.home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "a.md"), "a".repeat(5000));
  // Each call is the disk's, or held once `hang` names it and the calls of
  // that name it lets through first have been made; `release` then asks it of
  // the disk, late, and settles it as the disk answers.
  let hang = null;
  let release = null;
  const answer = (name, call) => {
    if (hang?.name !== name || hang.first-- > 0) return call();
    hang = null;
    return new Promise((resolve, reject) => { release = () => call().then(resolve, reject); });
  };
  // Every real handle opened, so a case whose call never answered still closes it.
  const handles = [];
  const handleOf = (real) => (handles.push(real), {
    read: (...args) => answer("read", () => real.read(...args)),
    write: (buffer) => answer("write", () => real.write(buffer)),
    stat: (options) => answer("fstat", () => real.stat(options)),
    close: () => answer("close", () => real.close()),
    sync: () => answer("sync", () => real.sync()),
    utimes: (atime, mtime) => answer("futimes", () => real.utimes(atime, mtime)),
  });
  const seam = { promises: Object.fromEntries(
    ["mkdir", "rename", "link", "unlink", "readdir", "rmdir", "utimes", "readFile", "stat", "lstat"]
      .map((name) => [name, (...args) => answer(name, () => fs[name](...args))])
      .concat([["open", (...args) => answer("open", () => fs.open(...args)).then(handleOf)]]),
  ) };
  const logs = [];
  const plugin = { state: { data: {} }, app: { vault: { adapter: { getBasePath: () => root } } }, log: (line) => logs.push(line) };
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const bounded = new ObsidianHost(plugin, { fs: seam, path: nodePath, base: root }).desktop.fs.promises;
  const dog = diskWatchdog(t);
  // The watchdog stops at a tick that finds every call answered.
  const answered = (label) => {
    assert.notEqual(dog.tick, null, `${label} armed no watchdog`);
    dog.tick();
    assert.equal(dog.tick, null, `${label} left its entry in flight`);
  };
  const file = join(root, "a.md");
  const opened = async (flags) => {
    const handle = await bounded.open(file, flags);
    answered("the open that answered");
    return handle;
  };
  const eight = new Uint8Array(3000);
  // Each call, the budget it has, whether it changes the disk, and what the
  // disk answers when it answers. Each runs twice and again late, so each puts
  // back what it changed.
  const calls = [
    ["open", 15_000, false, () => bounded.open(file, "r").then((handle) => handle.close())],
    ["open", 15_000, true, async () => {
      await (await bounded.open(join(root, "new.md"), "wx")).close();
      await fs.unlink(join(root, "new.md"));
    }],
    ["mkdir", 15_000, true, () => bounded.mkdir(join(root, "made"), { recursive: true })],
    ["link", 15_000, true, async () => {
      await bounded.link(file, join(root, "linked.md"));
      await fs.unlink(join(root, "linked.md"));
    }],
    ["rename", 15_000, true, async () => {
      writeFileSync(join(root, "from.md"), "f");
      await bounded.rename(join(root, "from.md"), join(root, "to.md"));
      await fs.unlink(join(root, "to.md"));
    }],
    ["unlink", 15_000, true, async () => {
      writeFileSync(join(root, "doomed.md"), "d");
      await bounded.unlink(join(root, "doomed.md"));
    }],
    ["readdir", 15_000, false, async () => assert.deepEqual((await bounded.readdir(root)).sort(), (await fs.readdir(root)).sort())],
    ["rmdir", 15_000, true, async () => {
      mkdirSync(join(root, "gone"), { recursive: true });
      await bounded.rmdir(join(root, "gone"));
    }],
    ["utimes", 15_000, true, () => bounded.utimes(file, 1, 2)],
    ["readFile", 15_000, false, async () => assert.equal(await bounded.readFile(file, "utf8"), "a".repeat(5000))],
    ["stat", 15_000, false, async () => assert.equal((await bounded.stat(file)).size, 5000)],
    ["lstat", 15_000, false, async () => assert.equal((await bounded.lstat(file, { bigint: true })).size, 5000n)],
    // A read or a write is measured by what it moves; a sync by what was written since the last.
    ["read", 15_005, false, async () => {
      const handle = await opened("r");
      assert.equal((await handle.read(new Uint8Array(5000), 0, 5000, 0)).bytesRead, 5000);
      await handle.close();
    }],
    ["write", 15_003, true, async () => {
      const handle = await opened("r+");
      assert.equal((await handle.write(eight)).bytesWritten, 3000);
      await handle.close();
    }],
    ["sync", 15_006, true, async () => {
      const handle = await opened("r+");
      await handle.write(eight);
      await handle.sync();
      await handle.write(eight);
      await handle.write(eight);
      await handle.sync();
      await handle.close();
    }, 1],
    ["fstat", 15_000, false, async () => {
      const handle = await opened("r");
      assert.equal((await handle.stat({ bigint: true })).size, BigInt((await fs.stat(file)).size));
      await handle.close();
    }],
    ["futimes", 15_000, true, async () => {
      const handle = await opened("r+");
      await handle.utimes(1, 2);
      await handle.close();
    }],
    ["close", 15_000, false, async () => (await opened("r")).close()],
  ];
  for (const [name, budget, changes, call, first = 0] of calls) {
    const label = `${name}${changes ? " (a change)" : ""}`;
    // Answered: as the disk answers, and no entry left in flight.
    await call();
    answered(label);
    // Unanswered: a read fails at its budget, a change is awaited past it,
    // each with one line naming it.
    hang = { name, first };
    logs.length = 0;
    const outcome = call().then(() => "answered", (error) => error);
    await until(() => hang === null);
    assert.equal(hang, null, `${label} was never asked of the disk`);
    if (changes) await overrunsAt(dog, label, outcome, name, budget, logs);
    else await stallsAt(dog, label, outcome, name, budget, logs);
    // The disk answers at last: the answer is logged, a change's caller has
    // it as the disk gave it, and a handle a late read-only open brings is
    // closed, since nobody is left to close it.
    const opens = handles.length;
    dog.at(budget + 1000);
    await release();
    await until(() => logs.some((line) => line.startsWith(`host decision=late call=${name} `)));
    assert.ok(logs.includes(`host decision=late call=${name} duration_ms=${budget + 1000} budget_ms=${budget} outcome=answered`), `${label}: ${logs.join(" | ")}`);
    if (changes) {
      const said = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still waiting after its answer"), 2000))]);
      assert.equal(said, "answered", `${label}: its caller never had the disk's answer`);
    }
    if (name === "open" && !changes) {
      await until(() => handles.length > opens && handles.at(-1).fd === -1);
      assert.equal(handles.at(-1).fd, -1, "the handle a late open brought was left open");
    }
    dog.at(0);
    if (dog.tick !== null) answered(`${label}, answered late`);
    for (const real of handles.splice(0)) await real.close().catch(() => {});
  }
  // Calls in flight together have an entry each: one that answers never takes another's.
  hang = { name: "readdir", first: 0 };
  logs.length = 0;
  const beside = bounded.readdir(root).then(() => "answered", (error) => error);
  assert.deepEqual((await bounded.readdir(root)).sort(), (await fs.readdir(root)).sort());
  await stallsAt(dog, "a readdir beside one that answered", beside, "readdir", 15_000, logs);
  await release();
  // The filesystem the host finds for itself, on a desktop, is the bounded one too.
  const found = new ObsidianHost(plugin).desktop.fs.promises;
  await found.readdir(root);
  answered("the host's own readdir");
});

/**
 * AN ECHO MARK IS ARMED FOR AN EVENT, AND SOME EVENTS NEVER COME (review
 * round 2, finding 5).
 *
 * Every removal, move and write the pull path makes is marked first, because
 * Obsidian reports it to this plugin's own handlers and an unmarked report is
 * published straight back at the device that made the change. The mark is
 * consumed by the event it was armed for -- when one arrives. Obsidian's
 * desktop watcher is asynchronous and misses changes outright, which is the
 * whole reason this periodic pass exists, so a mark can outlive its event;
 * and the next GENUINE change at that exact path is then swallowed as the
 * echo. A suppressed deletion is the expensive one: the note stays on every
 * other device with nothing left here to re-derive it from.
 *
 * The bound is one whole scan cycle. Below, the vault never delivers a single
 * event: the peer's rename is applied as a write and a trash, the file
 * reappears at the trashed name from outside Obsidian (a file manager, a
 * checkout, another sync tool -- the case this pass exists for), and the user
 * then deletes it. That deletion IS this device's to publish.
 */
test("a removal mark outlives no scan cycle, so a later deletion of that path is published", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  host.seed("Notes/One.md", "first\n", 1000);
  await pushFile(rigged.context, "Notes/One.md");
  const one = state.fileByPath("Notes/One.md");

  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  await engine.start();
  const context = engine.context;

  // A peer renames the note AND edits it in one version, which is the
  // write-at-the-new-name and trash-the-old path: the trash is marked.
  const renamed = await server.publish({
    fileId: one.fileId,
    path: "Notes/Renamed.md",
    bytes: new TextEncoder().encode("second\n"),
    mtime: 2000,
    parents: [one.versionId],
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
  });
  assert.equal(await applyChange(context, renamed), "applied");
  assert.ok(context.trashed.has("Notes/One.md"), "nothing was armed, so this test proves nothing");

  // The name is taken again by something Obsidian never reported, and the
  // scan is what finds it: one file, published as the new note it is.
  host.seed("Notes/One.md", "third\n", 3000);
  await timers.run(SCAN_MS);
  await timers.run(SCAN_MS);
  await engine.syncNow();

  assert.equal(context.trashed.has("Notes/One.md"), false, "the mark outlived two scan cycles");
  const back = state.fileByPath("Notes/One.md");
  assert.ok(back !== undefined && back.fileId !== one.fileId, "the new note was never published");

  // And now the user deletes it in Obsidian, which is this device's to say:
  // the note leaves the vault and the event reaches the engine's handler.
  host.files.delete("Notes/One.md");
  engine.deleted("Notes/One.md");
  await engine.syncNow();
  engine.stop();
  server.releaseFeed();

  assert.equal(
    host.logs.some((line) => line.includes("decision=echo_suppressed") && line.includes("event=delete")),
    false,
    host.logs.filter((line) => line.startsWith("watch")).join(" | "),
  );
  assert.ok(
    notes(await postedPaths(server, k)).some((version) => version.deleted && version.fileId === back.fileId),
    `the deletion was swallowed as an echo: ${JSON.stringify(notes(await postedPaths(server, k)))}`,
  );
});
