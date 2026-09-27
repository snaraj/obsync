import { strict as assert } from "node:assert";
import test from "node:test";
import { promises as fs, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { sandbox } from "./fake.mjs";

const bytes = new TextEncoder().encode("COPY SENTINEL");
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function host(t, { mobile = false, wrap = (p) => p } = {}) {
  const box = sandbox();
  const root = mkdtempSync(join(tmpdir(), "obsync-history-host-"));
  t.after(() => { rmSync(root, { recursive: true }); rmSync(box.home, { recursive: true }); });
  mkdirSync(join(root, "Notes"));
  mkdirSync(join(root, "Admin"));
  writeFileSync(join(root, "Admin/deploy.sh"), "EXCLUDED SENTINEL");
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  const calls = [], logs = [];
  const state = { data: { syncFolders: ["Notes"] } };
  const vault = { adapter: {
    exists: async (p) => existsSync(join(root, p)),
    mkdir: async (p) => fs.mkdir(join(root, p), { recursive: true }),
    writeBinary: async () => assert.fail("overwriting adapter was used"),
  }, createBinary: async (p, data, options) => {
    calls.push(["createBinary", p]);
    await fs.writeFile(join(root, p), new Uint8Array(data), { flag: "wx" });
    return { path: p, stat: { mtime: options.mtime, size: data.byteLength } };
  } };
  const promises = wrap({ ...fs, lstat: async (p, ...options) => {
    calls.push(["lstat", p]);
    assert.ok(!p.startsWith(join(root, "Admin")), "excluded sentinel metadata was accessed");
    return fs.lstat(p, ...options);
  } });
  const h = new ObsidianHost({ state, app: { vault }, log: (line) => logs.push(line) }, mobile ? null : { base: root, path, fs: { promises } });
  return { root, h, state, calls, logs, vault, box };
}

for (const mobile of [false, true]) test(`create-only ${mobile ? "mobile" : "desktop"} publication preserves occupied destinations and excludes admin paths`, async (t) => {
  const { h, root, calls } = host(t, { mobile });
  await assert.rejects(h.createWriter("Admin/deploy.sh", bytes.length, () => {}), /scope/);
  assert.deepEqual(calls, [], "scope refusal precedes metadata and writes");
  writeFileSync(join(root, "Notes/original.md"), "UNSYNCED ORIGINAL");
  const writer = await h.createWriter("Notes/copy.md", bytes.length, () => {});
  await writer.write(bytes);
  assert.equal(existsSync(join(root, "Notes/copy.md")), false, "nothing visible before commit");
  const stat = await writer.commit(1000);
  await writer.abort();
  assert.equal(stat.path, "Notes/copy.md");
  assert.deepEqual(readFileSync(join(root, stat.path)), Buffer.from(bytes));
  assert.equal(readFileSync(join(root, "Notes/original.md"), "utf8"), "UNSYNCED ORIGINAL");
  assert.equal(readFileSync(join(root, "Admin/deploy.sh"), "utf8"), "EXCLUDED SENTINEL");
  assert.deepEqual(readdirSync(join(root, "Notes")).sort(), ["copy.md", "original.md"]);
  // Windows keeps no POSIX mode (Node reports 0o666 for any writable file):
  // there a copy has the access the vault folder's ACL gives every note.
  if (!mobile && process.platform !== "win32") assert.equal(lstatSync(join(root, stat.path)).mode & 0o777, 0o600);
  const competing = await h.createWriter("Notes/collision.md", bytes.length, () => {});
  await competing.write(bytes);
  writeFileSync(join(root, "Notes/collision.md"), "COMPETING SENTINEL");
  await assert.rejects(competing.commit(1000), /may exist/);
  await competing.abort();
  assert.equal(readFileSync(join(root, "Notes/collision.md"), "utf8"), "COMPETING SENTINEL");
});

test("desktop short writes complete and zero progress, size mismatch and file-sync errors refuse publication", async (t) => {
  for (const mode of ["short", "zero", "overprogress", "sync", "incomplete", "too_large"]) {
    let writes = 0;
    const r = host(t, { wrap: (p) => ({ ...p, open: async (...args) => {
      const handle = await p.open(...args);
      if (args[1] !== "wx") return handle;
      return { stat: (...options) => handle.stat(...options), close: () => handle.close(), utimes: (...values) => handle.utimes(...values),
        sync: async () => { if (mode === "sync") throw new Error("SYNC SENTINEL"); await handle.sync(); },
        write: async (part) => {
          if (mode === "zero") { assert.equal(++writes, 1, "a zero-byte response was retried"); return { bytesWritten: 0 }; }
          if (mode === "overprogress") return { bytesWritten: part.length + 1 };
          return handle.write(mode === "short" ? part.subarray(0, 2) : part);
        } };
    } }) });
    const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
    if (mode === "zero" || mode === "overprogress") await assert.rejects(writer.write(bytes), /progress/);
    else if (mode === "too_large") await assert.rejects(writer.write(new Uint8Array(bytes.length + 1)), /byte budget/);
    else {
      await writer.write(mode === "incomplete" ? bytes.subarray(0, 2) : bytes);
      if (mode === "short") await writer.commit(1000);
      else await assert.rejects(writer.commit(1000), /SYNC SENTINEL|incomplete/);
    }
    await writer.abort();
    assert.equal(existsSync(join(r.root, "Notes/copy.md")), mode === "short");
    if (mode === "short") assert.deepEqual(readFileSync(join(r.root, "Notes/copy.md")), Buffer.from(bytes));
    assert.ok(readdirSync(join(r.root, "Notes")).every((name) => !name.startsWith(".obsync-restore")));
  }
});

for (const mobile of [false, true]) test(`cancel after ${mobile ? "mobile" : "desktop"} publication dispatch preserves the copy`, async (t) => {
  const entered = deferred(), release = deferred();
  let active = true;
  const r = host(t, { mobile, wrap: (p) => ({ ...p, link: async (...args) => { entered.resolve(); await release.promise; return p.link(...args); } }) });
  if (mobile) {
    const create = r.vault.createBinary;
    r.vault.createBinary = async (...args) => { entered.resolve(); await release.promise; return create(...args); };
  }
  const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => { if (!active) throw new Error("CANCEL SENTINEL"); });
  await writer.write(bytes);
  const commit = writer.commit(1000);
  const dispatched = await Promise.race([entered.promise.then(() => true), commit.then(() => false, () => false)]);
  assert.equal(dispatched, true, "publication bypassed the create-only primitive");
  active = false;
  release.resolve();
  assert.equal((await commit).path, "Notes/copy.md");
  await writer.abort();
  assert.deepEqual(readFileSync(join(r.root, "Notes/copy.md")), Buffer.from(bytes));
});

