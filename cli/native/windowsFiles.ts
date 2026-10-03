/** Windows custody and durable publication through the approved fixed helper.
 * Explicit trusted OS setup binds PowerShell; no ambient executable discovery.
 */
const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

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
  stdin: { write(value: string): void; end(value?: string): void; on(event: "error", listener: () => void): void };
  stdout: { on(event: "data", listener: (data: Uint8Array) => void): void };
  stderr: { on(event: "data", listener: (data: Uint8Array) => void): void };
  on(event: "error", listener: () => void): void;
  on(event: "close", listener: (code: number | null) => void): void; kill(): void;
}
interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}
const controls = (value: string): boolean => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
interface Spawn {
  spawn(file: string, args: string[], options: {
    shell: false; windowsHide: true; cwd: string; env: Record<string, string>;
    stdio: ["pipe", "pipe", "pipe"];
  }): Child;
}
/** Supplied only by explicit trusted OS setup, never a CLI/request option. */
export interface WindowsPowerShell { path: string; sha256: string }

function helperCommand(source: string): string {
  const buffer = require("node:buffer") as { Buffer: { from(value: string, encoding: string): { toString(encoding: string): string } } };
  const gzip = require("node:zlib") as { gzipSync(bytes: Uint8Array): { toString(encoding: string): string } };
  const packed = gzip.gzipSync(utf8(source)).toString("base64");
  const script = `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${packed}'));` +
    `$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);` +
    `$r=[IO.StreamReader]::new($g,[Text.Encoding]::ASCII);` +
    `try{$s=$r.ReadToEnd()}finally{$r.Dispose();$m.Dispose()}; & ([ScriptBlock]::Create($s))`;
  const command = buffer.Buffer.from(script, "utf16le").toString("base64");
  if (command.length > 30000) throw Error("windows_helper_budget");
  return command;
}

