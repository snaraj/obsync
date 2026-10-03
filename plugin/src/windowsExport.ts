/** Exact-target Windows export journal. Content/crypto stays in exportDesktop. */
import { Bytes, hex, randomBytes, sha256, utf8 } from "./crypto";
import { ExportError } from "./export";
import { WindowsFiles } from "./windowsFiles";

declare const require: (id: string) => unknown;
interface Stat { dev: bigint; ino: bigint; nlink: bigint; size: bigint; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
interface Handle { stat(options: { bigint: true }): Promise<Stat>; read(bytes: Bytes, offset: number, length: number, position: number): Promise<{ bytesRead: number }>; writeFile(bytes: Uint8Array): Promise<void>; sync(): Promise<void>; close(): Promise<void> }
interface Fs {
  lstat(path: string, options: { bigint: true }): Promise<Stat>; open(path: string, flags: string): Promise<Handle>;
  readdir(path: string): Promise<string[]>; unlink(path: string): Promise<void>; rmdir(path: string): Promise<void>;
}
interface Record { v: 1; target: string; stage: string; kind: "file" | "directory"; request: string; identity: string; parent: string }
const identity = (stat: Stat | null): string => stat ? `${stat.dev}:${stat.ino}` : "missing";
export class WindowsExport {
  private readonly fs = (require("node:fs") as { promises: Fs }).promises;
  constructor(private readonly files: WindowsFiles) {}
  private async stat(path: string): Promise<Stat | null> {
    try { return await this.fs.lstat(path, { bigint: true }); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  }
  private async read(path: string): Promise<Bytes> {
    const before = await this.stat(path);
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 8192n) throw new ExportError("recovery_record");
    const file = await this.fs.open(path, "r");
    try {
      if (identity(await file.stat({ bigint: true })) !== identity(before)) throw new ExportError("recovery_identity");
      const bytes = new Uint8Array(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== Number(before.size)) throw new ExportError("recovery_record");
      return bytes.subarray(0, length);
    } finally { await file.close(); }
  }
  private async write(path: string, bytes: Uint8Array): Promise<void> {
    // The already proven private parent supplies the DACL at creation; native
    // publication independently checks every actual DACL and flushes the files.
    const file = await this.fs.open(path, "wx");
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  private async clear(root: string, removeRoot: boolean, check: () => void): Promise<void> {
    let count = 0;
    const visit = async (path: string, remove: boolean): Promise<void> => {
      check();
      if (++count > 100000) throw new ExportError("local_budget");
      const stat = await this.stat(path);
      if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) throw new ExportError("recovery_identity");
      if (stat.isDirectory()) {
        for (const name of await this.fs.readdir(path)) await visit(`${path}\\${name}`, true);
        if (identity(await this.stat(path) as Stat) !== identity(stat)) throw new ExportError("recovery_identity");
        if (remove) await this.fs.rmdir(path);
      } else if (remove) await this.fs.unlink(path);
      else {
        const file = await this.fs.open(path, "r+");
        try {
          if (identity(await file.stat({ bigint: true })) !== identity(stat)) throw new ExportError("recovery_identity");
        } finally { await file.close(); }
      }
    };
    await visit(root, removeRoot);
  }
  async run(target: string, kind: "file" | "directory", request: string, guard: () => Promise<void>, check: () => void,
    fill: (stage: string, alive: () => void) => Promise<void>): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(request)) throw new ExportError("recovery_request");
    const parent = target.slice(0, target.lastIndexOf("\\"));
    const journal = `${parent}\\.obsync-export-state-${hex(await sha256(utf8(target.toUpperCase())))}`;
    await guard(); check();
    if (!await this.stat(journal)) {
      if (await this.stat(target)) throw new ExportError("destination_exists_or_vault");
      const stage = `${parent}\\.obsync-export-${hex(randomBytes(16))}`;
      const temporary = `${parent}\\.obsync-export-${hex(randomBytes(16))}`;
      let staged: Stat | null = null, prepared: Stat | null = null;
      try {
        if (kind === "directory") await this.files.mkdir(stage); else await this.files.create(stage);
        staged = await this.stat(stage);
        await this.files.mkdir(temporary); prepared = await this.stat(temporary);
        const record: Record = { v: 1, target, stage, kind, request, identity: identity(staged as Stat), parent: identity(await this.stat(parent) as Stat) };
        await this.write(`${temporary}\\lock`, new Uint8Array());
        await this.write(`${temporary}\\record.json`, utf8(JSON.stringify(record)));
        await guard(); check();
        await this.files.publish(temporary, journal, check);
        prepared = null; staged = null;
      } catch (error) {
        // Before the durable journal exists, no source content has been read
        // into the stage. Delete only exact identities this process created.
        if (!await this.stat(journal)) {
          if (prepared && identity(await this.stat(temporary)) === identity(prepared)) await this.clear(temporary, true, check);
          if (staged && identity(await this.stat(stage)) === identity(staged)) await this.clear(stage, true, check);
        }
        throw error;
      }
    }
    await this.files.inspect(journal);
    await this.files.locked(`${journal}\\lock`, check, async alive => {
      const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.read(`${journal}\\record.json`))) as Record;
      if (!raw || Object.keys(raw).sort().join() !== "identity,kind,parent,request,stage,target,v" || raw.v !== 1 || raw.target !== target ||
          raw.kind !== kind || raw.request !== request || typeof raw.stage !== "string" ||
          !raw.stage.startsWith(parent + "\\.obsync-export-") || !/^\.obsync-export-[a-f0-9]{32}$/.test(raw.stage.slice(parent.length + 1)) ||
          !/^\d+:\d+$/.test(raw.identity) || raw.parent !== identity(await this.stat(parent) as Stat)) throw new ExportError("recovery_record");
      const ready = `${journal}\\ready.json`, pending = `${journal}\\ready.pending`;
      const completion = utf8(JSON.stringify({ v: 1, request, identity: raw.identity }));
      const completed = await this.stat(ready);
      if (completed && hex(await sha256(await this.read(ready))) !== hex(await sha256(completion))) throw new ExportError("recovery_record");
      const published = await this.stat(target), stage = await this.stat(raw.stage);
      if (published) {
        if (!completed || stage || identity(published) !== raw.identity) throw new ExportError("destination_exists_or_vault");
        await this.files.inspect(target); await guard(); alive(); return;
      }
      if (!stage || identity(stage) !== raw.identity || stage.isSymbolicLink() || (kind === "directory" ? !stage.isDirectory() : !stage.isFile() || stage.nlink !== 1n)) throw new ExportError("recovery_identity");
      await this.files.inspect(raw.stage); alive();
      // Every surviving stage is rebuilt from the same bound input. A receipt
      // never substitutes for revalidating content after an interrupted fill.
      await this.clear(raw.stage, false, alive);
      await fill(raw.stage, alive); await guard(); alive();
      if (!completed) {
        if (await this.stat(pending)) {
          const previous = await this.read(pending);
          if (previous.length > completion.length || !previous.every((byte, at) => byte === completion[at])) throw new ExportError("recovery_record");
          await this.fs.unlink(pending);
        }
        await this.write(pending, completion);
        await this.files.publish(pending, ready, alive);
      }
      await guard(); alive();
      if (identity(await this.stat(raw.stage) as Stat) !== raw.identity) throw new ExportError("recovery_identity");
      await this.files.publish(raw.stage, target, alive);
      await guard(); alive();
    });
  }
}
