/**
 * NO LOG LINE NAMES AN ABSOLUTE LOCAL PATH (issue #266).
 *
 * A filesystem error names the absolute path it failed on, in its `path` and
 * `dest` and in its message. A device paired later logged
 * `feed decision=retry reason=Path is a directory: rm returned EISDIR (is a
 * directory) <home>/<vault>/W201/Sub2`, naming the person's home and
 * vault folders in a log they may share. The errors here are Node's own, made
 * by the calls that fail that way.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYS, STEP_MS, pair, settled } from "./fake.mjs";
const { SCAN_MS } = createRequire(import.meta.url)("../build/sync/engine.js");

const require = createRequire(import.meta.url);
const { errorText } = require("../build/vaultPath.js");
const { Transport } = require("../build/transport.js");

/** A real directory, and the errors Node gives for it. */
async function failures(t) {
  const dir = mkdtempSync(join(tmpdir(), "obsync-error-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const eisdir = await rm(dir, { recursive: false }).then(() => assert.fail("rm removed a directory"), (error) => error);
  const enoent = await open(join(dir, "missing note.md")).then(() => assert.fail("opened"), (error) => error);
  const renamed = await rename(join(dir, "a.md"), join(dir, "b.md")).then(() => assert.fail("renamed"), (error) => error);
  return { dir, eisdir, enoent, renamed };
}

test("an error's words keep its code and call and lose every absolute path it names", async (t) => {
  const { dir, eisdir, enoent, renamed } = await failures(t);
  assert.equal(eisdir.code, "ERR_FS_EISDIR", "not the error the live run met");
  assert.equal(errorText(eisdir), "Path is a directory: rm returned EISDIR (is a directory) <path>");
  assert.equal(errorText(enoent), "ENOENT: no such file or directory, open '<path>'");
  assert.equal(errorText(renamed), "ENOENT: no such file or directory, rename '<path>' -> '<path>'");
  // The same words re-thrown without their properties, and a Windows path.
  assert.equal(errorText(new Error(enoent.message)), "ENOENT: no such file or directory, open '<path>'");
  assert.equal(
    errorText(new Error("EPERM: operation not permitted, unlink 'C:\\Users\\someone\\Vault\\Note.md'")),
    "EPERM: operation not permitted, unlink '<path>'",
  );
  for (const error of [eisdir, enoent, renamed]) assert.equal(errorText(error).includes(dir), false, errorText(error));
  // Nothing else is touched: a request path is no local path, and a non-Error says itself.
  assert.equal(errorText(new Error("GET /v1/files/ab12 status=404")), "GET /v1/files/ab12 status=404");
  assert.equal(errorText("plain words"), "plain words");
  assert.equal(errorText(undefined), "undefined");
});

test("whatever the vault's calls throw, no line names the absolute path", async (t) => {
  const { dir, enoent } = await failures(t);
  const { timers, a } = await pair(t, "immediate");
  a.host.write("Note.md", "NOTE SENTINEL\n", 1000);
  a.host.write("Gone.md", "GONE SENTINEL\n", 1000);
  // The start's heartbeat, too.
  const heartbeat = a.transport.heartbeat;
  a.transport.heartbeat = async () => { throw enoent; };
  await a.engine.start();
  await timers.run(STEP_MS, () => settled(a, "Note.md") && settled(a, "Gone.md"));
  a.transport.heartbeat = heartbeat;
  /** Each named host call throws Node's own ENOENT while `act` runs. */
  const poison = async (names, act) => {
    const saved = Object.fromEntries(names.map((name) => [name, a.host[name]]));
    for (const name of names) a.host[name] = async () => { throw enoent; };
    try { await act(); } finally { Object.assign(a.host, saved); }
  };
  // The watcher's settle, and the periodic scan.
  await poison(["stat", "list", "inventory"], async () => {
    a.host.write("Note.md", "NOTE SENTINEL\nedited\n", 2000);
    await timers.run(SCAN_MS);
  });
  // A push, which reads the bytes.
  await poison(["read"], async () => {
    a.host.write("Note.md", "NOTE SENTINEL\nedited again\n", 3000);
    await timers.run(STEP_MS, () => a.host.logs.some((line) => line.startsWith("push path_class=file decision=failed")));
  });
  // A deletion's settle, which asks the vault where the bytes went.
  await poison(["inventory"], async () => {
    a.host.remove("Gone.md");
    await timers.run(STEP_MS, () => a.host.logs.some((line) => line.includes("reason=vanished_unsettled")));
  });
  const kinds = [...new Set(a.host.logs.filter((line) => line.includes("<path>")).map((line) => line.split(" reason=")[0]))];
  assert.deepEqual(
    kinds.sort(),
    ["heartbeat decision=failed", "push path_class=file decision=failed", "scan decision=failed", "watch decision=failed",
      "watch path_class=file decision=failed"],
    a.host.logs.filter((line) => /failed/.test(line)).join(" | "),
  );
  assert.deepEqual(a.host.logs.filter((line) => line.includes(dir)), [], "a log line named the absolute path");
});

test("a request that fails with a local error logs it without the absolute path", async (t) => {
  const { dir, enoent } = await failures(t);
  const logs = [];
  const transport = new Transport({
    request: async () => { throw enoent; },
    serverUrl: () => "http://127.0.0.1:9",
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => 1757200000000,
    sleep: async () => undefined,
    maxAttempts: 1,
    log: (line) => logs.push(line),
  });
  await assert.rejects(transport.getFile("ab".repeat(16)));
  assert.ok(logs.some((line) => line.includes("network=ENOENT: no such file or directory, open '<path>'")), logs.join(" | "));
  assert.deepEqual(logs.filter((line) => line.includes(dir)), [], "a log line named the absolute path");
});

test("a feed page that fails on a folder removal logs its retry without the absolute path", async (t) => {
  const { dir, eisdir } = await failures(t);
  const { timers, a, b } = await pair(t, "immediate");
  a.host.makeFolder("Gone");
  a.host.write("Kept.md", "KEPT SENTINEL\n", 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.hasFolder("Gone") && settled(b, "Kept.md") && b.state.folderByPath("Gone") !== undefined);
  // The receiver's folder removal throws Node's own EISDIR once, as the
  // adapter's did live, and works after that.
  const trashFolder = b.host.trashFolder.bind(b.host);
  let thrown = 0;
  b.host.trashFolder = async (path) => {
    if (path === "Gone" && thrown++ === 0) throw eisdir;
    return trashFolder(path);
  };

  a.host.removeFolder("Gone");
  await timers.run(STEP_MS, () => thrown > 0 && !b.host.hasFolder("Gone"));

  const retries = b.host.logs.filter((line) => line.startsWith("feed decision=retry"));
  assert.equal(retries.length, 1, b.host.logs.filter((line) => line.startsWith("feed")).join(" | "));
  assert.ok(retries[0].includes("reason=Path is a directory: rm returned EISDIR (is a directory) <path> "), retries[0]);
  assert.deepEqual(b.host.logs.filter((line) => line.includes(dir)), [], "a log line named the absolute path");
  assert.equal(b.state.folderByPath("Gone"), undefined, "the removal never completed");
});