export class WindowsFiles {
  private readonly fs: Fs;
  private readonly spawn: Spawn;
  private readonly timers: Timers;
  private readonly command: string;
  private readonly helper: { source: string; sha256: string };
  constructor(private readonly powershell: WindowsPowerShell) {
    if ((require("node:process") as { platform: string }).platform !== "win32") throw Error("windows_platform_required");
    if (controls(powershell.path) || !/^[A-Z]:\\[^<>:"/|?*]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(powershell.path) ||
        !/^[a-f0-9]{64}$/.test(powershell.sha256)) throw Error("trusted_powershell_required");
    this.fs = (require("node:fs") as { promises: Fs }).promises;
    this.spawn = require("node:child_process") as Spawn;
    // Shared with the CLI; these process-deadline handles never enter a UI API.
    this.timers = require("node:timers") as Timers;
    this.helper = require("./windowsHelperData") as typeof this.helper;
    if (typeof this.helper.source !== "string" || this.helper.source.length > 16384 || [...this.helper.source].some(char => char.charCodeAt(0) > 127) ||
        !/^[a-f0-9]{64}$/.test(this.helper.sha256)) throw Error("windows_helper_integrity");
    // Only our fixed, hash-checked source is code. Compression keeps the sole
    // helper inside Windows' command-line limit without a mutable script file.
    this.command = helperCommand(this.helper.source);
  }
  /** Executed only by the person in an independently opened OS PowerShell.
   * No executable is selected or run by the app before importing its receipt.
   */
  static async setupCommand(nonce: string): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(nonce)) throw Error("windows_setup_nonce");
    const helper = require("./windowsHelperData") as { source: string; sha256: string };
    if (hex(await sha256(utf8(helper.source))) !== helper.sha256) throw Error("windows_helper_integrity");
    return `$ErrorActionPreference='Stop'; ` +
      `$e=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\\v1.0\\powershell.exe'); ` +
      `$d=[IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'obsync-cli-${nonce}'); ` +
      `$p=[Diagnostics.ProcessStartInfo]::new($e); $p.Arguments='-NoLogo -NoProfile -NonInteractive -EncodedCommand ${helperCommand(helper.source)}'; ` +
      `$p.UseShellExecute=$false; $p.RedirectStandardInput=$true; $p.RedirectStandardOutput=$true; $p.RedirectStandardError=$true; ` +
      `$p.EnvironmentVariables.Clear(); $p.EnvironmentVariables['SystemRoot']=[IO.Directory]::GetParent([Environment]::SystemDirectory).FullName; ` +
      `$p.EnvironmentVariables['PSModulePath']=[IO.Path]::Combine([Environment]::SystemDirectory,'WindowsPowerShell\\v1.0\\Modules'); ` +
      `$old=[Console]::InputEncoding; try{[Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true); $c=[Diagnostics.Process]::Start($p)}finally{[Console]::InputEncoding=$old}; ` +
      `try{$o=$c.StandardOutput.ReadToEndAsync(); $x=$c.StandardError.ReadToEndAsync(); ` +
      String.raw`$c.StandardInput.Write('{"v":1,"op":"setup","path":"'+$d.Replace('\','\\')+'","destination":""}'); ` +
      `$c.StandardInput.Close(); if(!$c.WaitForExit(15000)){$c.Kill();$c.WaitForExit();throw 'Setup deadline'}; ` +
      `if($c.ExitCode -ne 0 -or $x.Result -or $o.Result.Trim() -cne '{"v":1,"ok":true}'){throw 'Setup refused'} ` +
      `}finally{$c.Dispose()}; $f=[IO.Path]::Combine($d,'powershell.json'); $h=[Security.Cryptography.SHA256]::Create(); ` +
      `try{$s=[BitConverter]::ToString($h.ComputeHash([IO.File]::ReadAllBytes($f))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}; ` +
      String.raw`'{"v":1,"path":"'+$f.Replace('\','\\')+'","digest":"'+$s+'"}'`;
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
    if (typeof path !== "string" || path.length > 240 || !/^[A-Z]:\\/.test(path) || (controls(path) || /[/<>"|?*]/.test(path)) ||
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
  private async call(op: "inspect" | "mkdir" | "create" | "flush" | "publish" | "lock", path: string, destination = "", check = (): void => {},
    locked?: (alive: () => void) => Promise<void>): Promise<void> {
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
        let output = "", diagnostics = "", size = 0, refused = "", live = true, acquired = false;
        let working: Promise<void> = Promise.resolve(), workError: unknown;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const fail = (reason: string) => { refused ||= reason; child.kill(); };
        let timer = this.timers.setTimeout(() => fail("deadline"), op === "publish" ? 120000 : 15000);
        const cancellation = this.timers.setInterval(() => { try { check(); } catch { fail("cancelled"); } }, 100);
        child.stdin.on("error", () => fail("stdin"));
        child.stdout.on("data", data => {
          if ((size += data.length) > 256) { fail("output_budget"); return; }
          try { output += decoder.decode(data, { stream: true }); } catch { fail("output_encoding"); }
          if (op === "lock" && !acquired && output.replace(/\r?\n$/, "") === '{"v":1,"held":true}') {
            acquired = true; output = ""; this.timers.clearTimeout(timer);
            timer = this.timers.setTimeout(() => fail("deadline"), 1800000);
            working = Promise.resolve().then(async () => {
              if (!locked) throw Error("windows_lock_callback");
              await locked(() => { check(); if (!live || refused) throw Error("windows_lock_lost"); });
              child.stdin.end();
            }).catch(error => { workError = error; fail("operation"); });
          }
        });
        child.stderr.on("data", data => {
          if ((size += data.length) > 256) { fail("output_budget"); return; }
          try { diagnostics += new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { fail("output_encoding"); }
        });
        child.on("error", () => { this.timers.clearTimeout(timer); this.timers.clearInterval(cancellation); reject(Error("windows_files_refused")); });
        child.on("close", async code => {
          live = false;
          this.timers.clearTimeout(timer);
          this.timers.clearInterval(cancellation);
          await working;
          if (workError) { reject(workError); return; }
          try { output += decoder.decode(); } catch { refused ||= "output_encoding"; }
          if (refused || code !== 0 || diagnostics || (op === "lock" && !acquired) || output.replace(/\r?\n$/, "") !== '{"v":1,"ok":true}') {
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
        if (op === "lock") child.stdin.write(request + "\n"); else child.stdin.end(request);
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
  /** Kernel-held exclusivity, released by normal close or parent pipe death. */
  async locked<T>(path: string, check: () => void, work: (alive: () => void) => Promise<T>): Promise<T> {
    await this.inspect(path);
    let result!: T;
    await this.call("lock", path, "", check, async alive => { result = await work(alive); });
    return result;
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
