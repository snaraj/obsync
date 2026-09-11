/**
 * v0.1 has no self-update, by decision (`docs/architecture.md` 6.3).
 *
 * The reviewer's mutant is a server that serves BOTH the code and the hash
 * that is supposed to check it: `bundle_sha256` here is the real SHA-256 of
 * the attacker's bundle, so a hash comparison would pass and the plugin would
 * install a `main.js` that runs with the vault key on the next reload. What
 * is asserted is that no such path exists any more: the fake adapter — the
 * only way this plugin can write into `.obsidian/plugins/` — records not one
 * write, the bundle endpoint is never called, and the user is told where the
 * trusted copy is instead.
 *
 * The plugin methods are the REAL ones, loaded from `build/main.js` inside
 * the sandbox where `obsidian` resolves to the stub that records notices.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fakeState, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");

const ATTACKER_BUNDLE = "module.exports = function () { /* not the plugin you installed */ };";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A server that serves a newer version, an attacker bundle, and its true hash. */
function hostileServer({ version = "9.9.9", fail = false } = {}) {
  const targets = [];
  const json = (status, value) => ({
    status,
    headers: {},
    text: JSON.stringify(value),
    arrayBuffer: new ArrayBuffer(0),
  });
  return {
    targets,
    request: async (request) => {
      const target = request.url.replace(/^https?:\/\/[^/]+/, "");
      targets.push(target);
      if (fail) throw new Error("connection reset by the edge");
      if (target === "/v1/plugin/manifest") {
        return json(200, {
          id: "obsync",
          version,
          minAppVersion: "1.7.0",
          bundle_sha256: sha256(ATTACKER_BUNDLE),
          styles_sha256: sha256(""),
        });
      }
      if (target === "/v1/plugin/bundle") {
        return { status: 200, headers: {}, text: ATTACKER_BUNDLE, arrayBuffer: new ArrayBuffer(0) };
      }
      if (target === "/v1/plugin/styles") {
        return { status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
      }
      return json(404, { error: "not_found" });
    },
  };
}

/** Every way this plugin could reach the plugin folder, recorded. */
function recordingAdapter() {
  const writes = [];
  return {
    writes,
    exists: async () => false,
    mkdir: async (path) => void writes.push(`mkdir ${path}`),
    write: async (path) => void writes.push(`write ${path}`),
    writeBinary: async (path) => void writes.push(`writeBinary ${path}`),
    remove: async (path) => void writes.push(`remove ${path}`),
  };
}

async function plugin(server, { version = "0.1.0" } = {}) {
  const box = sandbox();
  const ObsyncPlugin = box.require(join(box.home, "build", "main.js")).default;
  const obsidian = box.require("obsidian");
  obsidian.notices.length = 0;
  const { state } = await fakeState(false);
  const adapter = recordingAdapter();
  const logs = [];
  const instance = Object.create(ObsyncPlugin.prototype);
  instance.state = state;
  instance.transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => null,
    edgeHeaders: () => [],
    sleep: async () => undefined,
    maxAttempts: 2,
  });
  instance.manifest = { id: "obsync", version };
  instance.app = { vault: { adapter, configDir: ".obsidian" } };
  instance.updateAvailable = null;
  instance.log = (line) => logs.push(line);
  return { instance, adapter, logs, notices: obsidian.notices, ObsyncPlugin };
}

test("an attacker's manifest and bundle produce zero writes under .obsidian/plugins/", async () => {
  const server = hostileServer({ version: "9.9.9" });
  const { instance, adapter, logs, ObsyncPlugin } = await plugin(server);

  await instance.checkForUpdate();

  assert.deepEqual(adapter.writes, [], "the plugin folder was never touched");
  assert.deepEqual(server.targets, ["/v1/plugin/manifest"], "only the version was read");
  assert.equal(server.targets.includes("/v1/plugin/bundle"), false, "the code was never fetched");
  assert.equal(server.targets.includes("/v1/plugin/styles"), false);
  assert.equal(typeof ObsyncPlugin.prototype.installUpdate, "undefined", "there is no installer to call");
  assert.equal(typeof instance.transport.pluginBundle, "undefined", "and no client to fetch code with");
  assert.ok(logs.some((line) => line.includes("update decision=available server=9.9.9 local=0.1.0")));
});

test("the notice and the settings line direct updates to Obsidian's plugin manager", async () => {
  const server = hostileServer({ version: "9.9.9" });
  const { instance, notices } = await plugin(server);
  assert.equal(instance.updateLine(), null, "nothing is claimed before the server is asked");

  await instance.checkForUpdate();

  assert.equal(notices.length, 1);
  const notice = notices[0];
  assert.match(notice, /Server runs 9\.9\.9, you have 0\.1\.0/);
  assert.match(notice, /Settings → Community plugins → Check for updates, then update Obsync/);
  assert.doesNotMatch(notice, /\.zip|reinstall|releases\/tag|\/v1\/plugin\/bundle/);
  assert.equal(instance.updateAvailable, "9.9.9");
  assert.equal(instance.updateLine(), notice.replace(/^obsync: /, ""), "the settings tab says the same thing");
});

test("a server that is not newer says nothing at all", async () => {
  const server = hostileServer({ version: "0.1.0" });
  const { instance, notices, adapter } = await plugin(server);

  await instance.checkForUpdate();

  assert.deepEqual(notices, []);
  assert.deepEqual(adapter.writes, []);
  assert.equal(instance.updateAvailable, null);
  assert.equal(instance.updateLine(), null);
});

test("an unreachable or hostile server cannot break the check", async () => {
  const server = hostileServer({ fail: true });
  const { instance, notices, logs, adapter } = await plugin(server);

  await instance.checkForUpdate();

  assert.deepEqual(notices, [], "a failed check is not a user-facing alarm");
  assert.deepEqual(adapter.writes, []);
  assert.ok(logs.some((line) => line.startsWith("update decision=skipped reason=")), logs.join(" | "));
});

test("a device with no server configured never asks", async () => {
  const server = hostileServer();
  const { instance, notices } = await plugin(server);
  instance.state.data.serverUrl = "";

  await instance.checkForUpdate();

  assert.deepEqual(server.targets, []);
  assert.deepEqual(notices, []);
});
