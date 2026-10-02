/** Shared, disabled-at-product-boundary Windows custody/publication candidate.
 * A trusted setup must bind the OS PowerShell executable; never discover it
 * from the environment. The plugin bundle embeds the same helper as the CLI.
 */
import { hex, sha256, utf8 } from "./crypto";

declare const require: (id: string) => unknown;
interface Stat {
  dev: bigint; ino: bigint; nlink: bigint; size: bigint; mtimeNs: bigint;
  isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
}
interface Handle {
  stat(options: { bigint: true }): Promise<Stat>;
  read(bytes: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
async function bounded(handle: Handle, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(max + 1);
  let at = 0;
  while (at < bytes.length) {
    const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
    if (!bytesRead) break;
    at += bytesRead;
  }
  if (at > max) throw Error("windows_file_budget");
  return bytes.subarray(0, at);
}
interface Fs {
  lstat(path: string, options: { bigint: true }): Promise<Stat>;
  open(path: string, flags: string): Promise<Handle>; opendir(path: string): Promise<AsyncIterable<{ name: string }>>;
}
interface Child {
  stdin: { end(value: string): void; on(event: "error", listener: () => void): void };
  stdout: { on(event: "data", listener: (data: Uint8Array) => void): void };
  stderr: { on(event: "data", listener: (data: Uint8Array) => void): void };
  on(event: "error", listener: () => void): void;
  on(event: "close", listener: (code: number | null) => void): void; kill(): void;
}
interface Spawn {
  spawn(file: string, args: string[], options: {
    shell: false; windowsHide: true; cwd: string; env: Record<string, string>;
    stdio: ["pipe", "pipe", "pipe"];
  }): Child;
}
/** Supplied only by explicit trusted OS setup, never a CLI/request option. */
export interface WindowsPowerShell { path: string; sha256: string }

export class WindowsFiles {
  private readonly fs: Fs;
  private readonly spawn: Spawn;
  private readonly command: string;
  private readonly helper: { source: string; sha256: string };
  constructor(private readonly powershell: WindowsPowerShell) {
    if ((require("node:process") as { platform: string }).platform !== "win32") throw Error("windows_platform_required");
    if (!/^[A-Z]:\\[^\x00-\x1f<>:"/|?*]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(powershell.path) ||
        !/^[a-f0-9]{64}$/.test(powershell.sha256)) throw Error("trusted_powershell_required");
    this.fs = (require("node:fs") as { promises: Fs }).promises;
    this.spawn = require("node:child_process") as Spawn;
    this.helper = require("./windowsHelperData") as typeof this.helper;
    if (typeof this.helper.source !== "string" || this.helper.source.length > 12080 || /[^\x00-\x7f]/.test(this.helper.source) ||
        !/^[a-f0-9]{64}$/.test(this.helper.sha256)) throw Error("windows_helper_integrity");
    const buffer = require("node:buffer") as { Buffer: { from(value: string, encoding: string): { toString(encoding: string): string } } };
    this.command = buffer.Buffer.from(this.helper.source, "utf16le").toString("base64");
  }
  /** Import the exact digest displayed by explicit trusted OS setup. An ambient
   * receipt is insufficient: verify its bytes before using its executable path.
   */
  static async fromReceipt(path: string, expected: string): Promise<WindowsFiles> {
    if (!/^[a-f0-9]{64}$/.test(expected) || !path.endsWith("\\powershell.json")) throw Error("windows_trust_receipt");
    const fs = (require("node:fs") as { promises: Fs }).promises;
    const before = await fs.lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 8192n) throw Error("windows_trust_receipt");
    const handle = await fs.open(path, "r");
    let value: { schema_version: number; directory: string; powershell: WindowsPowerShell };
    try {
      const held = await handle.stat({ bigint: true });
      if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size) throw Error("windows_trust_receipt");
      const bytes = await bounded(handle, 8192);
      if (bytes.length > 8192 || hex(await sha256(bytes)) !== expected) throw Error("windows_trust_receipt");
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as typeof value;
    } finally { await handle.close(); }
    if (!value || Object.keys(value).sort().join() !== "directory,powershell,schema_version" || value.schema_version !== 1 ||
        value.directory !== path.slice(0, -"\\powershell.json".length) || !value.powershell ||
        Object.keys(value.powershell).sort().join() !== "path,sha256") throw Error("windows_trust_receipt");
    const files = new WindowsFiles(value.powershell);
    await files.inspect(value.directory); await files.inspect(path);
    return files;
  }
  private async stat(path: string): Promise<Stat | null> {
    try { return await this.fs.lstat(path, { bigint: true }); }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return null; throw error; }
  }
  private same(a: Stat | null, b: Stat): boolean { return a !== null && a.dev === b.dev && a.ino === b.ino; }
  private path(path: string): void {
    if (typeof path !== "string" || path.length > 240 || !/^[A-Z]:\\/.test(path) || /[\x00-\x1f\x7f/<>"|?*]/.test(path) ||
        path.slice(2).includes(":")) throw Error("windows_path_spelling");
    for (const part of path.slice(3).split("\\")) {
      if (!part || part === "." || part === ".." || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) throw Error("windows_path_spelling");
    }
  }
  private async custody(path: string): Promise<Stat> {
    this.path(path);
    const stat = await this.stat(path);
    if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))) throw Error("windows_file_type");
    return stat;
  }
  private async call(op: "inspect" | "mkdir" | "create" | "flush" | "publish", path: string, destination = "", check = (): void => {}): Promise<void> {
    this.path(path); if (destination) this.path(destination);
    if (hex(await sha256(utf8(this.helper.source))) !== this.helper.sha256) throw Error("windows_helper_integrity");
    // Windows component-store hard links are legitimate for this already
    // trusted OS executable. Private data files still require exactly one link.
    const executable = await this.stat(this.powershell.path);
    if (!executable?.isFile() || executable.isSymbolicLink() || executable.size > 32n * 1024n * 1024n) throw Error("trusted_powershell_required");
    const held = await this.fs.open(this.powershell.path, "r");
    try {
      const before = await held.stat({ bigint: true });
      if (!this.same(before, executable) || hex(await sha256(await bounded(held, Number(before.size)))) !== this.powershell.sha256 ||
          !this.same(await this.stat(this.powershell.path), before)) throw Error("trusted_powershell_required");
      const system = this.powershell.path.slice(0, -"\\WindowsPowerShell\\v1.0\\powershell.exe".length);
      const request = JSON.stringify({ v: 1, op, path, destination });
      await new Promise<void>((resolve, reject) => {
        // No PATH, preload, profile, CWD or arbitrary command selection.
        const child = this.spawn.spawn(this.powershell.path,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", this.command],
          { shell: false, windowsHide: true, cwd: system, env: {
            SystemRoot: system.slice(0, -"\\System32".length),
            PSModulePath: `${system}\\WindowsPowerShell\\v1.0\\Modules`,
          }, stdio: ["pipe", "pipe", "pipe"] });
        let output = "", diagnostics = "", size = 0, refused = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const fail = (reason: string) => { refused ||= reason; child.kill(); };
        const timer = setTimeout(() => fail("deadline"), op === "publish" ? 120000 : 15000);
        const cancellation = setInterval(() => { try { check(); } catch { fail("cancelled"); } }, 100);
        child.stdin.on("error", () => fail("stdin"));
        child.stdout.on("data", data => {
          if ((size += data.length) > 256) { fail("output_budget"); return; }
          try { output += decoder.decode(data, { stream: true }); } catch { fail("output_encoding"); }
        });
        child.stderr.on("data", data => {
          if ((size += data.length) > 256) { fail("output_budget"); return; }
          try { diagnostics += new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { fail("output_encoding"); }
        });
        child.on("error", () => { clearTimeout(timer); clearInterval(cancellation); reject(Error("windows_files_refused")); });
        child.on("close", code => {
          clearTimeout(timer);
          clearInterval(cancellation);
          try { output += decoder.decode(); } catch { refused ||= "output_encoding"; }
          if (refused || code !== 0 || diagnostics || output.replace(/\r?\n$/, "") !== '{"v":1,"ok":true}') {
            let detail = refused ? `:${refused}` : "";
            try {
              const value = JSON.parse(diagnostics) as { v: number; ok: boolean; reason: string; exception: string; line: number };
              if (value.v === 1 && value.ok === false && /^[a-z_]{1,48}$/.test(value.reason) &&
                  /^[A-Za-z]{1,64}$/.test(value.exception) && Number.isInteger(value.line) && value.line > 0 && value.line < 10000)
                detail = `:${value.reason}:${value.exception}:${value.line}`;
            } catch { /* Unrecognized output never reaches diagnostics. */ }
            reject(Error(`windows_files_refused${detail}`));
          } else resolve();
        });
        child.stdin.end(request);
      });
      if (!this.same(await this.stat(this.powershell.path), executable)) throw Error("trusted_powershell_changed");
    } finally { await held.close(); }
  }
  async inspect(path: string): Promise<void> {
    const before = await this.custody(path); await this.call("inspect", path);
    if (!this.same(await this.stat(path), before)) throw Error("windows_identity_changed");
  }
  async mkdir(path: string): Promise<void> {
    this.path(path); if (await this.stat(path)) throw Error("destination_exists");
    await this.call("mkdir", path); await this.custody(path);
  }
  async create(path: string): Promise<void> {
    this.path(path); if (await this.stat(path)) throw Error("destination_exists");
    await this.call("create", path); await this.custody(path);
  }
  async flush(path: string): Promise<void> {
    const before = await this.custody(path);
    if (!before.isFile()) throw Error("windows_file_required");
    await this.call("flush", path);
    if (!this.same(await this.stat(path), before)) throw Error("windows_identity_changed");
  }
  /** Caller must bind stage identity and target in its durable operation record.
   * This primitive neither invents a recovery journal nor declares completion.
   */
  async publish(stage: string, destination: string, check = (): void => {}): Promise<void> {
    this.path(stage); this.path(destination);
    if (stage.slice(0, stage.lastIndexOf("\\")) !== destination.slice(0, destination.lastIndexOf("\\"))) throw Error("same_parent_required");
    const before = await this.custody(stage);
    if (await this.stat(destination)) throw Error("destination_exists");
    let count = 0;
    const visit = async (path: string): Promise<void> => {
      check();
      if (++count > 100000) throw Error("windows_tree_budget");
      const entry = await this.custody(path);
      if (entry.isDirectory()) {
        for await (const item of await this.fs.opendir(path)) await visit(`${path}\\${item.name}`);
      }
      if (!this.same(await this.stat(path), entry)) throw Error("windows_identity_changed");
    };
    await visit(stage);
    if (!this.same(await this.stat(stage), before)) throw Error("windows_identity_changed");
    await this.call("publish", stage, destination, check);
    if (await this.stat(stage) || !this.same(await this.custody(destination), before)) throw Error("windows_publication_readback");
  }
}
