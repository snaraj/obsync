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
  const promises = wrap({ ...fs, lstat: async (p) => {
    calls.push(["lstat", p]);
    assert.ok(!p.startsWith(join(root, "Admin")), "excluded sentinel metadata was accessed");
    return fs.lstat(p);
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
  if (!mobile) assert.equal(lstatSync(join(root, stat.path)).mode & 0o777, 0o600);
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
      return { stat: () => handle.stat(), close: () => handle.close(), utimes: (...values) => handle.utimes(...values),
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
  }
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
      lstat: async (name) => {
        const stat = await p.lstat(name);
        const alter = changed && (phase === "chain" ? name.endsWith("/Notes") : phase === "landed" && name.endsWith("/copy.md"));
        return alter ? { ...stat, ino: stat.ino + 1, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() } : stat;
      },
      utimes: async () => assert.fail("path-based timestamp changed an unbound file"),
      open: async (...args) => {
        const handle = await p.open(...args);
        if (args[1] !== "wx") return handle;
        assert.equal(args[2], 0o600);
        tempOpened = true;
        return { stat: () => handle.stat(), close: () => handle.close(), write: (...values) => handle.write(...values),
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
