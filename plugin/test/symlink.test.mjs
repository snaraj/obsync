/**
 * The filesystem layer of path confinement, on a real filesystem.
 *
 * The second security review showed that the string proof was not a
 * filesystem proof: a directory symlink already inside the vault —
 * `Linked` → somewhere else — passed `path.resolve` and the prefix check,
 * and then `mkdir`, `open` and `rename` followed it, so a manifest for
 * `Linked/from-remote.md` wrote outside the vault. These tests are the
 * reviewer's case and its neighbours, run through the REAL `ObsidianHost`
 * against a real temporary vault with real symlinks, and driven by the REAL
 * pull path with real encrypted manifests from the fake server.
 *
 * The last test uses the host's filesystem seam to be hostile: it swaps the
 * temp file for a symlink in the instant between the exclusive-create open
 * and the first write, which is the race the descriptor comparison exists to
 * lose safely.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as realFsPromises } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { FakeServer, KEYS, fakeState, keys, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { vaultPathRefusal } = require("../build/vaultPath.js");

const enc = (text) => new TextEncoder().encode(text);

/**
 * A real vault directory, a real outside directory, and the real host over
 * them, wired into a real sync context against the fake server.
 */
async function vault({ fs: injected } = {}) {
  // The host AND the pull path come from the same sandbox copy of `build/`:
  // one copy means one `VaultPathError` class, the way the shipped bundle's
  // single module registry gives the plugin one of everything.
  const box = sandbox();
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { applyChange } = box.require(join(box.home, "build", "sync", "pull.js"));
  const obsidian = box.require("obsidian");
  obsidian.notices.length = 0;
  const root = mkdtempSync(join(tmpdir(), "obsync-vault-"));
  const outside = mkdtempSync(join(tmpdir(), "obsync-outside-"));
  const logs = [];
  const adapter = {
    getBasePath: () => root,
    stat: async (path) => {
      try {
        const found = statSync(join(root, path));
        return { type: found.isFile() ? "file" : "folder", mtime: Math.round(found.mtimeMs), size: found.size };
      } catch {
        return null;
      }
    },
    readBinary: async (path) => {
      const bytes = readFileSync(join(root, path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    remove: async (path) => unlinkSync(join(root, path)),
    rmdir: async (path) => rmdirSync(join(root, path)),
  };
  const plugin = {
    state: { data: {} },
    app: {
      vault: {
        adapter,
        getFiles: () => [],
        getAbstractFileByPath: () => null,
        // Obsidian's own cache knows nothing here, so the host falls back to
        // the adapter: the filesystem is what these tests are about.
        getFileByPath: () => null,
        getFolderByPath: () => null,
        getAllFolders: () => [],
        // "Deleted files: permanently delete", so what the cache does not
        // know reaches the adapter's own `remove` (issue #138).
        getConfig: (key) => (key === "trashOption" ? "none" : undefined),
      },
      fileManager: { trashFile: async () => assert.fail("the vault cache had no entry to trash") },
    },
    log: (line) => logs.push(line),
  };
  const desktop = { fs: injected ?? { promises: { ...realFsPromises } }, path: nodePath, base: root };
  const host = new ObsidianHost(plugin, desktop);

  const server = new FakeServer();
  const { state } = await fakeState(false);
  const k = await keys();
  const context = {
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      sleep: async () => undefined,
      maxAttempts: 2,
    }),
    host,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    domainId: KEYS.domainId,
    mapFileId: k.map.fileId,
    deviceId: KEYS.deviceId,
    concurrency: 4,
    authored: new Set(),
    written: new Set(),
    trashed: new Set(),
    createdFolders: new Set(),
    refused: new Set(),
    merges: new Map(),
    deviceNames: new Map(),
    now: () => 1757200000000,
    deviceNameFor: () => "iPhone",
  };
  let files = 0;
  const publish = (path, body = "attacker bytes\n", fileId = String(++files).padStart(2, "0").repeat(16)) =>
    server.publish({
      fileId,
      path,
      bytes: enc(body),
      mtime: 1757200001000,
      domainKey: k.domainKey,
      manifestKey: k.manifestKey,
    });
  let folders = 0;
  const publishFolder = (path, { deleted = false, parents = [] } = {}) =>
    server.publishManifest({
      fileId: `f${String(++folders).padStart(1, "0")}`.repeat(16).slice(0, 32),
      manifest: { v: 2, kind: "directory", path, domain: KEYS.domainId, size: 0, chunks: [], sha256: "", deleted },
      sids: [],
      parents,
      deviceId: "ffffffffffffffffffffffffffffffff",
      manifestKey: k.manifestKey,
      bytes: 0,
    });
  // The next start: a new host over the same vault, the way a relaunched
  // Obsidian builds one, holding nothing the previous one had open.
  const rehost = () => new ObsidianHost(plugin, desktop);
  return { host, rehost, root, outside, logs, notices: obsidian.notices, context, server, state, publish, publishFolder, applyChange, keys: k };
}

const refusals = (logs) => logs.filter((line) => line.includes("decision=refused"));

test("the reviewer's case: a manifest through a directory symlink writes nothing outside", async () => {
  const { root, outside, logs, notices, context, publish, applyChange } = await vault();
  symlinkSync(outside, join(root, "Linked"), "dir");

  const frame = await publish("Linked/from-remote.md");
  assert.equal(await applyChange(context, frame), "refused");

  assert.deepEqual(readdirSync(outside), [], "nothing was written outside the vault");
  assert.deepEqual(readdirSync(root), ["Linked"], "and nothing new inside it");
  assert.equal(existsSync(join(root, "Linked", "from-remote.md")), false, "nothing under the symlink either");
  assert.ok(
    refusals(logs).some((line) => line.includes("reason=symlink_component") && line.includes(`file=${frame.file_id}`)),
    logs.join(" | "),
  );
  assert.equal(notices.length, 1, "the user is told once");
});

test("a symlink as the final component leaves the file it points at alone", async () => {
  const { root, outside, logs, context, publish, applyChange } = await vault();
  const secret = join(outside, "secret.md");
  writeFileSync(secret, "outside\n");
  symlinkSync(secret, join(root, "note.md"));

  assert.equal(await applyChange(context, await publish("note.md", "overwritten\n")), "refused");

  assert.equal(readFileSync(secret, "utf8"), "outside\n", "the outside file is untouched");
  assert.equal(lstatSync(join(root, "note.md")).isSymbolicLink(), true, "the link itself was not replaced");
  assert.ok(refusals(logs).some((line) => line.includes("reason=symlink_component")));
});

test("a symlink in the middle of a nested path is refused", async () => {
  const { root, outside, context, publish, applyChange } = await vault();
  mkdirSync(join(root, "a"));
  symlinkSync(outside, join(root, "a", "b"), "dir");

  assert.equal(await applyChange(context, await publish("a/b/c.md")), "refused");
  assert.deepEqual(readdirSync(outside), []);
});

test("a symlink pointing INSIDE the vault is refused too: the rule is no symlink components", async () => {
  const { root, context, publish, applyChange } = await vault();
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "Inside"), "dir");

  assert.equal(await applyChange(context, await publish("Inside/x.md")), "refused");
  assert.deepEqual(readdirSync(join(root, "real")), [], "not even a link that stays home is followed");
});

