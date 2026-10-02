import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { scratch } from "./fake.mjs";
const require = createRequire(import.meta.url);
const c = require("../build/crypto.js"), e = require("../build/export.js");
const { DesktopExports } = require("../build/exportDesktop.js");
const key = new Uint8Array(32).fill(21), domain = "d1".repeat(16), check = () => {};

async function fixture(specs = [{ path: "Notes/sentinel.md", text: "sentinel note\n" }]) {
  const dk = await c.deriveDomainKey(key, domain), mk = await c.deriveManifestKey(dk, domain);
  const chunks = new Map(), files = [];
  for (const [n, spec] of specs.entries()) {
    const fileId = spec.fileId ?? (n + 1).toString(16).padStart(32, "0");
    const data = spec.data ?? c.utf8(spec.text ?? "sentinel");
    const parts = [];
    for (let at = 0; at < data.length || at === 0; at += 8 * 1024 * 1024) {
      const part = data.slice(at, at + 8 * 1024 * 1024), sealed = await c.encryptChunk(dk, part);
      chunks.set(sealed.sid, sealed.ciphertext); parts.push({ sid: sealed.sid, cid: c.hex(sealed.cid), len: part.length });
    }
    const parents = spec.parents ?? [], sids = parts.map((p) => p.sid);
    const manifest = { v: 1, path: spec.path, domain, mtime: 1, size: data.length, chunks: parts, deleted: false,
      sha256: parts.length === 1 ? c.hex(await c.sha256(data)) : "", ...spec.manifest };
    const sealed = await c.encryptManifest(mk, fileId, await c.contentVersionId(fileId, parents, sids), JSON.stringify(manifest));
    const version = { version_id: await c.versionId(fileId, parents, sealed.ciphertext, sids), parents, sids, bytes: data.length,
      manifest_ct: c.base64(sealed.ciphertext), manifest_nonce: c.hex(sealed.nonce), deleted: false };
    let file = files.find((f) => f.file_id === fileId);
    if (!file) files.push(file = { file_id: fileId, domain_id: domain, heads: [], versions: [] });
    file.versions.push(version); file.heads.push(version.version_id);
  }
  return { index: { v: 1, source: "device", scope: "current", snapshot: 7, files }, chunks };
}
async function archive(f) {
  const parts = [];
  await e.writeExport(f.index, key, async (sid) => f.chunks.get(sid), async (b) => parts.push(b), check);
  return Buffer.concat(parts);
}
const reader = (bytes) => ({ size: bytes.length, read: async (at, n) => new Uint8Array(bytes.slice(at, at + n)) });
async function disk(t) {
  const root = await realpath(scratch("export"));
  const vault = join(root, "sentinel-vault"); await mkdir(vault);
  return { root, vault, desktop: new DesktopExports(vault) };
}

// Independent Node primitives verify the format, rather than round-trip alone.
test("device format has a keyed inventory and exact independent digest", async () => {
  const bytes = await archive(await fixture()), at = e.EXPORT_MAGIC.length, n = bytes.readUInt32BE(at), raw = bytes.subarray(at + 4, at + 4 + n);
  assert.equal(bytes.subarray(0, at).toString(), "OBSYNC-EXPORT-1\n");
  const digest = createHash("sha256").update(raw).digest();
  assert.deepEqual(bytes.subarray(at + 4 + n, at + 36 + n), digest);
  const auth = createHmac("sha256", hkdfSync("sha256", key, "obsync/export/v1/inventory", "", 32)).update(digest).digest();
  assert.deepEqual(bytes.subarray(at + 36 + n, at + 68 + n), auth);
  assert.equal(JSON.parse(raw).source, "device");
  assert.equal(bytes.includes(Buffer.from("Notes/sentinel.md")), false);
});