test("desktop exclusive temporary creation preserves a pre-existing unowned name", async (t) => {
  const r = host(t);
  const crypto = r.box.require(join(r.box.home, "build/crypto.js"));
  crypto.randomBytes = (size) => new Uint8Array(size);
  const temp = join(r.root, `Notes/.obsync-restore-${"00".repeat(16)}.tmp`);
  writeFileSync(temp, "UNOWNED TEMP SENTINEL");
  await assert.rejects(r.h.createWriter("Notes/copy.md", bytes.length, () => {}), /EEXIST/);
  assert.equal(readFileSync(temp, "utf8"), "UNOWNED TEMP SENTINEL");
  assert.equal(existsSync(join(r.root, "Notes/copy.md")), false);
});

test("unsupported publication and post-link directory-sync failures do not fall back or delete a copy", async (t) => {
  for (const phase of ["link", "directory_sync"]) {
    const r = host(t, { wrap: (p) => ({ ...p,
      rename: async () => assert.fail("overwrite fallback"),
      link: async (...args) => { if (phase === "link") throw new Error("UNSUPPORTED SENTINEL"); return p.link(...args); },
      open: async (...args) => {
        const h = await p.open(...args);
        if (phase !== "directory_sync" || args[1] !== "r") return h;
        return { sync: async () => { throw new Error("DIRECTORY SYNC SENTINEL"); }, close: () => h.close() };
      },
    }) });
    const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
    await writer.write(bytes);
    await assert.rejects(writer.commit(1000), /may exist/);
    await writer.abort();
    assert.equal(existsSync(join(r.root, "Notes/copy.md")), phase === "directory_sync");
    if (phase === "directory_sync") assert.deepEqual(readFileSync(join(r.root, "Notes/copy.md")), Buffer.from(bytes));
    // The refusal says why by its code alone; a message names a path on disk.
    assert.deepEqual(r.logs, ["host path_class=file decision=refused reason=copy_unconfirmed code=none"]);
  }
});

