/**
 * The two device-management actions the settings tab performs: renaming this
 * device with its two ceilings, and revoking a device after a confirmation.
 *
 * These run the REAL plugin methods — loaded from `build/main.js` inside the
 * sandbox where `obsidian` resolves to a stub — over the real transport
 * against the fake obsyncd, which verifies every signature. Only Obsidian's
 * widgets are absent; the behaviour under test is not.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FakeServer, KEYS, fakeState, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport, ApiError } = require("../build/transport.js");

const OTHER_DEVICE = "1122334455667788990011223344ffff";

/**
 * A plugin instance with real state and transport, and no Obsidian widgets.
 * `wrap` puts a lossy hop in front of the fake server, which is the only way
 * to reach the code that settles an answer that never arrived.
 */
async function plugin(wrap = (request) => request) {
  const box = sandbox();
  const ObsyncPlugin = box.require(join(box.home, "build", "main.js")).default;
  const server = new FakeServer();
  const { state } = await fakeState(false);
  const logs = [];
  const transport = new Transport({
    request: wrap(server.request),
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    maxAttempts: 2,
  });
  const instance = Object.create(ObsyncPlugin.prototype);
  instance.state = state;
  instance.transport = transport;
  instance.engine = null;
  instance.manifest = { id: "obsync", version: "0.1.0" };
  instance.log = (line) => logs.push(line);
  return { instance, server, state, logs };
}

test("a device with no chosen name falls back to platform and id", async () => {
  const { instance, state } = await plugin();
  assert.equal(instance.deviceName(), `macos-${KEYS.deviceId.slice(0, 4)}`);
  state.data.deviceId = null;
  assert.equal(instance.deviceName(), "macos");
});

test("saving this device sends the name AND both ceilings, and keeps them", async () => {
  const { instance, server, state } = await plugin();
  state.data.policy = { perFileMaxBytes: 512 * 1024 * 1024, totalBudgetBytes: 50 * 1024 * 1024 * 1024 };

  await instance.saveDeviceSettings("  Kitchen iPad  ");

  const patch = server.requests.find((request) => request.method === "PATCH");
  assert.ok(patch, "the settings reached the server");
  assert.equal(patch.target, `/v1/devices/${KEYS.deviceId}`);
  const body = JSON.parse(patch.json);
  assert.equal(body.name, "Kitchen iPad", "the name is trimmed");
  assert.deepEqual(body.policy, {
    perFileMaxBytes: 512 * 1024 * 1024,
    totalBudgetBytes: 50 * 1024 * 1024 * 1024,
  });
  assert.equal(server.devices[0].name, "Kitchen iPad");
  assert.deepEqual(server.devices[0].policy, body.policy);

  // The name survives locally, so the field and conflict copies agree offline.
  assert.equal(state.data.deviceName, "Kitchen iPad");
  assert.equal(instance.deviceName(), "Kitchen iPad");
  const reloaded = await fakeState(false);
  assert.equal(typeof reloaded.state.data.deviceName, "object", "a fresh device has no chosen name");
});

test("clearing the name restores the default rather than sending an empty one", async () => {
  const { instance, server, state } = await plugin();
  await instance.saveDeviceSettings("Named");
  await instance.saveDeviceSettings("   ");
  const patches = server.requests.filter((request) => request.method === "PATCH");
  assert.equal(JSON.parse(patches[1].json).name, `macos-${KEYS.deviceId.slice(0, 4)}`);
  assert.equal(state.data.deviceName, null);
});

test("an unpaired device cannot save device settings", async () => {
  const { instance, server, state } = await plugin();
  state.data.deviceId = null;
  await assert.rejects(() => instance.saveDeviceSettings("Anything"), /not paired/);
  assert.equal(server.requests.filter((request) => request.method === "PATCH").length, 0);
});

test("the device list is what the server reports", async () => {
  const { instance, server } = await plugin();
  server.devices.push({
    device_id: OTHER_DEVICE,
    name: "iPhone",
    platform: "ios",
    app_version: "0.1.0",
    last_seen: 1757200000000,
    revoked: false,
    policy: { perFileMaxBytes: 536870912, totalBudgetBytes: 53687091200 },
  });
  const devices = await instance.listDevices();
  assert.equal(devices.length, 2);
  assert.deepEqual(
    devices.map((device) => device.name),
    ["test-device", "iPhone"],
  );
  assert.equal(devices[1].platform, "ios");
  const listed = server.requests.filter((request) => request.target === "/v1/devices");
  assert.ok(listed.length >= 1, "the list came from GET /v1/devices");
});