test("real desktop export opens offline with exact names and multi-chunk bytes", async (t) => {
  const { root, desktop } = await disk(t), data = new Uint8Array(8 * 1024 * 1024 + 19).fill(42);
  const f = await fixture([{ path: "Notes/sentinel.md", text: "sentinel note\r\n" }, { path: "Files/sentinel.bin", data }, { path: "Empty.md", text: "" }]);
  const encrypted = join(root, "copy.obsync"), output = join(root, "opened");
  await desktop.encrypted(encrypted, f.index, key, async (sid) => f.chunks.get(sid), check);
  assert.deepEqual(await desktop.open(encrypted, output, key, false, check), { files: 3, bytes: data.length + 15 });
  assert.equal(await readFile(join(output, "Notes/sentinel.md"), "utf8"), "sentinel note\r\n");
  assert.deepEqual(new Uint8Array(await readFile(join(output, "Files/sentinel.bin"))), data);
  assert.equal((await readFile(join(output, "Empty.md"))).length, 0);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, "Notes/sentinel.md"))).mode & 0o777, 0o600);
  assert.equal((await readdir(root)).some((name) => name.startsWith(".obsync-export-")), false);
});

test("every conflicting head survives, with explicit retained history", async () => {
  const fileId = "01".repeat(16), f = await fixture([{ path: "sentinel.md", text: "sentinel a", fileId }, { path: "sentinel.md", text: "sentinel b", fileId }]);
  const opened = await e.inspectExport(reader(await archive(f)), key, false, check);
  assert.equal(opened.files.length, 2);
  assert.equal(opened.files.filter((file) => file.path === "sentinel.md").length, 1);
  assert.equal(opened.files.filter((file) => file.path.startsWith("obsync-conflicts/")).length, 1);
  f.index.scope = "history"; f.index.files[0].heads = [f.index.files[0].versions[1].version_id];
  const withHistory = await e.inspectExport(reader(await archive(f)), key, false, check);
  assert.equal(withHistory.files.filter((file) => file.path.startsWith("obsync-history/")).length, 1);
  f.index.scope = "current";
  await assert.rejects(archive(f), /unselected_version/);
});

test("feed walk requires a coherent complete selection before it signs", async () => {
  const f = await fixture(), version = f.index.files[0].versions[0], file = f.index.files[0];
  const change = { ...version, seq: 2, file_id: file.file_id, domain_id: domain, heads: file.heads };
  const transport = { changes: async (since) => ({ seq: 7, head_seq: 7, changes: since === 0 ? [change] : [] }) };
  const selected = await e.selectExport(transport, false, check);
  assert.equal(selected.files.length, 1); assert.equal(selected.files[0].versions.length, 1);
  await assert.rejects(e.selectExport({ changes: async (since) => ({ seq: since === 0 ? 7 : 8, head_seq: since === 0 ? 7 : 8, changes: since === 0 ? [change] : [] }) }, false, check), /snapshot_changed/);
  await assert.rejects(e.selectExport({ changes: async () => ({ seq: 0, head_seq: 7, changes: [] }) }, false, check), /feed_progress/);
  await assert.rejects(e.selectExport({ changes: async (since) => ({ seq: 7, head_seq: 7, changes: since === 0 ? [{ ...change, heads: [...file.heads, "ab".repeat(32)] }] : [] }) }, false, check), /missing_head/);
});

test("wrong key and ordinary malformed inputs leave no published or staged plaintext", async (t) => {
  const { root, desktop } = await disk(t), original = await archive(await fixture()), input = join(root, "input.obsync");
  const badDigest = Buffer.from(original); badDigest[badDigest.length - 1] ^= 1;
  for (const [n, bytes, vrk] of [[0, original, new Uint8Array(32)], [1, original.subarray(0, -1), key], [2, Buffer.concat([original, Buffer.of(0)]), key], [3, badDigest, key]]) {
    await writeFile(input, bytes);
    await assert.rejects(desktop.open(input, join(root, `refused-${n}`), vrk, false, check));
    assert.deepEqual((await readdir(root)).sort(), ["input.obsync", "sentinel-vault"]);
  }
});