test("a normal nested write still lands, folders and all", async () => {
  const { root, context, state, publish, applyChange } = await vault();
  const frame = await publish("Notes/deep/ok.md", "honest bytes\n");

  assert.equal(await applyChange(context, frame), "applied");
  assert.equal(readFileSync(join(root, "Notes", "deep", "ok.md"), "utf8"), "honest bytes\n");
  assert.equal(state.fileByPath("Notes/deep/ok.md").versionId, frame.version_id);
  assert.deepEqual(readdirSync(join(root, "Notes", "deep")), ["ok.md"], "no temp file survived");
});

test("a rename whose destination parent is a symlink is refused, and the original stays", async () => {
  const { root, outside, context, publish, keys: k, server, applyChange } = await vault();
  const fileId = "ab".repeat(16);
  const first = await publish("Notes/a.md", "first\n", fileId);
  assert.equal(await applyChange(context, first), "applied");
  symlinkSync(outside, join(root, "Linked"), "dir");

  // The same file id, moved: a rename is a new version carrying a new path.
  const moved = await server.publish({
    fileId,
    path: "Linked/a.md",
    bytes: enc("first\n"),
    mtime: 1757200002000,
    domainKey: k.domainKey,
    manifestKey: k.manifestKey,
    parents: [first.version_id],
  });
  assert.equal(await applyChange(context, moved), "refused");
  assert.equal(readFileSync(join(root, "Notes", "a.md"), "utf8"), "first\n", "the file did not move");
  assert.deepEqual(readdirSync(outside), [], "and nothing appeared outside");
});

