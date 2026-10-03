/** Fixed Apple-signed interpreter, read-only inherited directory descriptor. */
import { hex, sha256, utf8 } from "./crypto";
declare const require: (id: string) => unknown;
const readerReasons = ["bridge", "request", "allocation", "descriptor", "identity", "directory", "filesystem", "security",
  "security_identity", "attributes", "attribute_shape", "absence_unproven", "acl_shape", "acl_count", "ace_grants_or_unknown", "recheck", "changed"];
const adapterReasons = ["platform", "integrity", "interpreter", "protocol", "identity", "changed",
  "launch_error", "launch_timeout", "launch_stdin", "launch_stderr", "launch_exit", "launch_output_budget", "launch_output_encoding"];
/** Only fixed categories reach UI/logs; OS messages can contain private paths. */
export function macosAclReason(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && [...readerReasons, ...adapterReasons].some(reason => message === `macos_acl_${reason}`)
    ? message : "destination_acl_unproven";
}
export interface AclStat {
  dev: bigint; ino: bigint; uid: bigint; mode: bigint; ctimeNs: bigint;
  isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean;
}
interface Handle { fd: number; stat(options: { bigint: true }): Promise<AclStat>; close(): Promise<void> }
interface Fs {
  lstat(path: string, options: { bigint: true }): Promise<AclStat>;
  open(path: string, flags: number): Promise<Handle>;
}
interface Child {
  stdin: { end(input: string): void; on(event: "error", fn: () => void): void };
  stdout: { on(event: "data", fn: (bytes: Uint8Array) => void): void };
  stderr: { on(event: "data", fn: (bytes: Uint8Array) => void): void };
  on(event: "error", fn: () => void): void;
  on(event: "close", fn: (code: number | null) => void): void;
  kill(signal: "SIGKILL"): void;
}
interface Spawn {
  spawn(file: string, args: string[], options: {
    shell: false; cwd: "/"; env: { LC_ALL: "C" };
    stdio: ["pipe", "pipe", "pipe"] | ["pipe", "pipe", "pipe", number];
  }): Child;
}
interface Timers { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }
export class MacosAcl {
  private readonly fs: Fs;
  private readonly flags: number;
  private readonly spawn: Spawn;
  private readonly timers: Timers;
  private readonly source: string;
  private readonly digest: string;
  private verified: Promise<AclStat> | null = null;
  constructor() {
    const process = require("node:process") as { platform: string; arch: string };
    if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw Error("macos_acl_platform");
    const fs = require("node:fs") as { promises: Fs; constants: { O_RDONLY: number; O_DIRECTORY: number; O_NOFOLLOW: number } };
    this.fs = fs.promises;
    this.flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    this.spawn = require("node:child_process") as Spawn;
    this.timers = (typeof window === "undefined" ? require("node:timers") : window) as Timers;
    const helper = require("./macosHelperData") as { source: string; sha256: string };
    if (typeof helper.source !== "string" || helper.source.length > 8192 ||
        !/^[a-f0-9]{64}$/.test(helper.sha256)) throw Error("macos_acl_integrity");
    for (let at = 0; at < helper.source.length; at++) if (helper.source.charCodeAt(at) > 127) throw Error("macos_acl_integrity");
    this.source = `const ARM64=${process.arch === "arm64" ? "true" : "false"};\n${helper.source}`;
    this.digest = helper.sha256;
  }
  private same(a: AclStat, b: AclStat): boolean {
    return this.custody(a, b) && a.ctimeNs === b.ctimeNs;
  }
  private custody(a: AclStat, b: AclStat): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode; }
  private async system(): Promise<AclStat> {
    for (const path of ["/", "/usr", "/usr/bin", "/usr/bin/codesign", "/usr/bin/osascript"]) {
      const stat = await this.fs.lstat(path, { bigint: true });
      if (stat.isSymbolicLink() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n ||
          (path.endsWith("/codesign") || path.endsWith("/osascript") ? !stat.isFile() : !stat.isDirectory())) throw Error("macos_acl_interpreter");
    }
    const before = await this.fs.lstat("/usr/bin/osascript", { bigint: true });
    await this.call("/usr/bin/codesign", ["--verify", "--strict", "-R", "=anchor apple", "/usr/bin/osascript"], "");
    if (!this.same(before, await this.fs.lstat("/usr/bin/osascript", { bigint: true }))) throw Error("macos_acl_interpreter");
    return before;
  }
  private async call(file: string, args: string[], input: string, fd?: number, budget = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: Child;
      try { child = this.spawn.spawn(file, args, { shell: false, cwd: "/", env: { LC_ALL: "C" },
        stdio: fd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", fd] }); }
      catch { reject(Error("macos_acl_launch_error")); return; }
      let output = "", size = 0, refused = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const fail = (reason: string) => { refused ||= reason; child.kill("SIGKILL"); };
      const timer = this.timers.setTimeout(() => fail("launch_timeout"), budget);
      child.stdin.on("error", () => fail("launch_stdin"));
      child.stdout.on("data", bytes => {
        if ((size += bytes.length) > 512) { fail("launch_output_budget"); return; }
        try { output += decoder.decode(bytes, { stream: true }); } catch { fail("launch_output_encoding"); }
      });
      child.stderr.on("data", () => fail("launch_stderr"));
      child.on("error", () => { this.timers.clearTimeout(timer); reject(Error(`macos_acl_${refused || "launch_error"}`)); });
      child.on("close", code => {
        this.timers.clearTimeout(timer);
        try { output += decoder.decode(); } catch { refused ||= "launch_output_encoding"; }
        if (refused || code !== 0) reject(Error(`macos_acl_${refused || "launch_exit"}`)); else resolve(output);
      });
      child.stdin.end(input);
    });
  }
  async inspect(path: string, expected: AclStat): Promise<AclStat> {
    const body = this.source.slice(this.source.indexOf("\n") + 1);
    if (hex(await sha256(utf8(body))) !== this.digest) throw Error("macos_acl_integrity");
    const interpreter = await (this.verified ??= this.system());
    if (!this.same(interpreter, await this.fs.lstat("/usr/bin/osascript", { bigint: true }))) throw Error("macos_acl_interpreter");
    const handle = await this.fs.open(path, this.flags);
    try {
      let before = await handle.stat({ bigint: true });
      if (!before.isDirectory() || typeof expected.ctimeNs !== "bigint" || before.dev < 0n || before.dev > 4294967295n ||
          before.ino < 0n || before.ino > 18446744073709551615n) throw Error("macos_acl_identity");
      // A caller's earlier ctime may be stale after unrelated child activity.
      // Accept only that drift, then fully verify the current held snapshot.
      if (!this.same(before, expected) && (before.ctimeNs === expected.ctimeNs || !this.custody(before, expected)))
        throw Error("macos_acl_identity");
      // Re-read the full ACL once if unrelated child activity changed only
      // ctime. Both attempts share the original five-second reader budget.
      const deadline = performance.now() + 5000;
      for (let attempt = 0; ; attempt++) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw Error("macos_acl_launch_timeout");
        try {
          const output = await this.call("/usr/bin/osascript", ["-l", "JavaScript", "-e", this.source],
            `OBSYNC_ACL_V1 ${before.dev} ${before.ino}\n`, handle.fd, remaining);
          let result: { v: number; ok: boolean; kind: string; entries: number; errno: null; reason?: string };
          try { result = JSON.parse(output) as typeof result; } catch { throw Error("macos_acl_protocol"); }
          if (result && Object.keys(result).sort().join() === "errno,ok,reason,v" && result.v === 1 && result.ok === false &&
              result.errno === null && typeof result.reason === "string" && readerReasons.includes(result.reason))
            throw Error(`macos_acl_${result.reason}`);
          if (!result || Object.keys(result).sort().join() !== "entries,errno,kind,ok,v" || result.v !== 1 || result.ok !== true ||
              result.errno !== null || !Number.isInteger(result.entries) || result.entries < 0 || result.entries > 128 ||
              (result.kind === "deny_only" ? result.entries === 0 : !["absent", "empty"].includes(result.kind) || result.entries !== 0))
            throw Error("macos_acl_protocol");
          if (!this.same(before, await handle.stat({ bigint: true })) || !this.same(before, await this.fs.lstat(path, { bigint: true })))
            throw Error("macos_acl_changed");
          return before;
        } catch (error) {
          if (attempt !== 0 || macosAclReason(error) !== "macos_acl_changed") throw error;
          const now = await handle.stat({ bigint: true }), named = await this.fs.lstat(path, { bigint: true });
          if (![now, named].every(stat => this.custody(stat, before)) ||
              (now.ctimeNs === before.ctimeNs && named.ctimeNs === before.ctimeNs)) throw error;
          before = now;
        }
      }
    } finally { await handle.close(); }
  }
}