test("changed inventory needs its device authenticator even with an updated digest", async () => {
  const bytes = await archive(await fixture()), at = e.EXPORT_MAGIC.length, n = bytes.readUInt32BE(at);
  const index = JSON.parse(bytes.subarray(at + 4, at + 4 + n)); index.snapshot++;
  const raw = Buffer.from(JSON.stringify(index)); assert.equal(raw.length, n);
  raw.copy(bytes, at + 4); createHash("sha256").update(raw).digest().copy(bytes, at + 4 + n);
  await assert.rejects(e.inspectExport(reader(bytes), key, false, check), /inventory_authentication/);
});

test("framing and schema budgets refuse before a chunk or filesystem operation", async () => {
  const f = await fixture();
  for (const change of [
    (i) => { i.v = 2; }, (i) => { i.snapshot = -1; },
    (i) => { i.files[0].heads = []; }, (i) => { i.files.push(i.files[0]); },
    (i) => { i.files[0].versions.push(i.files[0].versions[0]); },
    (i) => { i.files[0].versions[0].manifest_nonce = "invalid"; },
    (i) => { i.files[0].versions[0].deleted = true; },
    (i) => { i.files[0].versions[0].bytes = e.EXPORT_BYTES_MAX + 1; },
    (i) => { i.files[0].versions[0].manifest_ct = "invalid"; },
  ]) {
    const index = structuredClone(f.index); change(index);
    await assert.rejects(e.validateExport(index, check));
  }
  await assert.rejects(e.inspectExport({ size: e.EXPORT_BYTES_MAX + 1, read() { assert.fail("read before archive budget"); } }, key, false, check), /archive_budget/);
  const bytes = await archive(f), length = e.EXPORT_MAGIC.length;
  bytes.writeUInt32BE(e.EXPORT_INDEX_MAX + 1, length);
  await assert.rejects(e.inspectExport(reader(bytes), key, false, check), /metadata_budget/);
});

test("ciphertext digest and length are checked before plaintext staging", async (t) => {
  const { root, desktop } = await disk(t), original = await archive(await fixture()), input = join(root, "input.obsync");
  const frame = e.EXPORT_MAGIC.length + 4 + original.readUInt32BE(e.EXPORT_MAGIC.length) + 64;
  for (const reason of ["chunk_budget", "chunk_digest"]) {
    const bytes = Buffer.from(original);
    if (reason === "chunk_budget") bytes.writeUInt32BE(e.EXPORT_CHUNK_MAX + 1, frame);
    else bytes[bytes.length - 1] ^= 1;
    await writeFile(input, bytes);
    await assert.rejects(desktop.open(input, join(root, "refused"), key, false, check), new RegExp(reason));
    assert.deepEqual((await readdir(root)).sort(), ["input.obsync", "sentinel-vault"]);
  }
});

test("a missing selected chunk is named and no encrypted output is published", async (t) => {
  const { root, desktop } = await disk(t), f = await fixture(), sid = f.index.files[0].versions[0].sids[0];
  await assert.rejects(desktop.encrypted(join(root, "missing.obsync"), f.index, key,
    async () => { throw { code: "unknown_chunk" }; }, check), new RegExp(`missing_chunk.*${sid}`));
  assert.deepEqual(await readdir(root), ["sentinel-vault"]);
});

test("unsupported desktop platforms refuse before loading filesystem access", async () => {
  const source = await readFile(new URL("../build/exportDesktop.js", import.meta.url), "utf8");
  const wrapped = runInNewContext(`(function(require, exports) { ${source}\n})`);
  for (const platform of ["win32", "unknown"]) {
    const exports = {};
    wrapped((name) => {
      if (name === "node:process") return { platform };
      assert.ok(!name.startsWith("node:"), "filesystem loaded before platform refusal");
      return require(`../build/${name.replace(/^\.\//, "")}.js`);
    }, exports);
    assert.throws(() => new exports.DesktopExports("sentinel-vault"), /private_export_unavailable/);
  }
});