/**
 * A HOST WITH NO FOLDER SYNC (Windows). Node opens a directory there for
 * reading only, and the sync is refused `EPERM` for every folder, every time;
 * a host that will not open a directory at all says `EISDIR`. The copy's bytes
 * were synced before it had a name, so it is published and the skip is said
 * once -- where every restored copy on Windows was called a failure after it
 * had landed. Any other folder-sync failure still refuses it (above).
 */
for (const [code, at] of [["EPERM", "sync"], ["EISDIR", "open"]]) test(`a host with no folder sync (${code} at ${at}) publishes the copy once, and says so`, async (t) => {
  const refused = () => Object.assign(new Error(`${code} SENTINEL`), { code });
  const r = host(t, { wrap: (p) => ({ ...p,
    open: async (...args) => {
      if (args[1] !== "r" || !(await p.lstat(args[0])).isDirectory()) return p.open(...args);
      if (at === "open") throw refused();
      const h = await p.open(...args);
      return { sync: async () => { throw refused(); }, close: () => h.close() };
    },
  }) });
  const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
  await writer.write(bytes);
  const stat = await writer.commit(1000);
  await writer.abort();
  assert.equal(stat.path, "Notes/copy.md");
  assert.deepEqual(readFileSync(join(r.root, "Notes/copy.md")), Buffer.from(bytes));
  assert.deepEqual(readdirSync(join(r.root, "Notes")), ["copy.md"], "one copy, and no temp beside it");
  assert.deepEqual(r.logs, [`host path_class=folder decision=skipped reason=directory_fsync code=${code}`]);
});

test("desktop refuses symlinked selected folders and only cleans its own temporary inode", async (t) => {
  const r = host(t);
  symlinkSync(join(r.root, "Admin"), join(r.root, "Notes/Linked"), "dir");
  await assert.rejects(r.h.createWriter("Notes/Linked/file.md", bytes.length, () => {}), /symlink/);
  const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
  const temp = readdirSync(join(r.root, "Notes")).find((name) => name.startsWith(".obsync-restore"));
  await fs.rename(join(r.root, "Notes", temp), join(r.root, "Notes/owned-away.tmp"));
  writeFileSync(join(r.root, "Notes", temp), "UNOWNED SENTINEL");
  await assert.rejects(writer.write(bytes), /identity/);
  await writer.abort();
  assert.equal(readFileSync(join(r.root, "Notes", temp), "utf8"), "UNOWNED SENTINEL");
  assert.equal(existsSync(join(r.root, "Notes/copy.md")), false);
});

for (const mobile of [false, true]) test(`pre-publication ${mobile ? "mobile" : "desktop"} cancellation, size and scope guards leave no destination`, async (t) => {
  for (const phase of ["write_cancel", "commit_cancel", "scope", "incomplete", "oversized"]) {
    let active = true;
    const r = host(t, { mobile });
    const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => { if (!active) throw new Error("CANCEL SENTINEL"); });
    if (phase === "write_cancel") active = false;
    if (phase === "oversized") await assert.rejects(writer.write(new Uint8Array(bytes.length + 1)), /byte budget/);
    else if (phase === "write_cancel") await assert.rejects(writer.write(bytes), /CANCEL SENTINEL/);
    else {
      await writer.write(phase === "incomplete" ? bytes.subarray(0, 1) : bytes);
      if (phase === "commit_cancel") active = false;
      if (phase === "scope") r.state.data.syncFolders = [];
      await assert.rejects(writer.commit(1000), /CANCEL SENTINEL|incomplete|scope/);
    }
    await writer.abort();
    assert.equal(existsSync(join(r.root, "Notes/copy.md")), false);
  }
});