test("a path with a symlink component is not syncable in the other direction either", async () => {
  const { host, root, outside, logs, applyChange } = await vault();
  symlinkSync(outside, join(root, "Linked"), "dir");
  mkdirSync(join(root, "Notes"));
  writeFileSync(join(root, "Notes", "ok.md"), "mine\n");

  assert.equal(await host.syncable("Linked/note.md"), false);
  assert.equal(await host.syncable("Notes/ok.md"), true);
  assert.equal(await host.syncable("Notes/absent.md"), true, "a file yet to be created is syncable");
  assert.ok(
    logs.some((line) => line.includes("decision=not_synced reason=symlink_component")),
    logs.join(" | "),
  );
});

/**
 * Swap the vault's `Notes` directory for something else, mid-syscall.
 *
 * This is the shape the third review found: every no-follow walk passes,
 * and then the NAME `Notes` is made to mean a different directory before
 * the syscall the walk was meant to protect. A descriptor and a `lstat` of
 * the same name still agree afterwards — both resolve through the swapped
 * parent — so only the identity of the directory chain can see it.
 */
/**
 * An `open` that swaps the parent at the named moment and records every byte
 * the writer then sends. The bytes are the point: the temp file's creation
 * through a swapped parent cannot be prevented without `openat`, but writing
 * vault plaintext into it can be, and that is what the binding after the
 * open is for.
 */
function swappingOpen(flags, swapper, wrote) {
  return async (path, opening) => {
    if (opening === flags) swapper.swap();
    const handle = await realFsPromises.open(path, opening);
    if (opening !== flags) return handle;
    return {
      read: (...args) => handle.read(...args),
      write: async (bytes) => {
        wrote.push(bytes.length);
        return handle.write(bytes);
      },
      stat: () => handle.stat(),
      close: () => handle.close(),
    };
  };
}

function parentSwap(root, replace) {
  let done = false;
  return {
    done: () => done,
    swap: () => {
      if (done) return;
      done = true;
      renameSync(join(root, "Notes"), join(root, "Notes.aside"));
      replace();
    },
  };
}

test("the reviewer's case: a parent swapped inside the open writes nothing outside", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "obsync-outside-"));
  let swapper = null;
  const wrote = [];
  const { root, logs, context, publish, applyChange } = await vault({
    fs: { promises: { ...realFsPromises, open: swappingOpen("wx", { swap: () => swapper.swap() }, wrote) } },
  });
  mkdirSync(join(root, "Notes"));
  swapper = parentSwap(root, () => symlinkSync(outsideDir, join(root, "Notes"), "dir"));

  assert.equal(await applyChange(context, await publish("Notes/from-remote.md")), "refused");

  assert.equal(swapper.done(), true, "the swap really happened");
  assert.deepEqual(wrote, [], "not one byte of the vault was written through the swapped parent");
  assert.deepEqual(readdirSync(outsideDir), [], "and no file was left outside the vault");
  assert.ok(refusals(logs).length === 1, logs.join(" | "));
});