test("path and size refusals leave the destination absent", async (t) => {
  const { root, desktop } = await disk(t), input = join(root, "input.obsync");
  for (const specs of [[{ path: "../sentinel.md" }], [{ path: "CON.md" }], [{ path: "Sentinel.md" }, { path: "sentinel.md" }], [{ path: "sentinel.md", manifest: { size: 22 } }]]) {
    const bytes = await archive(await fixture(specs));
    if (specs.length === 2) await assert.rejects(e.inspectExport(reader(bytes), key, false, check), /path_collision/);
    await writeFile(input, bytes);
    await assert.rejects(desktop.open(input, join(root, "refused"), key, false, check));
    assert.deepEqual((await readdir(root)).sort(), ["input.obsync", "sentinel-vault"]);
  }
});

test("ciphertext-only server archive requires explicit provenance acknowledgment", async () => {
  const f = await fixture(); f.index.source = "server";
  const raw = Buffer.from(JSON.stringify(f.index)), len = Buffer.alloc(4); len.writeUInt32BE(raw.length);
  const parts = [Buffer.from(e.EXPORT_MAGIC), len, raw, createHash("sha256").update(raw).digest(), Buffer.alloc(32)];
  for (const [, chunk] of [...f.chunks.entries()].sort(([a], [b]) => a.localeCompare(b))) { const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length); parts.push(size, chunk); }
  const bytes = Buffer.concat(parts);
  await assert.rejects(e.inspectExport(reader(bytes), key, false, check), /server_inventory_unverified/);
  assert.equal((await e.inspectExport(reader(bytes), key, true, check)).files.length, 1);
  await assert.rejects(e.inspectExport(reader(bytes), new Uint8Array(32), true, check));
});

test("plain copy excludes hidden state and refuses changed or live-vault destinations", async (t) => {
  const { root, vault, desktop } = await disk(t);
  await writeFile(join(vault, "sentinel.md"), "sentinel local");
  await mkdir(join(vault, ".obsidian")); await writeFile(join(vault, ".obsidian", "private.json"), "sentinel metadata");
  let files = await desktop.local(check);
  assert.equal(files.length, 1);
  await desktop.plain(join(root, "plain"), files, check);
  assert.equal(await readFile(join(root, "plain/sentinel.md"), "utf8"), "sentinel local");
  await assert.rejects(desktop.plain(join(vault, "copy"), files, check), /destination_exists_or_vault/);
  await assert.rejects(desktop.plain(join(root, "plain"), files, check), /destination_exists_or_vault/);
  files = await desktop.local(check);
  await writeFile(join(vault, "sentinel.md"), "sentinel changed");
  await assert.rejects(desktop.plain(join(root, "changed"), files, check), /local_changed/);
  assert.deepEqual((await readdir(root)).sort(), ["plain", "sentinel-vault"]);
});

test("mid-copy cancellation deletes its stage and preserves existing files", async (t) => {
  const { root, desktop } = await disk(t), f = await fixture(), input = join(root, "input.obsync"), existing = join(root, "occupied");
  await writeFile(input, await archive(f)); await mkdir(existing); await writeFile(join(existing, "sentinel.md"), "kept");
  await assert.rejects(desktop.open(input, existing, key, false, check), /destination_exists_or_vault/);
  assert.equal(await readFile(join(existing, "sentinel.md"), "utf8"), "kept");
  await assert.rejects(desktop.open(input, join(root, "cancelled"), key, false, () => {
    const stage = readdirSync(root).find((name) => name.startsWith(".obsync-export-"));
    if (stage && existsSync(join(root, stage, "Notes/sentinel.md"))) throw new e.ExportError("cancelled");
  }), /cancelled/);
  assert.deepEqual((await readdir(root)).sort(), ["input.obsync", "occupied", "sentinel-vault"]);
});

