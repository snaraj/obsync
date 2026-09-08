/**
 * The vault-path rule and the desktop vault-root proof, the two layers that
 * confine every path this plugin touches.
 *
 * The first layer is a pure string rule, tested here shape by shape. The
 * second is `vaultTarget`, which resolves an absolute target and proves it is
 * strictly below the vault root; it is tested on its own, with Node's real
 * `path`, because inside the host the two layers are deliberately redundant
 * and a mutant of one would otherwise be hidden by the other.
 *
 * The last block runs the REAL `ObsidianHost` against a real temporary vault
 * on disk — the desktop path, with Node's filesystem — so what is asserted is
 * what would land in a user's vault, not what a fake agreed to.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath, { join, resolve } from "node:path";
import { sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { assertVaultPath, isVaultPath, vaultPathRefusal, vaultTarget } = require("../build/vaultPath.js");

const enc = (text) => new TextEncoder().encode(text);

test("a canonical relative vault path is what is accepted", () => {
  for (const path of [
    "a.md",
    "Notes/Ideas.md",
    "Notes/2026/09/07 daily.md",
    "Attachments/photo.v2.final.png",
    "folder.with.dots/file",
    "a/b/c/d/e/f.md",
  ]) {
    assert.equal(vaultPathRefusal(path), null, path);
    assert.equal(isVaultPath(path), true, path);
    assert.equal(assertVaultPath(path), path);
  }
});

test("every escaping, hidden or malformed path is refused, with its reason", () => {
  const cases = [
    [undefined, "not_a_string"],
    [null, "not_a_string"],
    [42, "not_a_string"],
    [["a.md"], "not_a_string"],
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["/", "absolute"],
    ["C:/Windows/System32/evil.md", "drive_letter"],
    ["c:evil.md", "drive_letter"],
    ["..\\..\\evil.md", "backslash"],
    ["Notes\\Ideas.md", "backslash"],
    ["Notes/pass\u0000wd.md", "control_character"],
    ["Notes/be\u001bll.md", "control_character"],
    ["Notes//Ideas.md", "empty_segment"],
    ["Notes/", "empty_segment"],
    ["..", "dot_segment"],
    ["../../outside-the-vault.md", "dot_segment"],
    ["a/../../b", "dot_segment"],
    ["Notes/./Ideas.md", "dot_segment"],
    ["Notes/ /Ideas.md", "blank_segment"],
    ["Notes/\u00a0/Ideas.md", "blank_segment"],
    ["Notes/\t/Ideas.md", "control_character"],
    [".obsidian/plugins/obsync/main.js", "hidden_segment"],
    [".obsidian/plugins/obsync/data.json", "hidden_segment"],
    [".git/config", "hidden_segment"],
    ["Notes/.secret.md", "hidden_segment"],
  ];
  for (const [value, refusal] of cases) {
    assert.equal(vaultPathRefusal(value), refusal, String(value));
    assert.equal(isVaultPath(value), false, String(value));
    assert.throws(() => assertVaultPath(value), (error) => {
      assert.equal(error.name, "VaultPathError");
      assert.equal(error.refusal, refusal);
      return true;
    });
  }
});

test("the root proof confines an absolute target on its own", () => {
  const root = resolve("/tmp/obsync-vault");
  assert.equal(vaultTarget(root, "Notes/a.md", nodePath), join(root, "Notes", "a.md"));
  assert.equal(vaultTarget(`${root}${nodePath.sep}`, "a.md", nodePath), join(root, "a.md"));

  // Each of these passes `path.resolve` and lands outside the vault, which is
  // exactly what this layer exists to stop. It does not repeat the string
  // rule, so removing the prefix check turns these green-to-red.
  for (const escape of [
    "../escape.md",
    "../../escape.md",
    "..",
    ".",
    "a/../..",
    "/etc/passwd",
    "../obsync-vault-evil/a.md",
  ]) {
    assert.throws(
      () => vaultTarget(root, escape, nodePath),
      (error) => {
        assert.equal(error.refusal, "outside_root");
        return true;
      },
      escape,
    );
  }
});

/** The real desktop host over a real, empty vault directory. */
function desktopHost({ files = [] } = {}) {
  const box = sandbox();
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const root = mkdtempSync(join(tmpdir(), "obsync-vault-"));
  const logs = [];
  const removed = [];
  const adapter = {
    getBasePath: () => root,
    stat: async () => null,
    readBinary: async () => new ArrayBuffer(0),
    remove: async (path) => removed.push(path),
  };
  const plugin = {
    app: {
      vault: {
        adapter,
        getFiles: () => files,
        getAbstractFileByPath: () => null,
      },
    },
    log: (line) => logs.push(line),
  };
  return { host: new ObsidianHost(plugin), root, logs, removed };
}

test("the desktop writer lands a file inside the vault, atomically", async () => {
  const { host, root } = desktopHost();
  const writer = await host.writer("Notes/Ideas.md");
  await writer.write(enc("# Ideas\n"));
  const stat = await writer.commit(1757200001000);

  assert.equal(stat.path, "Notes/Ideas.md");
  assert.equal(stat.size, 8);
  assert.equal(readFileSync(join(root, "Notes", "Ideas.md"), "utf8"), "# Ideas\n");
  assert.equal(stat.mtime, 1757200001000, "the manifest's mtime is what the file carries");
  assert.deepEqual(readdirSync(join(root, "Notes")), ["Ideas.md"], "no temp file survived the commit");
});

test("the desktop host refuses every path that would leave the vault root", async () => {
  const { host, root } = desktopHost();
  const outside = resolve(root, "..", "obsync-escaped.md");

  for (const path of [
    "../obsync-escaped.md",
    "../../obsync-escaped.md",
    "/tmp/obsync-escaped.md",
    ".obsidian/plugins/obsync/main.js",
  ]) {
    await assert.rejects(() => host.writer(path), (error) => {
      assert.equal(error.name, "VaultPathError");
      return true;
    }, path);
    await assert.rejects(() => host.read(path), /not a vault path/, path);
    await assert.rejects(() => host.stat(path), /not a vault path/, path);
    await assert.rejects(() => host.trash(path), /not a vault path/, path);
    assert.throws(() => host.source(path, 1), /not a vault path/, path);
  }
  assert.equal(existsSync(outside), false, "nothing was written beside the vault");
  assert.equal(existsSync(join(root, ".obsidian")), false, "the plugin's own folder was not touched");
});

test("the desktop host reads only from inside the vault", async () => {
  const { host, root } = desktopHost();
  mkdirSync(join(root, "Notes"));
  writeFileSync(join(root, "Notes", "Ideas.md"), "inside\n");
  writeFileSync(resolve(root, "..", "obsync-outside.md"), "outside\n");

  const source = host.source("Notes/Ideas.md", 7);
  assert.equal(new TextDecoder().decode(await source.read(0, 7)), "inside\n");
  assert.throws(() => host.source("../obsync-outside.md", 8), /not a vault path/);
});

test("the vault listing drops what this device may not sync", async () => {
  const stat = { mtime: 1000, size: 1 };
  const { host, logs } = desktopHost({
    files: [
      { path: "Notes/Ideas.md", stat },
      { path: ".obsidian/plugins/obsync/data.json", stat },
      { path: ".git/config", stat },
    ],
  });
  const listed = await host.list();
  assert.deepEqual(
    listed.map((file) => file.path),
    ["Notes/Ideas.md"],
  );
  assert.ok(logs.some((line) => line.includes("decision=skipped_unsyncable files=2")), logs.join(" "));
});