test("a parent swapped for a different real directory is refused by identity alone", async () => {
  const other = mkdtempSync(join(tmpdir(), "obsync-other-"));
  let swapper = null;
  const wrote = [];
  const { root, logs, context, publish, applyChange } = await vault({
    fs: { promises: { ...realFsPromises, open: swappingOpen("wx", { swap: () => swapper.swap() }, wrote) } },
  });
  mkdirSync(join(root, "Notes"));
  // Nothing here is a symlink and nothing leaves the vault: the ONLY thing
  // wrong is that `Notes` is no longer the directory that was walked.
  swapper = parentSwap(root, () => renameSync(other, join(root, "Notes")));

  assert.equal(await applyChange(context, await publish("Notes/from-remote.md")), "refused");

  assert.equal(swapper.done(), true, "the swap really happened");
  assert.deepEqual(wrote, [], "not one byte was written into the directory that took its place");
  assert.deepEqual(readdirSync(join(root, "Notes")), [], "and nothing was left in it");
  assert.ok(
    refusals(logs).some((line) => line.includes("reason=chain_changed")),
    logs.join(" | "),
  );
});

test("a parent swapped inside a read is refused before a byte is returned", async () => {
  const other = mkdtempSync(join(tmpdir(), "obsync-other-"));
  let swapper = null;
  const { root, host } = await vault({
    fs: {
      promises: {
        ...realFsPromises,
        open: async (path, flags) => {
          if (flags === "r") swapper.swap();
          return realFsPromises.open(path, flags);
        },
      },
    },
  });
  mkdirSync(join(root, "Notes"));
  writeFileSync(join(root, "Notes", "note.md"), "ours\n");
  // The replacement directory carries a HARD LINK to the very file we are
  // reading, so the descriptor comparison is satisfied and the chain
  // identity is the only thing left that can refuse.
  swapper = parentSwap(root, () => {
    linkSync(join(root, "Notes.aside", "note.md"), join(other, "note.md"));
    renameSync(other, join(root, "Notes"));
  });

  await assert.rejects(
    () => host.read("Notes/note.md"),
    (error) => {
      assert.equal(error.refusal, "chain_changed", "the chain binding is what refused");
      return true;
    },
  );
  assert.equal(swapper.done(), true, "the swap really happened");
});

test("a parent swapped around the rename is refused, hard link and all", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "obsync-outside-"));
  let swapper = null;
  const { root, logs, context, publish, applyChange } = await vault({
    fs: {
      promises: {
        ...realFsPromises,
        rename: async (from, to) => {
          await realFsPromises.rename(from, to);
          // The file landed where it belonged; the parent is swapped only
          // then, and a hard link gives the outside name our own inode, so
          // that comparing inodes alone would be satisfied.
          const name = to.slice(to.lastIndexOf("/") + 1);
          if (!swapper.done()) {
            swapper.swap();
            linkSync(join(root, "Notes.aside", name), join(outsideDir, name));
          }
        },
      },
    },
  });
  mkdirSync(join(root, "Notes"));
  swapper = parentSwap(root, () => symlinkSync(outsideDir, join(root, "Notes"), "dir"));

  assert.equal(await applyChange(context, await publish("Notes/from-remote.md")), "refused");

  assert.equal(swapper.done(), true, "the swap really happened");
  assert.deepEqual(readdirSync(outsideDir), [], "the link we created outside is gone again");
  assert.ok(refusals(logs).length === 1, logs.join(" | "));
});

test("a target swapped for a symlink after the rename is refused, and the plant removed", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "obsync-outside-"));
  const secret = join(outsideDir, "secret.md");
  writeFileSync(secret, "outside\n");
  // The rename lands our file, and the name is then made to mean the
  // attacker's file instead. The descriptor still says which inode is ours.
  const hostile = {
    promises: {
      ...realFsPromises,
      rename: async (from, to) => {
        await realFsPromises.rename(from, to);
        unlinkSync(to);
        symlinkSync(secret, to);
      },
    },
  };
  const { host, root } = await vault({ fs: hostile });

  const writer = await host.writer("note.md");
  await writer.write(enc("ours\n"));
  await assert.rejects(
    () => writer.commit(1757200001000),
    (error) => {
      assert.equal(error.refusal, "target_identity", "the post-rename comparison is what refused");
      return true;
    },
  );
  assert.equal(readFileSync(secret, "utf8"), "outside\n", "the outside file is untouched");
  assert.deepEqual(readdirSync(root), [], "the planted link was removed from the vault");
});

