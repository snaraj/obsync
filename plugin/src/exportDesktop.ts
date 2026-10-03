/** Desktop filesystem adapter for exports. Never writes into the open vault. */
import { Bytes, hex, randomBytes, sha256, utf8 } from "./crypto";
import { WindowsFiles } from "./windowsFiles";
import { WindowsExport } from "./windowsExport";
import {
  decryptExportFile, ExportCheck, ExportError, ExportIndex, ExportPaths, ExportReader,
  EXPORT_BYTES_MAX, EXPORT_CHUNK_MAX, exportPath, inspectExport, writeExport,
} from "./export";

declare const require: (id: string) => unknown;
interface Stat { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; uid: bigint; mode: bigint; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
interface Handle {
  stat(options: { bigint: true }): Promise<Stat>;
  read(bytes: Bytes, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  write(bytes: Bytes): Promise<{ bytesWritten: number }>;
  close(): Promise<void>; sync(): Promise<void>; truncate(length: number): Promise<void>;
}
interface Fs {
  open(path: string, flags: string, mode?: number): Promise<Handle>;
  lstat(path: string, options: { bigint: true }): Promise<Stat>;
  mkdir(path: string, options: { mode: number; recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>; unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>; link(from: string, to: string): Promise<void>;
  statfs(path: string): Promise<{ bavail: number; bsize: number }>;
}
interface Paths { resolve(...parts: string[]): string; dirname(path: string): string; basename(path: string): string; isAbsolute(path: string): boolean; sep: string }
export interface PlainFile { path: string; size: number; mtime: number; stat: Stat }
interface Recovery { v: 1; pid: number; target: string; stage: string; identity: string | null; reserved: string | null }
type Boundary = () => Promise<void>;
export class DesktopExports {
  private readonly fs: Fs;
  private readonly path: Paths;
  private readonly process: { platform: string; pid: number; getuid(): number; kill(pid: number, signal: 0): void };
  constructor(readonly vaultRoot: string, private readonly configDir = ".obsidian", private readonly windows?: WindowsFiles) {
    this.process = require("node:process") as typeof this.process;
    const platform = this.process.platform;
    if (platform !== "darwin" && platform !== "linux" && !(platform === "win32" && windows)) throw new ExportError("private_export_unavailable");
    this.fs = (require("node:fs") as { promises: Fs }).promises;
    this.path = require("node:path") as Paths;
  }
  private async stat(path: string): Promise<Stat | null> {
    try { return await this.fs.lstat(path, { bigint: true }); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  }
  private same(a: Stat | null, b: Stat): boolean { return a !== null && a.dev === b.dev && a.ino === b.ino; }
  private identity(stat: Stat | null): string | null { return stat ? `${stat.dev}:${stat.ino}` : null; }
  private async directories(path: string): Promise<void> {
    const parent = this.path.dirname(path);
    if (parent !== path) await this.directories(parent);
    const stat = await this.stat(path);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ExportError("symlink_or_directory");
  }
  /** POSIX namespace checks; macOS ACL assurance remains a separate capability. */
  private async boundary(parent: string): Promise<Boundary> {
    const vault = await this.stat(this.path.resolve(this.vaultRoot));
    if (!vault?.isDirectory() || vault.isSymbolicLink()) throw new ExportError("vault_directory");
    const names: string[] = [], held: { path: string; stat: Stat }[] = [];
    for (let at = parent; ; at = this.path.dirname(at)) {
      if (names.length === 128) throw new ExportError("destination_depth");
      names.push(at);
      if (this.path.dirname(at) === at) break;
    }
    if (this.windows) {
      await this.windows.inspect(parent);
      for (const path of names) {
        const stat = await this.stat(path);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new ExportError("destination_ancestor_permissions");
        if (this.same(stat, vault)) throw new ExportError("destination_inside_vault");
        held.push({ path, stat });
      }
      return async () => {
        await this.windows!.inspect(parent);
        for (const entry of held) if (!this.same(await this.stat(entry.path), entry.stat)) throw new ExportError("destination_ancestor_changed");
      };
    }
    const uid = BigInt(this.process.getuid());
    const trusted = (stat: Stat | null): stat is Stat => stat !== null && stat.isDirectory() && !stat.isSymbolicLink() &&
      (stat.uid === 0n || stat.uid === uid) && ((stat.mode & 0o022n) === 0n || (stat.mode & 0o1000n) !== 0n);
    // Judge from the root: a sticky writable parent protects only children
    // owned by a trusted user, which the next entry must prove in turn.
    for (const path of names.reverse()) {
      const stat = await this.stat(path);
      if (!trusted(stat)) throw new ExportError("destination_ancestor_permissions");
      if (this.same(stat, vault)) throw new ExportError("destination_inside_vault");
      held.push({ path, stat });
    }
    return async () => {
      for (const entry of held) {
        const stat = await this.stat(entry.path);
        if (!trusted(stat) || !this.same(stat, entry.stat) || stat.uid !== entry.stat.uid || stat.mode !== entry.stat.mode)
          throw new ExportError("destination_ancestor_changed");
      }
    };
  }
  /** Only a fresh sibling output, outside this vault and standard vault ancestors. */
  private async destination(input: string, bytes: number): Promise<{ target: string; parent: string; guard: Boundary }> {
    if (!this.path.isAbsolute(input)) throw new ExportError("absolute_destination_required");
    const target = this.path.resolve(input), parent = this.path.dirname(target), vault = this.path.resolve(this.vaultRoot);
    if (target === vault || target.startsWith(vault + this.path.sep) || target === parent) throw new ExportError("destination_exists_or_vault");
    const guard = await this.boundary(parent);
    for (let at = parent; ; at = this.path.dirname(at)) {
      if (await this.stat(this.path.resolve(at, ".obsidian"))) throw new ExportError("destination_inside_vault");
      if (this.path.dirname(at) === at) break;
    }
    await guard();
    if (!this.windows) {
      await this.recover(target, guard);
      if (await this.stat(target)) throw new ExportError("destination_exists_or_vault");
    }
    const free = await this.fs.statfs(parent);
    if (free.bavail * free.bsize < bytes + 64 * 1024 * 1024) throw new ExportError("disk_budget");
    await guard();
    return { target, parent, guard };
  }
  private async all(handle: Handle, bytes: Bytes): Promise<void> {
    for (let at = 0; at < bytes.length;) {
      const { bytesWritten } = await handle.write(bytes.subarray(at));
      if (bytesWritten <= 0) throw new ExportError("short_write");
      at += bytesWritten;
    }
  }
  private async flush(path: string): Promise<void> {
    if (this.windows) return; // The native tree publication flushes each file.
    const handle = await this.fs.open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private temporary(parent: string): string { return this.path.resolve(parent, `.obsync-export-${hex(randomBytes(16))}`); }
  private async recoveryPath(target: string): Promise<string> {
    return this.path.resolve(this.path.dirname(target), `.obsync-export-recovery-${hex(await sha256(utf8(target)))}.json`);
  }
  /** The exact target's journal, never a scan of similarly named folders. */
  private async recover(target: string, guard: Boundary): Promise<void> {
    await guard();
    const path = await this.recoveryPath(target), stat = await this.stat(path);
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== BigInt(this.process.getuid()) || (stat.mode & 0o077n) !== 0n || stat.size > 8192n) throw new ExportError("recovery_record");
    const input = await this.reader(path);
    let record: Recovery;
    try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await input.read(0, input.size))) as Recovery; }
    finally { await input.close(); }
    const parent = this.path.dirname(target);
    if (record.v !== 1 || record.target !== target || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
        typeof record.stage !== "string" || this.path.dirname(record.stage) !== parent || !/^\.obsync-export-[a-f0-9]{32}$/.test(this.path.basename(record.stage)) ||
        (record.identity !== null && !/^\d+:\d+$/.test(record.identity)) || (record.reserved !== null && !/^\d+:\d+$/.test(record.reserved))) throw new ExportError("recovery_record");
    try { this.process.kill(record.pid, 0); throw new ExportError("export_in_progress"); }
    catch (error) { if ((error as { code?: string }).code !== "ESRCH") throw error; }
    const stage = await this.stat(record.stage);
    if (stage) {
      if (stage.uid !== BigInt(this.process.getuid()) || (stage.mode & 0o077n) !== 0n || stage.isSymbolicLink() || this.identity(stage) !== record.identity) throw new ExportError("recovery_identity");
      await guard();
      if (stage.isDirectory()) await this.discard(record.stage);
      else if (stage.isFile()) await this.fs.unlink(record.stage);
      else throw new ExportError("recovery_identity");
    }
    const reserved = await this.stat(target);
    await guard();
    if (reserved?.isDirectory() && this.identity(reserved) === record.reserved && (await this.fs.readdir(target)).length === 0) await this.fs.rmdir(target);
    if (!this.same(await this.stat(path), stat)) throw new ExportError("recovery_identity");
    await this.fs.unlink(path); await this.flush(parent);
  }
  private async begin(target: string, guard: Boundary): Promise<Recovery> {
    const record: Recovery = { v: 1, pid: this.process.pid, target, stage: this.temporary(this.path.dirname(target)), identity: null, reserved: null };
    const path = await this.recoveryPath(target);
    let created = false;
    try {
      await guard();
      await this.file(path, async (write) => { created = true; await write(utf8(JSON.stringify(record))); });
      await this.flush(this.path.dirname(target));
      return record;
    } catch (error) { if (created) { await guard(); await this.fs.unlink(path); } throw error; }
  }
  private async track(record: Recovery, guard: Boundary, reserved?: Stat): Promise<void> {
    await guard();
    record.identity = this.identity(await this.stat(record.stage));
    if (reserved) record.reserved = this.identity(reserved);
    const temporary = this.temporary(this.path.dirname(record.target));
    let created = false;
    try {
      await this.file(temporary, async (write) => { created = true; await write(utf8(JSON.stringify(record))); });
      await guard();
      await this.fs.rename(temporary, await this.recoveryPath(record.target));
      await this.flush(this.path.dirname(record.target));
    } finally { if (created) { await guard(); if (await this.stat(temporary)) await this.fs.unlink(temporary); } }
  }
  private async finish(record: Recovery, guard: Boundary): Promise<void> {
    await guard();
    await this.fs.unlink(await this.recoveryPath(record.target));
    await this.flush(this.path.dirname(record.target));
  }
  private async file(path: string, write: (put: (bytes: Bytes) => Promise<void>) => Promise<void>, existing = false): Promise<void> {
    const before = existing ? await this.stat(path) : null;
    const handle = await this.fs.open(path, existing ? "r+" : "wx", 0o600);
    try {
      if (existing) {
        if (!before?.isFile() || before.isSymbolicLink() || !this.same(await handle.stat({ bigint: true }), before)) throw new ExportError("stage_identity");
        await handle.truncate(0);
      }
      await write((bytes) => this.all(handle, bytes)); await handle.sync();
    } finally { await handle.close(); }
  }
  async encrypted(target: string, index: ExportIndex, vrk: Bytes, chunk: (sid: string) => Promise<Bytes>, check: ExportCheck): Promise<void> {
    const estimated = index.files.reduce((total, file) => total + file.versions.reduce((n, version) => n + version.bytes + version.sids.length * 20, 0), 64 * 1024 * 1024);
    if (this.windows) {
      const output = await this.destination(target, estimated);
      await new WindowsExport(this.windows).run(output.target, "file", hex(await sha256(utf8(JSON.stringify(index)))), output.guard, check,
        (stage, alive) => this.file(stage, write => writeExport(index, vrk, chunk, write, alive), true));
      return;
    }
    const output = await this.destination(target, estimated), record = await this.begin(output.target, output.guard), temporary = record.stage;
    let created = false;
    try {
      await output.guard();
      await this.file(temporary, async (write) => { created = true; await this.track(record, output.guard); await writeExport(index, vrk, chunk, write, check); });
      check();
      await output.guard();
      await this.fs.link(temporary, output.target);
      await this.flush(output.parent);
    } finally { await output.guard(); if (created) await this.fs.unlink(temporary); await this.finish(record, output.guard); }
  }
  /** A descriptor pins the input. Ranges cannot follow a later replacement name. */
  async reader(input: string): Promise<ExportReader & { close(): Promise<void>; fingerprint: string }> {
    const path = this.path.resolve(input);
    await this.directories(this.path.dirname(path));
    const before = await this.stat(path);
    if (!before?.isFile() || before.isSymbolicLink() || before.size > BigInt(EXPORT_BYTES_MAX)) throw new ExportError("archive_file");
    const handle = await this.fs.open(path, "r");
    try {
      const held = await handle.stat({ bigint: true });
      if (!held.isFile() || !this.same(held, before)) throw new ExportError("archive_identity");
      return {
        fingerprint: `${held.dev}:${held.ino}:${held.size}:${held.mtimeNs}`,
        size: Number(held.size), close: () => handle.close(),
        read: async (offset, length) => {
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > Number(held.size)) throw new ExportError("read_range");
          const bytes = new Uint8Array(length);
          for (let at = 0; at < length;) {
            const { bytesRead } = await handle.read(bytes, at, length - at, offset + at);
            if (bytesRead === 0) throw new ExportError("short_read");
            at += bytesRead;
          }
          const now = await handle.stat({ bigint: true });
          if (now.size !== held.size || now.mtimeNs !== held.mtimeNs) throw new ExportError("archive_changed");
          return bytes;
        },
      };
    } catch (error) { await handle.close(); throw error; }
  }
  /** Remove only descendants of an owned private stage, without following symlinks. */
  private async discard(path: string): Promise<void> {
    for (const name of await this.fs.readdir(path)) {
      const at = this.path.resolve(path, name), stat = await this.stat(at);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await this.discard(at);
      else await this.fs.unlink(at);
    }
    await this.fs.rmdir(path);
  }
  private async flushTree(root: string): Promise<void> {
    for (const name of await this.fs.readdir(root)) {
      const at = this.path.resolve(root, name), stat = await this.stat(at);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await this.flushTree(at);
    }
    await this.flush(root);
  }
  private async stage(target: string, bytes: number, check: ExportCheck, fill: (root: string, check: ExportCheck) => Promise<void>, request: string): Promise<void> {
    if (this.windows) {
      const output = await this.destination(target, bytes);
      await new WindowsExport(this.windows).run(output.target, "directory", request, output.guard, check, fill);
      return;
    }
    const output = await this.destination(target, bytes), record = await this.begin(output.target, output.guard), stage = record.stage;
    let created = false;
    try { await output.guard(); await this.fs.mkdir(stage, { mode: 0o700 }); created = true; await this.track(record, output.guard); }
    catch (error) { await output.guard(); if (created) await this.fs.rmdir(stage); await this.finish(record, output.guard); throw error; }
    const owned = await this.stat(stage);
    let reserved: Stat | null = null, published = false;
    try {
      await output.guard();
      await fill(stage, check);
      check();
      await output.guard();
      await this.flushTree(stage);
      await output.guard();
      await this.fs.mkdir(output.target, { mode: 0o700 });
      reserved = await this.stat(output.target);
      if (!reserved?.isDirectory() || (await this.fs.readdir(output.target)).length !== 0) throw new ExportError("destination_collision");
      await this.track(record, output.guard, reserved);
      check();
      await output.guard();
      if (!this.same(await this.stat(stage), owned as Stat) || !this.same(await this.stat(output.target), reserved)) throw new ExportError("stage_identity");
      await this.fs.rename(stage, output.target);
      published = true;
      try { await this.flush(output.parent); }
      catch { throw new Error("The verified export is in the destination, but its directory could not be flushed. Keep the source and check the output before relying on it."); }
    } finally {
      await output.guard();
      if (!published && owned && this.same(await this.stat(stage), owned)) await this.discard(stage);
      if (!published && reserved && this.same(await this.stat(output.target), reserved) && (await this.fs.readdir(output.target)).length === 0) await this.fs.rmdir(output.target);
      await this.finish(record, output.guard);
    }
  }
  async open(input: string, target: string, vrk: Bytes, allowServer: boolean, check: ExportCheck): Promise<{ files: number; bytes: number }> {
    const reader = await this.reader(input);
    try {
      const opened = await inspectExport(reader, vrk, allowServer, check);
      await this.stage(target, opened.bytes, check, async (root, check) => {
        for (const directory of opened.directories) { check(); await this.fs.mkdir(this.path.resolve(root, directory), { mode: 0o700, recursive: true }); }
        for (const file of opened.files) {
          check();
          const at = this.path.resolve(root, file.path);
          await this.fs.mkdir(this.path.dirname(at), { mode: 0o700, recursive: true });
          await this.file(at, (write) => decryptExportFile(reader, opened, file, write, check));
          await this.flush(this.path.dirname(at));
        }
      }, this.windows ? hex(await sha256(utf8(`open:${reader.fingerprint}:${allowServer}`))) : "");
      return { files: opened.files.length, bytes: opened.bytes };
    } finally { await reader.close(); }
  }
  /** Visible local files only, no links or hidden state. Used again to detect local changes. */
  async local(check: ExportCheck): Promise<PlainFile[]> {
    const files: PlainFile[] = [], paths = new ExportPaths();
    const configuration = await this.stat(this.path.resolve(this.vaultRoot, this.configDir));
    let bytes = 0;
    const walk = async (relative: string): Promise<void> => {
      check();
      const root = this.path.resolve(this.vaultRoot, relative);
      await this.directories(root);
      for (const name of await this.fs.readdir(root)) {
        if (name.startsWith(".")) continue;
        const path = exportPath(relative ? `${relative}/${name}` : name), at = this.path.resolve(this.vaultRoot, path), stat = await this.stat(at);
        if (configuration && this.same(stat, configuration)) continue;
        if (!stat || stat.isSymbolicLink()) throw new ExportError("local_symlink_or_change");
        if (stat.isDirectory()) {
          if (await this.stat(this.path.resolve(at, ".obsidian"))) throw new ExportError("nested_vault");
          paths.add(path, true); await walk(path);
        } else if (stat.isFile()) {
          paths.add(path, false);
          bytes += Number(stat.size);
          if (bytes > EXPORT_BYTES_MAX || files.length >= 100_000) throw new ExportError("local_budget");
          // The sync host records rounded milliseconds; keep its comparison semantics.
          const ns = stat.mtimeNs, mtime = Math.round(Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6);
          files.push({ path, size: Number(stat.size), mtime, stat });
        } else throw new ExportError("local_file_type");
      }
    };
    await walk("");
    return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  async plain(target: string, files: PlainFile[], check: ExportCheck): Promise<void> {
    if (files.some(file => file.path === this.configDir || file.path.startsWith(this.configDir + "/"))) throw new ExportError("configuration_path");
    await this.stage(target, files.reduce((n, file) => n + file.size, 0), check, async (root, check) => {
      for (const file of files) {
        check();
        const source = await this.reader(this.path.resolve(this.vaultRoot, file.path)), at = this.path.resolve(root, file.path);
        try {
          if (source.size !== file.size) throw new ExportError("local_changed");
          await this.fs.mkdir(this.path.dirname(at), { mode: 0o700, recursive: true });
          await this.file(at, async (write) => {
            for (let offset = 0; offset < source.size; offset += EXPORT_CHUNK_MAX) {
              check(); await write(await source.read(offset, Math.min(EXPORT_CHUNK_MAX, source.size - offset)));
            }
          });
          await this.flush(this.path.dirname(at));
        } finally { await source.close(); }
      }
      const current = await this.local(check);
      if (current.length !== files.length || current.some((file, n) => file.path !== files[n]?.path || !this.same(file.stat, files[n]!.stat) || file.stat.mtimeNs !== files[n]!.stat.mtimeNs || file.size !== files[n]!.size)) throw new ExportError("local_changed");
    }, this.windows ? hex(await sha256(utf8(JSON.stringify(files.map(file => [file.path, file.size, `${file.stat.dev}:${file.stat.ino}:${file.stat.mtimeNs}`]))))) : "");
  }
}