test("desktop publication pins directory and destination identity and syncs the owned file before publishing", async (t) => {
  for (const phase of ["chain", "landed", "order"]) {
    let changed = false, fileSynced = false, timed = false, tempOpened = false;
    const r = host(t, { wrap: (p) => ({ ...p,
      lstat: async (name, ...options) => {
        const stat = await p.lstat(name, ...options);
        const alter = changed && (phase === "chain" ? name.endsWith(`${path.sep}Notes`) : phase === "landed" && name.endsWith(`${path.sep}copy.md`));
        // The neighbouring id: another file. Exact on Windows too, where an
        // NTFS file id is 64 bits, now that identity is read as a bigint
        // (#224); read as a number, past 2^53 it rounded back to the same id.
        return alter ? { ...stat, ino: stat.ino + 1n, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() } : stat;
      },
      utimes: async () => assert.fail("path-based timestamp changed an unbound file"),
      open: async (...args) => {
        const handle = await p.open(...args);
        if (args[1] !== "wx") return handle;
        assert.equal(args[2], 0o600);
        tempOpened = true;
        return { stat: (...options) => handle.stat(...options), close: () => handle.close(), write: (...values) => handle.write(...values),
          utimes: async (...values) => { timed = true; return handle.utimes(...values); },
          sync: async () => { assert.equal(timed, true); fileSynced = true; return handle.sync(); } };
      },
      link: async (...args) => {
        assert.equal(tempOpened && fileSynced, true, "publication followed complete file sync");
        await p.link(...args);
        if (phase === "landed") changed = true;
      },
    }) });
    const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
    t.after(() => writer.abort());
    if (phase === "chain") { changed = true; await assert.rejects(writer.write(bytes), /chain_changed|identity/); }
    else {
      await writer.write(bytes);
      if (phase === "landed") await assert.rejects(writer.commit(1000), /may exist/);
      else await writer.commit(1000);
    }
    await writer.abort();
    assert.equal(existsSync(join(r.root, "Notes/copy.md")), phase !== "chain");
    if (phase !== "chain") assert.deepEqual(readFileSync(join(r.root, "Notes/copy.md")), Buffer.from(bytes));
  }
});

/**
 * A volume with no hard links (issue #176). FAT32 and exFAT refuse `link`, so
 * a restored copy and a conflict copy used to end in `CopyPublicationError`
 * there. The fake filesystem refuses `link` with each code a real one gives;
 * the copy is then created exclusively and filled from the proven temp.
 */
const refusing = (code) => (p) => ({ ...p,
  rename: async () => assert.fail("overwrite fallback"),
  copyFile: async () => assert.fail("overwrite fallback"),
  link: async () => { throw Object.assign(new Error(`${code} SENTINEL`), { code }); },
});

for (const code of ["ENOTSUP", "EPERM", "EISDIR", "EXDEV"]) test(`a volume that refuses link (${code}) still publishes the copy, exclusively and once`, async (t) => {
  const r = host(t, { wrap: refusing(code) });
  const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
  await writer.write(bytes);
  const stat = await writer.commit(1757200000000);
  await writer.abort();
  assert.equal(stat.path, "Notes/copy.md");
  assert.equal(stat.size, bytes.length);
  assert.deepEqual(readFileSync(join(r.root, "Notes/copy.md")), Buffer.from(bytes));
  if (process.platform !== "win32") assert.equal(lstatSync(join(r.root, "Notes/copy.md")).mode & 0o777, 0o600);
  assert.equal(Math.round(lstatSync(join(r.root, "Notes/copy.md")).mtimeMs), 1757200000000, "the copy carries the version's time");
  assert.deepEqual(readdirSync(join(r.root, "Notes")), ["copy.md"], "the temp outlived the fallback");
  assert.ok(
    r.logs.some((line) => line.startsWith("host path_class=file decision=published reason=link_unsupported fallback=exclusive_create") &&
      line.includes(`code=${code}`) && line.includes(`bytes=${bytes.length}`)),
    r.logs.join(" | "),
  );
});

