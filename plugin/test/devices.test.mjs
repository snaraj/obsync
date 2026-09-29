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
import { join } from "node:path";
import { FakeServer, KEYS, fakeState, sandbox } from "./fake.mjs";

const OTHER_DEVICE = "1122334455667788990011223344ffff";

/**
 * A plugin instance with real state and transport, and no Obsidian widgets.
 * `wrap` puts a lossy hop in front of the fake server, which is the only way
 * to reach the code that settles an answer that never arrived.
 */
async function plugin(wrap = (request) => request) {
  const box = sandbox();
  const ObsyncPlugin = box.require(join(box.home, "build", "main.js")).default;
  // The plugin's own transport module, so a refusal is the `ApiError` the
  // plugin checks for, as it is in a real vault.
  const { Transport, ApiError } = box.require(join(box.home, "build", "transport.js"));
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
  const instance = new ObsyncPlugin();
  instance.state = state;
  instance.transport = transport;
  instance.engine = null;
  instance.manifest = { id: "obsync", version: "0.1.0" };
  instance.log = (line) => logs.push(line);
  return { instance, server, state, logs, ApiError };
}

test("a device with no chosen name is what it is and a tag made here, before and after it enrols (#152)", async () => {
  const { instance, state } = await plugin();
  state.data.deviceId = null;
  const name = instance.deviceName();
  assert.match(name, /^Mac [2-9A-HJKMNP-TV-Z]{4}$/, "never the bare platform every Mac used to share");
  assert.equal(state.data.deviceTag, name.slice("Mac ".length), "the tag is this device's, kept");
  state.data.deviceId = KEYS.deviceId;
  assert.equal(instance.deviceName(), name, "enrolling does not rename it");
  // The tag survives a reload, so the name does too.
  await state.save();
  const again = await instance.nameThisDevice();
  assert.equal(again, name);
});

test("a device's tag is kept before its name is sent anywhere (#152)", async () => {
  const { instance, state } = await plugin();
  state.data.deviceTag = null;
  const save = state.save.bind(state), saved = [];
  state.save = async () => { saved.push(state.data.deviceTag); await save(); };
  const name = await instance.nameThisDevice();
  assert.deepEqual(saved, [name.slice("Mac ".length)], "one save, carrying the tag, before the name leaves");
  await instance.nameThisDevice();
  assert.equal(saved.length, 1, "a kept tag is not saved again");
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
    per_file_max_bytes: 512 * 1024 * 1024,
    total_budget_bytes: 50 * 1024 * 1024 * 1024,
  });
  assert.equal(server.devices[0].name, "Kitchen iPad");
  assert.deepEqual(server.devices[0].policy, body.policy);

  // The name survives locally, so the field and conflict copies agree offline.
  assert.equal(state.data.deviceName, "Kitchen iPad");
  assert.equal(instance.deviceName(), "Kitchen iPad");
  const reloaded = await fakeState(false);
  assert.equal(typeof reloaded.state.data.deviceName, "object", "a fresh device has no chosen name");
});

test("the server model refuses invalid policy fields before acknowledging heartbeat or settings", async () => {
  const { instance, server, ApiError } = await plugin();
  for (const field of ["perFileMaxBytes", "totalBudgetBytes"]) {
    for (const invalid of [-1, 0.5]) {
      const policy = { perFileMaxBytes: 512, totalBudgetBytes: 1024, [field]: invalid };
      await assert.rejects(() => instance.transport.heartbeat("0.1.15", policy), ApiError);
      assert.equal(server.heartbeats, 0);
      await assert.rejects(() => instance.transport.patchDevice(KEYS.deviceId, { name: "Unconfirmed", policy }), ApiError);
      assert.equal(server.devices[0].name, "test-device");
    }
  }
});