test("revoking another device takes effect and does not disturb this one", async () => {
  const { instance, server, logs } = await plugin();
  server.devices.push({
    device_id: OTHER_DEVICE,
    name: "iPhone",
    platform: "ios",
    app_version: "0.1.0",
    last_seen: 0,
    revoked: false,
    policy: {},
  });

  await instance.revokeDevice(OTHER_DEVICE);

  assert.equal(server.devices[1].revoked, true);
  assert.equal(server.devices[0].revoked, false, "this device is untouched");
  assert.ok(logs.some((line) => line.includes("device decision=revoked self=false")));
  const revoke = server.requests.find((request) => request.target.endsWith("/revoke"));
  assert.equal(revoke.target, `/v1/devices/${OTHER_DEVICE}/revoke`);
  assert.equal(revoke.method, "POST");
});

test("the only device cannot revoke itself, and the server's reason is surfaced", async () => {
  const { instance, server } = await plugin();
  assert.equal(server.devices.length, 1);

  await assert.rejects(
    () => instance.revokeDevice(KEYS.deviceId),
    (error) => {
      assert.ok(error instanceof ApiError, "the refusal keeps its status and code");
      assert.equal(error.status, 409);
      assert.equal(error.code, "only_device");
      assert.match(error.message, /the only device cannot revoke itself/);
      return true;
    },
  );
  assert.equal(server.devices[0].revoked, false, "nothing was revoked");
});

test("revoking this device stops syncing and says so in the status", async () => {
  const { instance, server } = await plugin();
  server.devices.push({
    device_id: OTHER_DEVICE,
    name: "iPhone",
    platform: "ios",
    app_version: "0.1.0",
    last_seen: 0,
    revoked: false,
    policy: {},
  });
  let stopped = false;
  instance.engine = { stop: () => (stopped = true) };

  await instance.revokeDevice(KEYS.deviceId);

  assert.equal(stopped, true, "the engine was stopped");
  assert.equal(instance.engine, null);
  assert.match(instance.statusText(), /this device was revoked/);
  assert.equal(server.devices[0].revoked, true);
});

test("revoking an unknown device is refused, not silently ignored", async () => {
  const { instance } = await plugin();
  await assert.rejects(() => instance.revokeDevice("00".repeat(16)), /unknown_device/);
});

/** Lose the answer to `target` once; `before` loses the request instead. */
function lossy(target, before = false) {
  let lost = false;
  return (request) => async (sending) => {
    const losing = !lost && sending.url.endsWith(target);
    if (losing && before) {
      lost = true;
      throw new Error("network is unreachable");
    }
    const response = await request(sending);
    if (losing) {
      lost = true;
      throw new Error("the answer was lost");
    }
    return response;
  };
}

const SECOND_DEVICE = {
  device_id: OTHER_DEVICE,
  name: "iPhone",
  platform: "ios",
  app_version: "0.1.0",
  last_seen: 0,
  revoked: false,
  policy: {},
};

test("a revoke whose answer is lost is settled by reading the device list", async () => {
  const { instance, server, logs } = await plugin(lossy("/revoke"));
  server.devices.push({ ...SECOND_DEVICE });

  await instance.revokeDevice(OTHER_DEVICE);

  assert.equal(server.devices[1].revoked, true, "the server had applied it");
  assert.equal(
    server.requests.filter((request) => request.target.endsWith("/revoke")).length,
    1,
    "a revoke is never sent twice",
  );
  assert.ok(logs.some((line) => line.includes("device decision=reconciled") && line.includes("revoked=true")));
  assert.ok(logs.some((line) => line.includes("device decision=revoked")), "and it is reported as done");
});

test("a revoke that never landed is reported with its exact reason, not as done", async () => {
  const { instance, server, logs } = await plugin(lossy("/revoke", true));
  server.devices.push({ ...SECOND_DEVICE });

  await assert.rejects(() => instance.revokeDevice(OTHER_DEVICE), (error) => {
    assert.match(error.message, /the server never answered \(network=network is unreachable\)/);
    assert.match(error.message, /It was not repeated/);
    return true;
  });
  assert.equal(server.devices[1].revoked, false);
  assert.ok(logs.some((line) => line.includes("device decision=reconciled") && line.includes("revoked=false")));
  assert.equal(
    logs.some((line) => line.includes("device decision=revoked")),
    false,
    "a lost answer is never reported as success",
  );
});
