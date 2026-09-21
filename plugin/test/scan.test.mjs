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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeTimers, KEYS, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SCAN_MS, SyncEngine } = require("../build/sync/engine.js");
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
    paths.push({ path: manifest.path, deleted: manifest.deleted, fileId: frame.file_id });
  }
  return paths;
}

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
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);

  vault.seed("Notes/Moved.md", "the note that travels\n", 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/Moved.md") !== undefined);
  const fileId = state.fileByPath("Notes/Moved.md").fileId;
  const before = timers.now;

  // `mv Notes/Moved.md Notes/Archive/Moved.md` outside the app: no vault
  // event, and Obsidian's index still lists the old path.
  vault.moveUnseen("Notes/Moved.md", "Notes/Archive/Moved.md");

  await timers.run(1000, () => state.fileByPath("Notes/Archive/Moved.md") !== undefined);
  await timers.run(1000, () => (state.fileByPath("Notes/Archive/Moved.md")?.mtime ?? -1) !== -1);
  const latency = timers.now - before;
  engine.stop();

  assert.equal(state.fileByPath("Notes/Moved.md"), undefined, "the old path is forgotten");
  assert.equal(state.fileByPath("Notes/Archive/Moved.md").fileId, fileId, "the same file id moved");
  const posted = await postedPaths(server, k);
  assert.deepEqual(
    posted.map((version) => `${version.deleted ? "-" : "+"}${version.path}`),
    ["+Notes/Moved.md", "+Notes/Archive/Moved.md"],
    "a move, never a tombstone and a new file",
  );
  assert.equal(new Set(posted.map((version) => version.fileId)).size, 1, "one file id throughout");
  assert.ok(
    latency <= SCAN_MS + 5000,
    `it converged within one scan interval plus the push (${latency} ms of ${SCAN_MS} ms)`,
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
  const versions = server.journal.length;

  // A directory the scan could not read comes back as an absent file. It is
  // not a deletion, and the scan may never treat it as one.
  let scans = 0;
  host.scan = async () => { scans++; return []; };
  await timers.run(SCAN_MS, () => scans >= 2);
  await timers.run(1000);
  engine.stop();
  assert.ok(scans >= 2, `the scan really ran over the empty listing (${scans})`);

  assert.equal(server.journal.length, versions, "no version was posted at all");
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
  const ids = new Set(posted.map((version) => version.fileId));
  assert.equal(ids.size, 3, "three file ids: the original and two new notes, none of them guessed");
  assert.ok(host.logs.some((line) => /^scan decision=queued .*moved=0 /.test(line)), host.logs.join(" | "));
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
  const logs = [];
  const plugin = {
    state: { data: { syncFolders: folders } },
    app: { vault: { adapter: {}, getFiles: () => [], getAbstractFileByPath: () => null } },
    log: (line) => logs.push(line),
  };
  const opened = [];
  const watched = { promises: { ...fs, readdir: async (path) => { opened.push(String(path)); return fs.readdir(path); } } };
  const host = new ObsidianHost(plugin, { fs: watched, path: nodePath, base: root });
  return { host, root, outside, logs, plugin, opened };
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
  assert.equal(server.journal.length, 1, "and never published");
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