test("a temp file swapped for a symlink between the open and the write is refused", async () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "obsync-outside-"));
  const secret = join(outsideDir, "secret.md");
  writeFileSync(secret, "outside\n");
  // The hostile filesystem: the instant the exclusive-create open returns,
  // the temp NAME is made to mean a file outside the vault. The descriptor
  // still means what it meant; that difference is the whole guard.
  const hostile = {
    promises: {
      ...realFsPromises,
      open: async (path, flags) => {
        const handle = await realFsPromises.open(path, flags);
        if (flags === "wx") {
          unlinkSync(path);
          symlinkSync(secret, path);
        }
        return handle;
      },
    },
  };
  const { host, root, logs } = await vault({ fs: hostile });

  await assert.rejects(
    () => host.writer("note.md"),
    (error) => {
      assert.equal(error.name, "VaultPathError");
      assert.equal(error.refusal, "temp_identity", "the descriptor comparison is what refused");
      return true;
    },
  );
  assert.equal(readFileSync(secret, "utf8"), "outside\n", "the outside file is untouched");
  // The plant is LEFT WHERE IT IS: the temp is unlinked only while its name
  // still means our own file, because acting on a name whose meaning has
  // changed is the move this guard exists to refuse. Nothing was written
  // through it, and every later operation refuses it as a symlink.
  const left = readdirSync(root);
  assert.equal(left.length, 1, `nothing landed; only the plant remains: ${left.join(", ")}`);
  assert.equal(lstatSync(join(root, left[0])).isSymbolicLink(), true, "and it is the plant, not our file");
  assert.equal(logs.length, 0, "the writer refuses before it logs a write");
});

/**
 * THE TEMP FILE ON A VOLUME THAT NUMBERS A FILE BY ITS FIRST CLUSTER (issue
 * #175), AND AFTER A WRITE THAT NEVER FINISHED (issue #159).
 *
 * FAT32 and exFAT on macOS, measured on disk images with Node 26
 * (2026-09-24): an EMPTY file reports a placeholder inode derived from its
 * directory entry, 2^64 - n, which a JavaScript number rounds to one value
 * for every empty file; the first byte written allocates a cluster and the
 * inode becomes that cluster's number, stable from then on through close,
 * `utimes` and `rename`. The writer compared the name with the identity the
 * descriptor had while the temp was EMPTY, so every incoming write on such a
 * volume was refused as `temp_identity` and left its temp behind -- a
 * visible name the next scan then published to every device.
 *
 * `renumbering` models exactly that over the real filesystem: a regular file
 * with no bytes reports the placeholder, a file with bytes its real inode.
 */
const PLACEHOLDER_INO = 18446744073709552000;

