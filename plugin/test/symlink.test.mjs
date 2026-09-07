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
  };
  const plugin = {
    app: { vault: { adapter, getFiles: () => [], getAbstractFileByPath: () => null } },
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
    deviceId: KEYS.deviceId,
    concurrency: 4,
    authored: new Set(),
    written: new Set(),
    refused: new Set(),
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
  return { host, root, outside, logs, notices: obsidian.notices, context, server, state, publish, applyChange, keys: k };
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
