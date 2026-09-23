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

/** Obsidian's settings window, recording what it was asked to open. */
function recordingSettings() {
  const opened = [];
  return { opened, open: () => void opened.push("open"), openTabById: (id) => void opened.push(`tab:${id}`) };
}

async function plugin(server, { version = "0.1.0", settings = recordingSettings() } = {}) {
  const box = sandbox();
  const ObsyncPlugin = box.require(join(box.home, "build", "main.js")).default;
  const obsidian = box.require("obsidian");
  obsidian.notices.length = 0;
  obsidian.raised.length = 0;
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
  // `setting` is set by the host at runtime and absent from the vendored
  // declaration; a test that dropped it would prove nothing about the real app.
  instance.app = { vault: { adapter, configDir: ".obsidian" }, ...(settings === null ? {} : { setting: settings }) };
  instance.updateAvailable = null;
  instance.updateNotified = false;
  instance.log = (line) => logs.push(line);
  return { instance, adapter, logs, settings, notices: obsidian.notices, raised: obsidian.raised, ObsyncPlugin };
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
  assert.ok(logs.some((line) => line.includes("update decision=notified server=9.9.9 local=0.1.0")));
});

test("the notice and the settings line direct updates to Obsidian's plugin manager", async () => {
  const server = hostileServer({ version: "9.9.9" });
  const { instance, notices } = await plugin(server);
  assert.equal(instance.updateLine(), null, "nothing is claimed before the server is asked");

  await instance.checkForUpdate();

  assert.equal(notices.length, 1);
  const notice = notices[0];
  assert.equal(notice,
    "Self Hosted Private Sync 9.9.9 is available (this device runs 0.1.0). "
    + "Open Settings → Community plugins → Check for updates.");
  // A phone-width notice wraps or truncates: what survives must be the name
  // and the versions, so neither may come after the instruction.
  assert.ok(notice.indexOf("Self Hosted Private Sync") < notice.indexOf("Settings"), notice);
  assert.ok(notice.indexOf("0.1.0") < notice.indexOf("Settings"), notice);
  assert.doesNotMatch(notice, /\.zip|reinstall|releases\/tag|\/v1\/plugin\/bundle/);
  assert.equal(instance.updateAvailable, "9.9.9");
  assert.equal(instance.updateLine(), notice, "the settings tab says the same thing");
});

test("a second version reads the same way, with its own two numbers", async () => {
  const { instance, notices } = await plugin(hostileServer({ version: "2.0.0" }), { version: "1.0.5" });

  await instance.checkForUpdate();

  assert.equal(notices[0],
    "Self Hosted Private Sync 2.0.0 is available (this device runs 1.0.5). "
    + "Open Settings → Community plugins → Check for updates.");
});

test("tapping the notice opens Obsidian's own Community plugins page", async () => {
  const { instance, raised, settings, logs, adapter, ObsyncPlugin } = await plugin(hostileServer());

  await instance.checkForUpdate();
  assert.equal(raised.length, 1, "the notice exists to be pressed");
  raised[0].noticeEl.dispatch("click");

  assert.deepEqual(settings.opened, ["open", "tab:community-plugins"],
    "the settings window opens on the page that installs updates");
  assert.ok(logs.includes("update decision=opened_plugin_manager"), logs.join(" | "));
  assert.equal(raised[0].hidden, true, "and the host still dismisses its own notice");
  // Reaching the manager is still not installing: nothing was written and no
  // installer exists to call.
  assert.deepEqual(adapter.writes, []);
  assert.equal(typeof ObsyncPlugin.prototype.installUpdate, "undefined");
});

test("a tap that lands on the notice's padding, not on its text, opens it too", async () => {
  // `noticeEl` is the text element inside the box; the box is `containerEl`.
  // A thumb on a phone hits the padding as often as the words.
  const { instance, raised, settings } = await plugin(hostileServer());

  await instance.checkForUpdate();
  raised[0].containerEl.dispatch("click");

  assert.deepEqual(settings.opened, ["open", "tab:community-plugins"]);
});

test("a host with no settings window refuses in the log instead of throwing in a click handler", async () => {
  const { instance, raised, logs } = await plugin(hostileServer(), { settings: null });

  await instance.checkForUpdate();
  assert.equal(instance.app.setting, undefined, "this host never set the member");
  raised[0].noticeEl.dispatch("click");

  assert.ok(logs.includes("update decision=refused reason=settings_window_unavailable"), logs.join(" | "));
  assert.equal(logs.filter((line) => line.includes("opened_plugin_manager")).length, 0);
});

test("the notice is raised once per session however often the check runs", async () => {
  const { instance, notices, raised, logs, settings } = await plugin(hostileServer());

  await instance.checkForUpdate();
  await instance.checkForUpdate();
  await instance.checkForUpdate();

  assert.equal(notices.length, 1, "one toast, not one per probe");
  assert.equal(raised.length, 1);
  assert.equal(logs.filter((line) => line.startsWith("update decision=notified ")).length, 1, logs.join(" | "));
  // The row keeps saying it for as long as it is true, and the button keeps working.
  assert.equal(instance.updateAvailable, "9.9.9");
  assert.match(instance.updateLine(), /^Self Hosted Private Sync 9\.9\.9 is available/);
  instance.openPluginManager();
  assert.deepEqual(settings.opened, ["open", "tab:community-plugins"]);
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