test("plain copy excludes the active vault's non-dot configuration directory", async (t) => {
  const { root, vault } = await disk(t), desktop = new DesktopExports(vault, "custom-config");
  await writeFile(join(vault, "sentinel.md"), "visible note");
  await mkdir(join(vault, "custom-config"));
  await writeFile(join(vault, "custom-config", "data.json"), "synthetic private configuration");
  const files = await desktop.local(check);
  assert.deepEqual(files.map(file => file.path), ["sentinel.md"]);
  assert.equal(files[0].mtime, Math.round((await stat(join(vault, "sentinel.md"))).mtimeMs));
  await desktop.plain(join(root, "plain"), files, check);
  assert.deepEqual(await readdir(join(root, "plain")), ["sentinel.md"]);
  assert.equal(await readFile(join(vault, "custom-config", "data.json"), "utf8"), "synthetic private configuration");
  const standard = new DesktopExports(vault);
  await assert.rejects(desktop.plain(join(root, "refused"), await standard.local(check), check), /configuration_path/);
  assert.equal(existsSync(join(root, "refused")), false);
});

test("case aliases cannot put an output in the active vault's custom configuration", async (t) => {
  const { root, vault } = await disk(t), alias = join(root, "SENTINEL-VAULT");
  const original = await stat(vault), aliased = await stat(alias).catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  if (!aliased || original.dev !== aliased.dev || original.ino !== aliased.ino) return t.skip("case-sensitive filesystem");
  const desktop = new DesktopExports(vault, "custom-config"), config = join(vault, "custom-config");
  await mkdir(config); await writeFile(join(config, "sentinel.json"), "synthetic configuration");
  await assert.rejects(desktop.plain(join(alias, "custom-config", "copy"), [], check), /destination_inside_vault/);
  assert.deepEqual(await readdir(config), ["sentinel.json"]);
  assert.equal(await readFile(join(config, "sentinel.json"), "utf8"), "synthetic configuration");
});

