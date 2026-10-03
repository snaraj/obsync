#!/usr/bin/env node
// Native SDK/ABI and ACL refusal checks, on synthetic owned directories only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, open, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { machine, release, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { MacosAcl, macosAclReason } = require("../../plugin/build/macosAcl.js");
const helper = require("../../plugin/build/macosHelperData.js");
const platform = { os: process.platform, arch: process.arch, machine: machine(), release: release() };
let stage = "platform", root;
const cases = [];
const env = { LC_ALL: "C" };
function acl(path, ...args) {
  const result = spawnSync("/bin/chmod", [...args, path], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0);
}
function probe(fd, stat, request = `OBSYNC_ACL_V1 ${stat.dev} ${stat.ino}\n`) {
  const source = `const ARM64=${process.arch === "arm64" ? "true" : "false"};\n${helper.source}`;
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", source], {
    env, cwd: "/", input: request, encoding: "utf8", timeout: 5000, maxBuffer: 512,
    stdio: ["pipe", "pipe", "pipe", fd ?? "ignore"],
  });
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
async function main() {
  assert.equal(platform.os, "darwin");
  assert.ok(["arm64", "x64"].includes(platform.arch));
  assert.equal(platform.machine, platform.arch === "arm64" ? "arm64" : "x86_64");
  assert.equal(process.argv.length, 3); assert.equal(platform.arch, process.argv[2]);
  assert.equal(createHash("sha256").update(helper.source).digest("hex"), helper.sha256);
  root = await mkdtemp(join(tmpdir(), "obsync-acl-native-"));
  const directory = join(root, "directory"), child = join(directory, "inherited");
  let handle, created = false, inherited = false;
  try {
    await mkdir(directory, { mode: 0o700 }); created = true;
    const reader = new MacosAcl();
    stage = "absent"; acl(directory, "-N");
    await writeFile(join(directory, "sentinel.md"), "Synthetic ACL sentinel.\n", { mode: 0o600 });
    const stat = () => lstat(directory, { bigint: true });
    await reader.inspect(directory, await stat()); cases.push(stage);
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = await handle.stat({ bigint: true });
    stage = "descriptor-identity";
    assert.deepEqual(probe(handle.fd, identity, `OBSYNC_ACL_V1 ${identity.dev} ${identity.ino + 1n}\n`),
      { v: 1, ok: false, reason: "identity", errno: null }); cases.push(stage);
    stage = "descriptor-required";
    const missing = probe(undefined, identity);
    assert.equal(missing.ok, false); cases.push(stage);
    stage = "request-bound";
    assert.deepEqual(probe(handle.fd, identity, "x".repeat(80)), { v: 1, ok: false, reason: "request", errno: null }); cases.push(stage);
    stage = "deny-only"; acl(directory, "+a#", "0", "everyone deny delete");
    await reader.inspect(directory, await stat());
    assert.deepEqual(probe(handle.fd, identity), { v: 1, ok: true, kind: "deny_only", entries: 1, errno: null }); cases.push(stage);
    stage = "complete-count-128";
    for (let i = 1; i < 128; i++) acl(directory, "+a#", String(i), "everyone deny delete");
    await reader.inspect(directory, await stat());
    assert.deepEqual(probe(handle.fd, identity), { v: 1, ok: true, kind: "deny_only", entries: 128, errno: null }); cases.push(stage);
    stage = "final-grant"; acl(directory, "=a#", "127", "everyone allow read");
    await assert.rejects(reader.inspect(directory, await stat()), { message: "macos_acl_ace_grants_or_unknown" }); cases.push(stage);
    stage = "metadata-denied"; acl(directory, "-N"); acl(directory, "+a#", "0", "everyone deny readsecurity");
    assert.deepEqual(probe(handle.fd, identity), { v: 1, ok: false, reason: "security", errno: null }); cases.push(stage);
    stage = "inherited-deny"; acl(directory, "-N"); acl(directory, "+a#", "0", "everyone deny delete,file_inherit,directory_inherit");
    await mkdir(child, { mode: 0o700 }); inherited = true;
    await reader.inspect(child, await lstat(child, { bigint: true })); cases.push(stage);
    stage = "unchanged-sentinel";
    assert.equal(await readFile(join(directory, "sentinel.md"), "utf8"), "Synthetic ACL sentinel.\n"); cases.push(stage);
  } finally {
    await handle?.close();
    if (created) acl(directory, "-N");
    if (inherited) acl(child, "-N");
    await rm(root, { recursive: true }); root = undefined;
  }
  console.log(JSON.stringify({ result: "PASS", platform, helper_sha256: helper.sha256, cases, cleanup: "absent" }));
}
await main().catch(error => {
  // Neither native stderr nor assertion/path details enter the public log.
  console.error(JSON.stringify({ result: "FAIL", platform, stage, reason: macosAclReason(error), cleanup: root ? "unconfirmed" : "absent" }));
  process.exitCode = 1;
});