test("the fallback never replaces a file that took the name, and leaves no partial copy of its own", async (t) => {
  // A save at the copy's name between the temp's proof and the fallback's
  // create: the exclusive create refuses it exactly as `link` would.
  const taken = host(t, { wrap: (p) => ({ ...refusing("ENOTSUP")(p),
    link: async () => {
      writeFileSync(join(taken.root, "Notes/copy.md"), "SAVED MEANWHILE SENTINEL");
      throw Object.assign(new Error("ENOTSUP SENTINEL"), { code: "ENOTSUP" });
    },
  }) });
  const writer = await taken.h.createWriter("Notes/copy.md", bytes.length, () => {});
  await writer.write(bytes);
  await assert.rejects(writer.commit(1000), /may exist/);
  await writer.abort();
  assert.equal(readFileSync(join(taken.root, "Notes/copy.md"), "utf8"), "SAVED MEANWHILE SENTINEL");
  assert.deepEqual(readdirSync(join(taken.root, "Notes")), ["copy.md"], "the temp was left behind");

  // A copy that fails part-way is removed -- it is this call's own file -- and
  // nothing else is.
  const torn = host(t, { wrap: (p) => ({ ...refusing("ENOTSUP")(p),
    open: async (...args) => {
      const handle = await p.open(...args);
      if (!args[0].endsWith("copy.md")) return handle;
      return { stat: (...options) => handle.stat(...options), close: () => handle.close(), sync: () => handle.sync(), utimes: (...v) => handle.utimes(...v),
        write: async () => { throw new Error("DISK FULL SENTINEL"); } };
    },
  }) });
  const second = await torn.h.createWriter("Notes/copy.md", bytes.length, () => {});
  await second.write(bytes);
  await assert.rejects(second.commit(1000), /may exist/);
  await second.abort();
  assert.deepEqual(readdirSync(join(torn.root, "Notes")), [], "a partial copy or the temp was left behind");
});

test("a notice that asks something carries one button per answer, stays up, and a press answers it", (t) => {
  // Issues #161 and #162: the sync layer names the answers, the host draws
  // them. A statement still goes after ten seconds.
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const obsidian = box.require("obsidian");
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  const pressed = [];
  const h = new ObsidianHost({ state: { data: {} }, app: { vault: {} }, log: () => undefined, act: (action) => pressed.push(action) }, null);
  const raised = obsidian.raised.length;

  h.notify("STATEMENT SENTINEL");
  h.notify("QUESTION SENTINEL", [{ kind: "delete_everywhere" }, { kind: "restore_here" }, { kind: "fetch", fileId: "ab".repeat(16) }]);

  const [statement, question] = obsidian.raised.slice(raised);
  assert.equal(statement.messageEl.children, undefined, "a statement grew buttons");
  assert.equal(statement.duration, 10000);
  assert.equal(question.duration, 0, "a question went away before it was answered");
  const buttons = question.messageEl.children;
  assert.deepEqual(buttons.map((button) => `${button.tag}:${button.text}`), ["button:Delete everywhere", "button:Restore here", "button:Fetch"]);
  assert.equal(pressed.length, 0, "drawing the question answered it");
  buttons[1].dispatch("click");
  assert.deepEqual(pressed, [{ kind: "restore_here" }]);
  assert.equal(question.hidden, true, "the answered question stayed up");
});

test("a name already taken is not a volume without links: EEXIST never falls back", async (t) => {
  let opened = 0;
  const r = host(t, { wrap: (p) => ({ ...p,
    link: async () => { throw Object.assign(new Error("EEXIST SENTINEL"), { code: "EEXIST" }); },
    open: async (...args) => { if (args[0].endsWith("copy.md")) opened++; return p.open(...args); },
  }) });
  const writer = await r.h.createWriter("Notes/copy.md", bytes.length, () => {});
  await writer.write(bytes);
  await assert.rejects(writer.commit(1000), /may exist/);
  await writer.abort();
  assert.equal(opened, 0, "the destination was created after all");
  assert.equal(existsSync(join(r.root, "Notes/copy.md")), false);
});
