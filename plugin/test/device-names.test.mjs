/**
 * What a device calls the others, and itself (issues #152, #164).
 *
 * Names were read at engine start and on the hour, so a device paired after
 * the start was "another device" for up to an hour -- in notices, and in
 * conflict copies that keep the name for good -- and every desktop enrolled
 * before 1.1.4 was "macos" on the server while it called itself "macos-xxxx".
 * These run the real engine against the fake server, which verifies every
 * signature.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine, NAMES_TTL_MS } = require("../build/sync/engine.js");
const c = require("../build/crypto.js");

const MAC = "ffffffffffffffffffffffffffffffff";
const GONE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const enc = (text) => new TextEncoder().encode(text);

async function started({ ownName } = {}) {
  const r = await rig();
  if (ownName !== undefined) r.server.devices[0].name = ownName;
  const timers = new FakeTimers();
  const engine = new SyncEngine({
    state: r.state,
    transport: new Transport({
      request: r.server.request,
      serverUrl: () => r.state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => r.host.clock,
      sleep: async () => undefined,
      maxAttempts: 2,
    }),
    host: r.host,
    now: () => r.host.clock,
    timers,
  });
  await engine.start();
  await timers.run(1000, () => r.host.logs.some((line) => line.startsWith("devices decision=read reason=heartbeat")));
  const reads = () => r.server.requests.filter((request) => request.target === "/v1/devices").length;
  // A version sealed under ANOTHER vault's key: the one notice whose whole
  // point is to name the device that sent it (#140).
  const vrk = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const domainKey = await c.deriveDomainKey(vrk, KEYS.domainId);
  const manifestKey = await c.deriveManifestKey(domainKey, KEYS.domainId);
  let file = 0;
  const foreign = (deviceId) => r.server.publish({
    fileId: String(++file).padStart(32, "0"), path: `Notes/Foreign ${file}.md`, bytes: enc("sealed elsewhere"),
    mtime: 1757200000000, domainKey, manifestKey, deviceId,
  });
  const told = (name) => r.host.notices.some((notice) => notice.includes(`cannot read changes from ${name}:`));
  t_after.push(() => engine.stop());
  return { ...r, timers, engine, reads, foreign, told };
}
const t_after = [];
test.afterEach(() => { while (t_after.length > 0) t_after.pop()(); });

test("a device paired after this one started is named from ONE read, not 'another device' (#164)", async () => {
  const r = await started();
  const before = r.reads();
  r.server.addDevice(MAC, "0e".repeat(32), "Mac 7KQ4", "macos");
  await r.foreign(MAC);
  await r.timers.run(1000, () => r.told("Mac 7KQ4") || r.told("another device"));
  assert.ok(r.told("Mac 7KQ4"), r.host.notices.join(" | "));
  assert.equal(r.reads(), before + 1, "exactly one read for the new id");
  assert.ok(r.host.logs.some((line) => /^devices decision=read reason=unknown_device devices=2 duration_ms=\d+$/.test(line)), r.host.logs.join(" | "));
  // Known now: its next version costs nothing.
  await r.foreign(MAC);
  await r.timers.run(1000, () => r.state.data.lastSeq >= r.server.seq);
  assert.equal(r.reads(), before + 1);
});

test("an id no read can name costs one read, then falls back, once (#164)", async () => {
  const r = await started();
  const before = r.reads();
  r.server.addDevice(GONE, "0d".repeat(32), "ignored", "linux");
  const named = r.server.devices.pop(); // listed nowhere: a device deleted since
  assert.equal(named.device_id, GONE);
  await r.foreign(GONE);
  await r.timers.run(1000, () => r.told("another device"));
  assert.equal(r.reads(), before + 1);
  await r.foreign(GONE);
  await r.timers.run(1000, () => r.state.data.lastSeq >= r.server.seq);
  assert.equal(r.reads(), before + 1, "a page cannot cost a read per record");
});

test("a rename made on another device reaches this one's names once they are stale (#164)", async () => {
  const r = await started();
  r.server.addDevice(MAC, "0e".repeat(32), "Mac 7KQ4", "macos");
  await r.foreign(MAC);
  await r.timers.run(1000, () => r.told("Mac 7KQ4"));
  r.server.devices.find((device) => device.device_id === MAC).name = "Studio Mac";
  // Fresh names serve a page without a read...
  const before = r.reads();
  await r.foreign(MAC);
  await r.timers.run(1000, () => r.state.data.lastSeq >= r.server.seq);
  assert.equal(r.reads(), before);
  // ...and stale ones are read again before the page applies.
  r.host.clock += NAMES_TTL_MS;
  await r.foreign(MAC);
  await r.timers.run(1000, () => r.host.logs.some((line) => line.startsWith("devices decision=read reason=stale ")));
  assert.equal(r.reads(), before + 1);
  assert.equal(r.engine.need().deviceNameFor(MAC), "Studio Mac");
});

test("a refresh after pairing or renaming reads the names at once (#164)", async () => {
  const r = await started();
  const before = r.reads();
  r.server.addDevice(MAC, "0e".repeat(32), "Mac 7KQ4", "macos");
  await r.engine.refreshDeviceNames();
  assert.equal(r.reads(), before + 1);
  assert.equal(r.engine.need().deviceNameFor(MAC), "Mac 7KQ4");
  assert.ok(r.host.logs.some((line) => line.startsWith("devices decision=read reason=requested ")));
});

test("a device enrolled as its bare platform gives the server the name it shows, once (#152)", async () => {
  const r = await started({ ownName: "linux" });
  const patches = r.server.requests.filter((request) => request.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].json), { name: "test-device" });
  assert.equal(r.server.devices[0].name, "test-device");
  assert.ok(r.host.logs.includes("device decision=renamed reason=legacy_default"));
  assert.equal(r.state.data.deviceName, null, "the default stays a default");
  await r.engine.refreshDeviceNames();
  assert.equal(r.server.requests.filter((request) => request.method === "PATCH").length, 1, "once");
});

test("a name another device gave this one becomes its own, and nothing is sent back (#152)", async () => {
  const r = await started({ ownName: "Office desktop" });
  assert.equal(r.server.requests.filter((request) => request.method === "PATCH").length, 0);
  assert.equal(r.state.data.deviceName, "Office desktop");
  assert.ok(r.host.logs.includes("device decision=adopted reason=renamed_elsewhere"));
});

test("a device whose server name is its own touches nothing (#152)", async () => {
  const r = await started();
  assert.equal(r.server.requests.filter((request) => request.method === "PATCH").length, 0);
  assert.equal(r.state.data.deviceName, null);
});