test("writable destination ancestors refuse; a sticky parent with an owned child works", async (t) => {
  const { root, desktop } = await disk(t), parent = join(root, "parent"), child = join(parent, "owned");
  await mkdir(parent); await mkdir(child, { mode: 0o700 });
  try {
    for (const mode of [0o770, 0o702, 0o777]) {
      await chmod(parent, mode);
      await assert.rejects(desktop.plain(join(child, "copy"), [], check), /destination_ancestor_permissions/);
      assert.deepEqual(await readdir(child), []);
    }
    await chmod(parent, 0o1777);
    await desktop.plain(join(child, "copy"), [], check);
    assert.equal((await stat(join(child, "copy"))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(child), ["copy"]);
  } finally { await chmod(parent, 0o700); }
});

test("destination guard detects sequential inode and permission changes", async (t) => {
  const { root, desktop } = await disk(t), parent = join(root, "parent");
  await mkdir(parent, { mode: 0o700 });
  const held = await desktop.boundary(parent);
  await held();
  await rename(parent, join(root, "original-parent"));
  await mkdir(parent, { mode: 0o700 });
  await assert.rejects(held(), /destination_ancestor_changed/);
  await chmod(parent, 0o750);
  const current = await desktop.boundary(parent);
  await chmod(parent, 0o700);
  await assert.rejects(current(), /destination_ancestor_changed/);
  await (await desktop.boundary(parent))();
});

test("destination preflight requires a vault, a bounded path and a trusted owner", async (t) => {
  const { root, desktop } = await disk(t);
  await assert.rejects(new DesktopExports(join(root, "missing-vault")).boundary(root), /vault_directory/);
  await assert.rejects(desktop.boundary(join(root, ...Array(128).fill("unopened"))), /destination_depth/);
  // A foreign ownership verdict without chown, privilege or a second OS user.
  desktop.process = { ...desktop.process, getuid: () => process.getuid() + 1 };
  await assert.rejects(desktop.boundary(root), /destination_ancestor_permissions/);
});

test("a changed destination boundary stops publication and cleanup", async (t) => {
  const { root, desktop } = await disk(t), parent = join(root, "parent"), target = join(parent, "copy");
  await mkdir(parent); await chmod(parent, 0o750);
  await assert.rejects(desktop.stage(target, 8, check, async stage => {
    await writeFile(join(stage, "sentinel.md"), "retained", { mode: 0o600 });
    await chmod(parent, 0o700);
  }), /destination_ancestor_changed/);
  assert.equal(existsSync(target), false);
  const names = await readdir(parent), stage = names.find(name => /^\.obsync-export-[a-f0-9]{32}$/.test(name));
  assert.ok(stage);
  assert.equal(names.length, 2);
  assert.equal(names.filter(name => name.startsWith(".obsync-export-recovery-")).length, 1);
  assert.equal(await readFile(join(parent, stage, "sentinel.md"), "utf8"), "retained");
});

test("a crashed child leaves private staging that the next attempt removes before publishing", async (t) => {
  const { root, vault, desktop } = await disk(t), input = join(root, "input.obsync"), target = join(root, "opened");
  await writeFile(input, await archive(await fixture()));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    import { readdirSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const require = createRequire(import.meta.url), { DesktopExports } = require('./build/exportDesktop.js');
    const [root, vault, input, target] = process.argv.slice(1);
    await new DesktopExports(vault).open(input, target, new Uint8Array(32).fill(21), false, () => {
      const stage = readdirSync(root).find(n => /^\\.obsync-export-[a-f0-9]{32}$/.test(n));
      if (stage && existsSync(join(root, stage, 'Notes/sentinel.md'))) process.exit(23);
    });
  `, root, vault, input, target], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(existsSync(target), false);
  const stage = (await readdir(root)).find(n => /^\.obsync-export-[a-f0-9]{32}$/.test(n));
  assert.ok(stage); assert.equal((await stat(join(root, stage))).mode & 0o777, 0o700);
  const record = (await readdir(root)).find(n => n.startsWith(".obsync-export-recovery-"));
  assert.ok(record); assert.equal((await stat(join(root, record))).mode & 0o777, 0o600);
  assert.equal((await desktop.open(input, target, key, false, check)).files, 1);
  assert.equal(await readFile(join(target, "Notes/sentinel.md"), "utf8"), "sentinel note\n");
  assert.deepEqual((await readdir(root)).sort(), ["input.obsync", "opened", "sentinel-vault"]);
});

test("recovery refuses an active or unidentified attempt without removing its files", async (t) => {
  const { root, vault, desktop } = await disk(t), target = join(root, "copy"), input = join(root, "input.obsync");
  await writeFile(input, await archive(await fixture()));
  const stage = join(root, `.obsync-export-${"12".repeat(16)}`), held = join(stage, "sentinel.md");
  await mkdir(stage, { mode: 0o700 }); await writeFile(held, "keep");
  const s = await stat(stage, { bigint: true }), journal = join(root, `.obsync-export-recovery-${createHash("sha256").update(target).digest("hex")}.json`);
  const entry = { v: 1, pid: process.pid, target, stage, identity: `${s.dev}:${s.ino}`, reserved: null };
  await writeFile(journal, JSON.stringify(entry), { mode: 0o600 });
  await assert.rejects(desktop.open(input, target, key, false, check), /export_in_progress/);
  entry.target = join(vault, "foreign"); await writeFile(journal, JSON.stringify(entry));
  await assert.rejects(desktop.open(input, target, key, false, check), /recovery_record/);
  const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  assert.throws(() => process.kill(exited.pid, 0), { code: "ESRCH" });
  entry.target = target; entry.pid = exited.pid; entry.identity = `${s.dev}:${s.ino + 1n}`;
  await writeFile(journal, JSON.stringify(entry));
  await assert.rejects(desktop.open(input, target, key, false, check), /recovery_identity/);
  assert.equal(await readFile(held, "utf8"), "keep"); assert.equal(existsSync(target), false);
});