function renumbering() {
  const renumber = (stat) =>
    stat.isFile() && stat.size === 0
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: PLACEHOLDER_INO })
      : stat;
  return {
    ...realFsPromises,
    lstat: async (path) => renumber(await realFsPromises.lstat(path)),
    open: async (path, flags, mode) => {
      const handle = await realFsPromises.open(path, flags, mode);
      return new Proxy(handle, {
        get: (target, key) => {
          if (key === "stat") return async () => renumber(await target.stat());
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

test("a vault on a volume that renumbers a file after its first write receives notes, and keeps no temp", async () => {
  const { root, logs, notices, context, publish, applyChange } = await vault({ fs: { promises: renumbering() } });
  mkdirSync(join(root, "Notes"));
  // What the fake rests on, said once: the temp's inode really changes
  // between the open and the commit, so the old comparison cannot pass.
  const probe = await renumbering().open(join(root, "Notes", "probe"), "wx");
  const empty = (await probe.stat()).ino;
  await probe.write(enc("x"));
  assert.notEqual((await probe.stat()).ino, empty, "the fake renumbers after the first write");
  await probe.close();
  unlinkSync(join(root, "Notes", "probe"));

  const body = "LINE 1\nLINE 2\nLINE 3\nline 4\n";
  assert.equal(await applyChange(context, await publish("Notes/n05.md", body)), "applied");
  assert.equal(await applyChange(context, await publish("Notes/empty.md", "")), "applied");

  assert.equal(readFileSync(join(root, "Notes", "n05.md"), "utf8"), body);
  assert.equal(readFileSync(join(root, "Notes", "empty.md"), "utf8"), "");
  assert.deepEqual(readdirSync(join(root, "Notes")).sort(), ["empty.md", "n05.md"], "and no temp beside them");
  assert.deepEqual(refusals(logs), [], logs.join(" | "));
  assert.equal(notices.length, 0, "nothing to tell the user");
});

test("on such a volume a temp swapped after the write is still refused, and nothing lands", async () => {
  // The identity is read from the descriptor at the moment of each proof, so
  // a name that another process pointed at a different file still fails it.
  const base = renumbering();
  const hostile = {
    ...base,
    open: async (path, flags, mode) => {
      const handle = await base.open(path, flags, mode);
      if (flags !== "wx") return handle;
      return new Proxy(handle, {
        get: (target, key) => {
          if (key !== "write") return target[key];
          return async (bytes) => {
            const wrote = await target.write(bytes);
            renameSync(path, `${path}.aside`);
            writeFileSync(path, "not ours\n");
            return wrote;
          };
        },
      });
    },
  };
  const { host, root } = await vault({ fs: { promises: hostile } });
  mkdirSync(join(root, "Notes"));

  const writer = await host.writer("Notes/n.md");
  await writer.write(enc("ours\n"));
  await assert.rejects(
    () => writer.commit(1757200001000),
    (error) => {
      assert.equal(error.refusal, "temp_identity", "the descriptor comparison is what refused");
      return true;
    },
  );
  assert.equal(existsSync(join(root, "Notes", "n.md")), false, "the other file was never renamed into place");
  const planted = readdirSync(join(root, "Notes")).filter((name) => !name.endsWith(".aside"));
  assert.equal(planted.length, 1, planted.join(", "));
  assert.equal(readFileSync(join(root, "Notes", planted[0]), "utf8"), "not ours\n", "and it was left as it was");
});

test("a write that stops on such a volume takes its temp with it", async () => {
  // The disk filled, the network dropped: the caller aborts. The temp is
  // ours, it is at its name, and it goes -- on this volume too.
  const { host, root } = await vault({ fs: { promises: renumbering() } });
  mkdirSync(join(root, "Notes"));

  const writer = await host.writer("Notes/big.bin");
  await writer.write(enc("the part that arrived\n"));
  await writer.abort();

  assert.deepEqual(readdirSync(join(root, "Notes")), [], "nothing is left in the vault");
});

test("the create-only writer proves its temp the same way on such a volume", async () => {
  // Conflict copies and restored copies. FAT32 and exFAT also refuse `link`
  // (ENOTSUP, measured), so there such a copy still fails at publication;
  // the renumbering is modelled here over a volume that links, which is what
  // shows the proof itself is right and the temp is gone either way.
  const { host, root } = await vault({ fs: { promises: renumbering() } });
  mkdirSync(join(root, "Notes"));

  const copy = await host.createWriter("Notes/copy.md", 12, () => undefined);
  await copy.write(enc("first \n"));
  await copy.write(enc("then\n"));
  await copy.commit(1757200001000);
  await copy.abort();
  const stopped = await host.createWriter("Notes/stopped.md", 12, () => undefined);
  await stopped.write(enc("half\n"));
  await stopped.abort();

  assert.equal(readFileSync(join(root, "Notes", "copy.md"), "utf8"), "first \nthen\n");
  assert.deepEqual(readdirSync(join(root, "Notes")), ["copy.md"], "and no temp is left for either");
});

test("a download's temp is a hidden name: never listed, never a path any device syncs", async () => {
  const { host, root } = await vault();
  mkdirSync(join(root, "Attachments"));

  const writer = await host.writer("Attachments/big.bin");
  await writer.write(enc("the first 40 percent\n"));
  // Obsidian quits here: the writer is neither committed nor aborted.

  const names = readdirSync(join(root, "Attachments"));
  assert.equal(names.length, 1, names.join(", "));
  assert.equal(vaultPathRefusal(`Attachments/${names[0]}`), "hidden_segment", `a syncable name: ${names[0]}`);
  assert.deepEqual(await host.scan(), [], "the filesystem listing does not offer it for publication");
  await writer.abort();
});

test("the next start removes the temps an interrupted write left, and nothing else", async () => {
  const { host, rehost, root, outside, logs } = await vault();
  mkdirSync(join(root, "Attachments"));
  const at = (name) => join(root, "Attachments", name);

  // The run that was interrupted: a download and a restored copy, each part
  // way through, never committed or aborted.
  const download = await host.writer("Attachments/big.bin");
  await download.write(enc("the part before the quit\n"));
  const copy = await host.createWriter("Attachments/restored.bin", 64, () => undefined);
  await copy.write(enc("half a copy\n"));
  // What is NOT a write's temp: a hold may be the last name of a save
  // (`main.ts`, `hold`), a dotfile is the user's, a note is a note, and a
  // link wearing a temp's name is left where it is, as the writer leaves it.
  const hold = `.obsync-hold-${"ab".repeat(8)}.tmp`;
  writeFileSync(at(hold), "held bytes\n");
  writeFileSync(at(".hidden.md"), "a dotfile\n");
  writeFileSync(at("keep.md"), "a note\n");
  writeFileSync(join(outside, "secret.md"), "outside\n");
  const plant = `.obsync-write-${"cd".repeat(8)}.tmp`;
  symlinkSync(join(outside, "secret.md"), at(plant));
  const leftovers = readdirSync(join(root, "Attachments")).filter((name) => /^\.obsync-(write|restore)-/.test(name) && name !== plant);
  assert.equal(leftovers.length, 2, leftovers.join(", "));

  // The next start, with a download of its own already under way.
  const next = rehost();
  const live = await next.writer("Attachments/live.bin");
  await live.write(enc("arriving now\n"));
  logs.length = 0;
  await next.sweep();

  const left = readdirSync(join(root, "Attachments"));
  for (const name of leftovers) assert.equal(left.includes(name), false, `${name} outlived the start`);
  for (const name of [hold, ".hidden.md", "keep.md", plant]) assert.equal(left.includes(name), true, `${name} was removed`);
  assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "outside\n");
  const removed = logs.filter((line) => line.startsWith("host path_class=temp decision=removed"));
  assert.equal(removed.length, 1, logs.join(" | "));
  assert.match(removed[0], /reason=interrupted_write files=2 kept=0 duration_ms=\d+$/);

  // A start with nothing left to clear says nothing.
  await next.sweep();
  assert.equal(logs.filter((line) => line.startsWith("host path_class=temp")).length, 1, logs.join(" | "));

  // The live download was not a leftover, and it lands.
  await live.commit(1757200001000);
  assert.equal(readFileSync(at("live.bin"), "utf8"), "arriving now\n");
  // The dead run's descriptors, which only this test's process still holds.
  await download.abort();
  await copy.abort();
});

/**
 * FOLDER RECORDS ON A REAL FILESYSTEM (issue #104).
 *
 * A folder record decides what a `mkdir` and an `rmdir` do, so it takes the
 * same walk a file manifest takes: no component may be a symlink, nothing may
 * be created or removed outside the vault, and a FILE standing at the path is
 * refused rather than replaced. Removal additionally asks the filesystem
 * whether the directory is empty — with `readdir`, which sees the hidden and
 * unsynced files the vault's own inventory does not.
 */
test("a folder record through a directory symlink creates nothing outside", async () => {
  const { root, outside, logs, context, publishFolder, applyChange } = await vault();
  symlinkSync(outside, join(root, "Linked"), "dir");

  assert.equal(await applyChange(context, await publishFolder("Linked/Inside")), "refused");

  assert.deepEqual(readdirSync(outside), [], "a directory was made outside the vault");
  assert.deepEqual(readdirSync(root), ["Linked"], "and nothing new inside it");
  assert.ok(
    refusals(logs).some((line) => line.includes("reason=symlink_component")),
    refusals(logs).join(" | "),
  );
});

test("a folder record where a real FILE stands is refused, and the file is untouched", async () => {
  const { root, logs, context, publishFolder, applyChange } = await vault();
  writeFileSync(join(root, "Notes"), "a file, not a folder\n");

  assert.equal(await applyChange(context, await publishFolder("Notes")), "refused");

  assert.equal(lstatSync(join(root, "Notes")).isFile(), true, "the file became something else");
  assert.equal(readFileSync(join(root, "Notes"), "utf8"), "a file, not a folder\n");
  assert.ok(
    logs.some((line) => line.includes("folder path_class=folder decision=refused reason=not_a_directory")),
    refusals(logs).join(" | "),
  );
});

test("an ordinary folder record makes the folder, parents and all, and its tombstone takes it back", async () => {
  const { root, logs, context, state, publishFolder, applyChange } = await vault();
  const created = await publishFolder("Work/2026/Q3");
  assert.equal(await applyChange(context, created), "applied");
  assert.equal(lstatSync(join(root, "Work", "2026", "Q3")).isDirectory(), true, "the folder was not made");
  assert.equal(state.folderByPath("Work/2026/Q3") !== undefined, true);

  assert.equal(
    await applyChange(context, await publishFolder("Work/2026/Q3", { deleted: true, parents: [created.version_id] })),
    "deleted",
  );
  assert.equal(existsSync(join(root, "Work", "2026", "Q3")), false, "the folder outlived its tombstone");
  // `Work/2026` and `Work` have no record of their own, so the same walk that
  // cleans up after a deleted file takes them.
  assert.deepEqual(readdirSync(root), [], "the empty parents were left behind");
  assert.ok(logs.some((line) => line.includes("folder path_class=folder decision=removed reason=tombstone")));
  assert.ok(logs.some((line) => line.includes("folder path_class=folder decision=removed reason=empty_parent")));
});

test("a folder still holding an unsynced or hidden file is kept, and the file with it", async () => {
  const { root, logs, context, publishFolder, applyChange } = await vault();
  const created = await publishFolder("Shared");
  assert.equal(await applyChange(context, created), "applied");
  // Neither of these is a file this device syncs: one is hidden, one is a
  // note nobody has pushed. `readdir` is what sees them.
  writeFileSync(join(root, "Shared", ".DS_Store"), "");
  writeFileSync(join(root, "Shared", "local-only.md"), "not synced yet\n");

  assert.equal(
    await applyChange(context, await publishFolder("Shared", { deleted: true, parents: [created.version_id] })),
    "skipped",
  );

  assert.equal(lstatSync(join(root, "Shared")).isDirectory(), true, "a folder with files in it was removed");
  assert.deepEqual(readdirSync(join(root, "Shared")).sort(), [".DS_Store", "local-only.md"]);
  assert.ok(logs.some((line) => line.includes("folder path_class=folder decision=kept reason=not_empty")));
});

test("a tombstoned note takes the real directory it emptied, and stops at one that is not empty", async () => {
  const { root, context, server, publish, applyChange, keys: k } = await vault();
  const deep = await publish("Tree/Deep/only.md", "the last note\n");
  assert.equal(await applyChange(context, deep), "applied");
  const kept = await publish("Tree/Keep/kept.md", "a note that stays\n");
  assert.equal(await applyChange(context, kept), "applied");

  assert.equal(await applyChange(context, await server.publishTombstone({
    fileId: deep.file_id, path: "Tree/Deep/only.md", manifestKey: k.manifestKey, parents: [deep.version_id],
  })), "deleted");

  assert.equal(existsSync(join(root, "Tree", "Deep")), false, "the emptied directory was left behind");
  // `Tree` still holds `Keep`, so the walk stops there: a folder holding a
  // folder is not empty either.
  assert.equal(lstatSync(join(root, "Tree")).isDirectory(), true, "a folder with a subfolder was removed");
  assert.deepEqual(readdirSync(join(root, "Tree")), ["Keep"]);
  assert.equal(readFileSync(join(root, "Tree", "Keep", "kept.md"), "utf8"), "a note that stays\n");
});