test("clearing the name restores the default rather than sending an empty one", async () => {
  const { instance, server, state } = await plugin();
  await instance.saveDeviceSettings("Named");
  await instance.saveDeviceSettings("   ");
  const patches = server.requests.filter((request) => request.method === "PATCH");
  assert.equal(JSON.parse(patches[1].json).name, `Mac ${state.data.deviceTag}`);
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
    policy: { per_file_max_bytes: 536870912, total_budget_bytes: 53687091200 },
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

test("the only active device cannot be revoked, and the server's reason is surfaced", async () => {
  const { instance, server, ApiError } = await plugin();
  assert.equal(server.devices.length, 1);

  await assert.rejects(
    () => instance.revokeDevice(KEYS.deviceId),
    (error) => {
      assert.ok(error instanceof ApiError, "the refusal keeps its status and code");
      assert.equal(error.status, 409);
      assert.equal(error.code, "last_device", "obsyncd's own code, not a stub's invention");
      assert.match(error.message, /the only active device cannot be revoked; pair another first/);
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
  instance.engine = { stopAndWait: async () => (stopped = true) };

  await instance.revokeDevice(KEYS.deviceId);

  assert.equal(stopped, true, "the engine was stopped");
  assert.equal(instance.engine, null);
  assert.match(instance.statusText(), /no longer recognises this device/);
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

// ---- forgetting a revoked device (#247) -----------------------------------

const REVOKED = { ...SECOND_DEVICE, revoked: true, state: "revoked" };
const forgetLine = (logs, decision, reason) =>
  logs.find((line) => line.startsWith(`device decision=${decision} action=forget reason=${reason} duration_ms=`) && line.endsWith(" budget_ms=10000"));

test("forgetting a revoked device takes it off this device's list while the server keeps the record", async () => {
  const { instance, server, logs } = await plugin();
  server.devices.push({ ...REVOKED });

  await instance.forgetRevoked(OTHER_DEVICE);

  assert.deepEqual(
    server.devices.map((device) => [device.device_id, device.revoked, device.archived === true]),
    [[KEYS.deviceId, false, false], [OTHER_DEVICE, true, true]],
    "nothing was destroyed: the record is flagged, and still revoked",
  );
  assert.deepEqual(await instance.listDevices(), [server.devices[0]], "and this device lists only what is left");
  const sent = server.requests.filter((request) => request.target.endsWith("/archive"));
  assert.deepEqual(sent.map((request) => `${request.method} ${request.target}`), [`POST /v1/devices/${OTHER_DEVICE}/archive`]);
  assert.ok(forgetLine(logs, "forgotten", "revoked"), logs.join("\n"));
  assert.equal(logs.filter((line) => line.includes("action=forget")).length, 1, "one line per forget");
});

test("a device already forgotten is still refused as revoked, and still names its versions", async () => {
  const { instance, server } = await plugin();
  server.devices.push({ ...REVOKED, name: "Old phone" });
  await instance.forgetRevoked(OTHER_DEVICE);

  const listed = (await instance.transport.devices()).devices.find((device) => device.device_id === OTHER_DEVICE);
  assert.equal(listed.archived, true, "the wire still states it");
  assert.equal(listed.name, "Old phone", "so a version it wrote still has an author");
  assert.equal(listed.revoked, true);
});

test("a device that can still sync is not forgotten, and the refusal is in words", async () => {
  const { instance, server, logs } = await plugin();
  server.devices.push({ ...SECOND_DEVICE });

  await assert.rejects(() => instance.forgetRevoked(OTHER_DEVICE), (error) => {
    assert.equal(error.message, "it can still sync. Revoke it first.");
    return true;
  });
  assert.equal(server.devices.length, 2, "nothing was forgotten");
  assert.ok(forgetLine(logs, "refused", "device_not_revoked"), logs.join("\n"));
});

test("a device already gone from the list is the outcome that was asked for", async () => {
  const { instance, logs } = await plugin();
  await instance.forgetRevoked(OTHER_DEVICE);
  assert.ok(forgetLine(logs, "forgotten", "already_gone"), logs.join("\n"));
});

test("a server before 1.1.5 has no forget: the person is told to update it, and the device stays revoked", async () => {
  const { instance, server, logs } = await plugin();
  server.archives = false;
  server.devices.push({ ...REVOKED });

  await assert.rejects(() => instance.forgetRevoked(OTHER_DEVICE), (error) => {
    assert.equal(error.message, "your server is too old to forget devices. Update it to obsync 1.1.5 or later, then try again.");
    return true;
  });
  assert.equal(server.devices[1].revoked, true, "still listed, still revoked");
  assert.ok(forgetLine(logs, "refused", "not_found"), logs.join("\n"));
});

test("any other refusal is passed on as it came, for the settings tab to word", async () => {
  const { instance, ApiError } = await plugin();
  await assert.rejects(() => instance.forgetRevoked(KEYS.deviceId), (error) => {
    assert.ok(error instanceof ApiError, `${error}`);
    assert.equal(error.code, "own_device");
    return true;
  });
});

test("a forget whose answer is lost is settled by the device list, and never sent twice", async () => {
  const { instance, server, logs } = await plugin(lossy("/archive"));
  server.devices.push({ ...REVOKED });

  await instance.forgetRevoked(OTHER_DEVICE);

  assert.equal(server.devices[1].archived, true, "the server had applied it");
  assert.equal(server.requests.filter((request) => request.target.endsWith("/archive")).length, 1);
  assert.ok(forgetLine(logs, "forgotten", "lost_answer"), logs.join("\n"));
});

test("a forget that never landed is reported with its reason, not as done", async () => {
  const { instance, server, logs } = await plugin(lossy("/archive", true));
  server.devices.push({ ...REVOKED });

  await assert.rejects(() => instance.forgetRevoked(OTHER_DEVICE), (error) => {
    assert.match(error.message, /forgetting that device/);
    assert.match(error.message, /It was not repeated/);
    return true;
  });
  assert.equal(server.devices[1].archived, undefined, "nothing was archived");
  assert.ok(forgetLine(logs, "unconfirmed", "lost_answer"), logs.join("\n"));
  assert.equal(logs.some((line) => line.startsWith("device decision=forgotten")), false, "a lost answer is never reported as success");
});
