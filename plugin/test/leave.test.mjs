/**
 * Leaving a server, and switching to another one, without a new vault
 * (issue #79).
 *
 * The plugin under test is the REAL compiled one, loaded from `build/main.js`
 * in a sandbox where `obsidian` resolves to a stub, over the REAL transport
 * and the REAL `State` — so the credential really is signed with, the
 * metadata file and the native secret entry really are written, and the fake
 * obsyncd verifies every signature. The vault is a `FakeHost`, so "no note
 * was touched" is a claim about the same files the engine would have written.
 *
 * Two servers appear here, told apart by address exactly as a device tells
 * them apart: the one being left, and the one being switched to.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  DEVICE_B,
  FakeHost,
  FakeServer,
  KEYS,
  SECRET_B,
  SETUP_DEVICE,
  SETUP_SECRET,
  SETUP_TOKEN,
  memorySecrets,
  sandbox,
} from "./fake.mjs";

const OLD = "https://sync.example.invalid";
const NEW = "https://other.example.invalid";
const NOTE = "Notes/kept.md";
const SENTINEL = "LOCAL NOTE SENTINEL\n";

/**
 * One enrolled device, one vault, two servers.
 *
 * `onload` runs, so `State` is opened the way the app opens it and every
 * write lands in `metadata`/`secrets` where a test can read it back. Only the
 * vault host, the transport and the engine are replaced afterwards: the
 * leaving code itself is untouched.
 */
async function fixture(t, { devices = 1, isMobile = false } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const { Transport } = box.require(join(box.home, "build/transport.js"));

  const old = new FakeServer();
  if (devices > 1) old.addDevice(DEVICE_B, SECRET_B, "iPhone");
  const other = new FakeServer({ claimed: false });
  const host = new FakeHost();
  const logs = [];
  const secrets = memorySecrets();
  let metadata = {
    vrk: KEYS.vrk,
    deviceId: KEYS.deviceId,
    deviceSecret: KEYS.deviceSecret,
    deviceName: "Study laptop",
    serverUrl: OLD,
    edgeHeaders: [{ name: "X-Edge-Token", value: "EDGE TOKEN SENTINEL" }],
    lastSeq: 42,
    files: {},
    syncFolders: ["Notes"],
  };
  metadata.files[NOTE] = { fileId: "12".repeat(16), versionId: "34".repeat(32), mtime: 1757200000000, size: SENTINEL.length, sha256: "" };
  host.seed(NOTE, SENTINEL, 1757200000000);

  const instance = new Plugin();
  let starts = 0;
  instance.loadData = async () => structuredClone(metadata);
  instance.saveData = async (value) => { metadata = structuredClone(value); };
  instance.addCommand = instance.addSettingTab = instance.registerEvent = instance.registerObsidianProtocolHandler = () => {};
  instance.addStatusBarItem = () => ({ setText() {} });
  instance.app = { secretStorage: secrets, vault: { adapter: {}, on: () => ({}) }, workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed() } };
  instance.manifest = { id: "obsync-private-sync", version: "1.0.6" };
  instance.checkForUpdate = async () => {};
  instance.startEngine = async () => { starts++; };
  instance.log = (line) => logs.push(line);
  await instance.onload();

  /** Which server an address belongs to, and what the metadata said at the time. */
  const seen = [];
  const route = async (request) => {
    seen.push({ target: request.url.replace(/^https?:\/\/[^/]+/, ""), deviceId: metadata.deviceId, url: request.url });
    return request.url.startsWith(NEW) ? other.request(request) : old.request(request);
  };
  instance.host = host;
  instance.transport = new Transport({
    request: route,
    serverUrl: () => instance.state.data.serverUrl,
    device: () => {
      const { deviceId, deviceSecret } = instance.state.data;
      return deviceId && deviceSecret ? { id: deviceId, secret: Uint8Array.from(Buffer.from(deviceSecret, "hex")) } : null;
    },
    edgeHeaders: () => instance.state.data.edgeHeaders,
    maxAttempts: 2,
  });
  if (isMobile) Object.defineProperty(instance, "isMobile", { value: true });
  starts = 0;
  logs.length = 0;

  return {
    box, obsidian, instance, old, other, host, logs, seen,
    state: () => instance.state.data,
    metadata: () => structuredClone(metadata),
    envelope: () => secrets.getSecret(metadata.credentialRef),
    revokes: () => seen.filter((request) => request.target.endsWith("/revoke")),
    unpair: () => logs.filter((line) => line.startsWith("unpair ")),
    starts: () => starts,
  };
}

/** Every path the fake vault holds, with its bytes, so "untouched" is checkable. */
function vault(host) {
  return [...host.files.keys()].sort().map((path) => `${path}=${host.text(path)}`);
}

test("leaving with another device revokes THIS device before anything local is cleared", async (t) => {
  const r = await fixture(t, { devices: 2 });
  const before = vault(r.host);

  const result = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  assert.deepEqual(result, { decision: "left", revoked: true });
  // The revoke is signed with the credential, so it MUST precede the clear.
  const revokes = r.revokes();
  assert.equal(revokes.length, 1, "exactly one revoke, for this device only");
  assert.equal(revokes[0].target, `/v1/devices/${KEYS.deviceId}/revoke`);
  assert.equal(revokes[0].deviceId, KEYS.deviceId, "the pairing was still stored when the server was asked");
  assert.equal(r.old.devices[0].revoked, true);
  assert.equal(r.old.devices[1].revoked, false, "the other device is untouched");
  assert.equal(r.other.requests.length, 0, "no other server was contacted");

  // Cleared, in memory and on disk.
  for (const data of [r.state(), r.metadata()]) {
    assert.equal(data.deviceId, null);
    assert.equal(data.serverUrl, "");
    assert.equal(data.lastSeq, 0);
    assert.deepEqual(data.files, {});
    assert.deepEqual(data.remoteOnly, {});
  }
  assert.equal(r.state().deviceSecret, null);
  assert.deepEqual(r.state().edgeHeaders, [], "a service token belongs to the server it was issued for");
  assert.equal(JSON.stringify(r.metadata()).includes("EDGE TOKEN SENTINEL"), false);

  // Kept: the vault key above all, so this is the same vault when it pairs again.
  assert.equal(r.state().vrk, KEYS.vrk);
  assert.equal(r.state().deviceName, "Study laptop");
  assert.deepEqual(r.state().syncFolders, ["Notes"]);
  assert.equal(r.instance.state.paired, false);
  assert.equal(r.instance.statusText(), "not paired");

  // The vault itself is exactly as it was.
  assert.deepEqual(vault(r.host), before);
  assert.deepEqual(r.host.trashed, []);
  assert.equal(r.unpair().length, 1, "one line says what happened");
  assert.match(r.unpair()[0], /^unpair decision=revoked reason=ok unpushed=0 local_cleared=true previous_credential=dropped duration_ms=\d+$/);
});

test("the credential this device gave up does not survive in the native store", async (t) => {
  const r = await fixture(t, { devices: 2 });
  const entry = r.envelope();
  assert.ok(entry.includes(KEYS.deviceSecret), "the fixture really did hold the secret");

  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  const after = r.envelope();
  assert.equal(after.includes(KEYS.deviceSecret), false, "no revision keeps the revoked secret");
  assert.equal(after.includes(KEYS.deviceId), false);
  assert.equal(after.includes("EDGE TOKEN SENTINEL"), false);
  const parsed = JSON.parse(after);
  assert.equal(parsed.previous, null, "the bounded previous revision is collapsed");
  assert.equal(parsed.current.vrk, KEYS.vrk, "the vault key is not a credential and stays");
  assert.equal(parsed.current.revision, r.metadata().credentialRevision, "metadata names the revision that survived");
  // And the state still loads, from exactly that revision.
  const { State } = r.box.require(join(r.box.home, "build/state.js"));
  const reloaded = await State.open(
    { loadData: async () => r.metadata(), saveData: async () => {} },
    false,
    { getSecret: () => after, setSecret: () => {} },
  );
  assert.equal(reloaded.data.vrk, KEYS.vrk);
  assert.equal(reloaded.paired, false);
});

test("a device that has left can enrol on another server, and it is still the same vault", async (t) => {
  const r = await fixture(t, { devices: 2 });

  // The stuck state issue #79 describes: an enrolled device cannot set up.
  r.instance.state.data.serverUrl = NEW;
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");
  assert.ok(r.obsidian.notices.some((message) => message.includes("already has an enrollment")));
  assert.equal(r.other.requests.length, 0, "nothing was sent");
  r.instance.state.data.serverUrl = OLD;
  r.obsidian.notices.length = 0;

  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  await r.instance.setServerUrl("other.example.invalid");
  assert.equal(r.state().serverUrl, NEW);
  await r.instance.setUpAccount(SETUP_TOKEN, "obsync");

  assert.equal(r.state().deviceId, SETUP_DEVICE, "a new identity on the new server");
  assert.equal(r.state().deviceSecret, SETUP_SECRET);
  assert.equal(r.state().vrk, KEYS.vrk, "the SAME vault key: not a new vault");
  assert.equal(r.instance.state.paired, true);
  assert.equal(r.other.devices.length, 1);
  assert.equal(r.other.devices[0].name, "Study laptop");
  assert.ok(r.obsidian.notices.some((message) => message.includes("Account created")));
  assert.equal(r.envelope().includes(KEYS.deviceSecret), false, "the old server's credential is still gone");
  assert.deepEqual(r.host.trashed, [], "pairing again moved no note");
});

test("the last active device is refused, with the server's own reason and nothing changed", async (t) => {
  const r = await fixture(t);
  const before = { state: r.state(), metadata: r.metadata(), envelope: r.envelope(), vault: vault(r.host) };

  const result = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  assert.equal(result.decision, "refused");
  assert.equal(result.reason, "last_device");
  assert.equal(result.detail, "the only active device cannot be revoked; pair another first");
  assert.equal(r.revokes().length, 1, "it was asked, once");
  assert.equal(r.old.devices[0].revoked, false);
  assert.deepEqual(r.state(), before.state, "the pairing is exactly as it was");
  assert.deepEqual(r.metadata(), before.metadata);
  assert.equal(r.envelope(), before.envelope);
  assert.deepEqual(vault(r.host), before.vault);
  assert.equal(r.instance.state.paired, true);
  assert.equal(r.starts(), 1, "a refusal leaves this device syncing");
  assert.match(r.unpair()[0], /decision=refused reason=last_device unpushed=0 local_cleared=false/);
});

test("the last active device may still leave locally, and is told the server kept it", async (t) => {
  const r = await fixture(t);

  const result = await r.instance.leaveServer({ discardUnpushed: false, localOnly: true });

  assert.deepEqual(result, { decision: "left", revoked: false });
  assert.equal(r.old.devices[0].revoked, false, "the server refused, and that refusal stands");
  assert.equal(r.state().deviceId, null, "this device forgot it anyway");
  assert.equal(r.state().serverUrl, "");
  assert.equal(r.state().vrk, KEYS.vrk);
  assert.deepEqual(vault(r.host), [`${NOTE}=${SENTINEL}`]);
  // The server kept the device and this one forgot it: that is a local leave,
  // not a refusal (2026-09-24 verification, V14).
  assert.match(r.unpair()[0], /decision=left_locally reason=last_device unpushed=0 local_cleared=true/);
});

test("leaving is refused while this device holds edits the server never received", async (t) => {
  const r = await fixture(t, { devices: 2 });
  r.host.seed("Notes/new.md", "NEVER PUSHED SENTINEL\n");
  r.host.seed(NOTE, "EDITED SENTINEL\n", 1757200009999);
  r.instance.state.data.files["Notes/gone.md"] = { fileId: "56".repeat(16), versionId: "78".repeat(32), mtime: 1, size: 1, sha256: "" };

  const refused = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  assert.equal(refused.decision, "refused");
  assert.equal(refused.reason, "unpushed_edits");
  assert.deepEqual(refused.unpushed, ["Notes/gone.md", "Notes/kept.md", "Notes/new.md"]);
  assert.deepEqual(r.revokes(), [], "the guard runs before the server is asked");
  assert.equal(r.state().deviceId, KEYS.deviceId, "nothing was cleared");
  assert.equal(r.starts(), 1, "and this device keeps syncing");
  assert.match(r.unpair()[0], /decision=refused reason=unpushed_edits unpushed=3 local_cleared=false/);

  const left = await r.instance.leaveServer({ discardUnpushed: true, localOnly: false });

  assert.deepEqual(left, { decision: "left", revoked: true });
  assert.equal(r.state().deviceId, null);
  assert.deepEqual(vault(r.host), ["Notes/kept.md=EDITED SENTINEL\n", "Notes/new.md=NEVER PUSHED SENTINEL\n"]);
  assert.match(r.unpair()[1], /decision=revoked reason=ok unpushed=3 local_cleared=true/);
});

test("what this device would never push is not an unpushed edit", async (t) => {
  const r = await fixture(t, { devices: 2 });
  // Outside the folder selection, hidden, and refused by the host: three
  // reasons the engine would never send these, so none of them may block
  // leaving for ever.
  r.host.seed("Private/ledger.md", "OUT OF SCOPE SENTINEL\n");
  r.host.seed(".obsidian/plugins/obsync-private-sync/data.json", "HIDDEN SENTINEL\n");
  r.host.seed("Notes/linked.md", "SYMLINKED SENTINEL\n");
  r.host.unsyncable.add("Notes/linked.md");

  assert.deepEqual(await r.instance.unpushedEdits(), []);
  assert.deepEqual((await r.instance.leaveServer({ discardUnpushed: false, localOnly: false })).decision, "left");
  assert.deepEqual(vault(r.host).length, 4, "and every one of them is still in the vault");
});

test("a revoke whose answer never arrived leaves this device paired", async (t) => {
  const r = await fixture(t, { devices: 2 });
  const route = r.instance.transport.options.request;
  let lost = false;
  r.instance.transport.options.request = async (request) => {
    if (!lost && request.url.endsWith("/revoke")) {
      lost = true;
      throw new Error("network is unreachable");
    }
    return route(request);
  };

  await assert.rejects(
    () => r.instance.leaveServer({ discardUnpushed: false, localOnly: false }),
    /the server never answered \(network=network is unreachable\)/,
  );

  assert.equal(r.old.devices[0].revoked, false);
  assert.equal(r.state().deviceId, KEYS.deviceId, "an uncertain revoke never clears the credential");
  assert.equal(r.state().serverUrl, OLD);
  assert.ok(r.envelope().includes(KEYS.deviceSecret));
  assert.equal(r.starts(), 1);
  assert.match(r.unpair()[0], /decision=refused reason=local_or_lost unpushed=0 local_cleared=false/);
});

test("a plugin reload during the revoke stops the clear and says so", async (t) => {
  const r = await fixture(t, { devices: 2 });
  const route = r.instance.transport.options.request;
  r.instance.transport.options.request = async (request) => {
    const response = await route(request);
    // The load that issued this is gone: Obsidian reloaded the plugin while
    // the server was answering.
    if (request.url.endsWith("/revoke")) r.instance.lifecycle = {};
    return response;
  };

  await assert.rejects(
    () => r.instance.leaveServer({ discardUnpushed: false, localOnly: false }),
    /previous plugin session is inactive/,
  );

  assert.equal(r.old.devices[0].revoked, true, "the server was asked, and answered");
  assert.equal(r.state().deviceId, KEYS.deviceId, "but this load cleared nothing");
  assert.equal(r.metadata().deviceId, KEYS.deviceId);
  assert.match(r.unpair()[0], /decision=revoked reason=unfinished unpushed=0 local_cleared=false/);
});

test("leaving refuses while a folder change or a restore is in flight", async (t) => {
  for (const busy of ["changingScope", "restoring"]) {
    const r = await fixture(t, { devices: 2 });
    r.instance[busy] = busy === "changingScope" ? true : {};
    await assert.rejects(() => r.instance.leaveServer({ discardUnpushed: false, localOnly: false }), /folder selection or restoring/);
    assert.deepEqual(r.revokes(), []);
    assert.equal(r.state().deviceId, KEYS.deviceId);
    assert.match(r.unpair()[0], /decision=refused reason=busy unpushed=0 local_cleared=false/);
  }
});

test("an unpaired device has nothing to leave, and says so once", async (t) => {
  const r = await fixture(t, { devices: 2 });
  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  await assert.rejects(() => r.instance.leaveServer({ discardUnpushed: false, localOnly: false }), /not paired with a server/);
  assert.equal(r.revokes().length, 1, "the second attempt sends nothing");
  assert.match(r.unpair()[1], /decision=refused reason=not_paired unpushed=0 local_cleared=false/);
});

test("switching to a plain-HTTP address is refused on mobile before anything is saved", async (t) => {
  const r = await fixture(t, { devices: 2, isMobile: true });
  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  await assert.rejects(() => r.instance.setServerUrl("http://lan.example.invalid"), /only reaches HTTPS servers/);
  assert.equal(r.state().serverUrl, "");
  await r.instance.setServerUrl("other.example.invalid");
  assert.equal(r.state().serverUrl, NEW, "a bare host is completed to https, which mobile accepts");
});

test("a device left with no credential can send nothing at all", async (t) => {
  const r = await fixture(t, { devices: 2 });
  await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  await assert.rejects(() => r.instance.transport.account(), /no_server_url/);
  r.instance.state.data.serverUrl = NEW;
  await assert.rejects(() => r.instance.transport.account(), /not_paired/);
  assert.deepEqual(r.old.unsigned, [], "nothing unsigned ever reached the server it left");
});

test("a device revoked elsewhere leaves locally, which is its way back to pairing (#143)", async (t) => {
  // S20 and S80: revoked from another device or the dashboard, and then told
  // to leave before it may pair again. The server refuses the revoke because
  // it is already done.
  const r = await fixture(t, { devices: 2 });
  r.old.devices.find((device) => device.device_id === KEYS.deviceId).revoked = true;
  const before = vault(r.host);

  const result = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });

  assert.deepEqual(result, { decision: "left", revoked: true });
  assert.equal(r.revokes().length, 1, "it was asked, once");
  assert.equal(r.state().deviceId, null, "the credential the server dropped is dropped here too");
  assert.equal(r.state().lastSeq, 0);
  assert.deepEqual(r.state().files, {});
  assert.equal(r.state().vrk, KEYS.vrk, "the same vault key stays");
  assert.equal(r.instance.state.paired, false, "so pairing is open again");
  assert.deepEqual(vault(r.host), before, "every note stays");
  assert.match(r.unpair()[0], /decision=revoked reason=device_revoked unpushed=0 local_cleared=true/);
});

test("a server that does not know this device is offered a local leave, never taken unasked (#143)", async (t) => {
  // S14: the server was rebuilt empty, so every signed request is refused
  // `401 bad_signature` -- and a wrong address answers the same, which is why
  // the local leave is the user's call and not a default.
  const r = await fixture(t, { devices: 2 });
  const route = r.instance.transport.options.request;
  r.instance.transport.options.request = async (request) => request.url.endsWith("/revoke")
    ? { status: 401, headers: {}, text: JSON.stringify({ error: "bad_signature", detail: "request signature does not verify" }), arrayBuffer: new ArrayBuffer(0) }
    : route(request);
  const before = r.state();

  const refused = await r.instance.leaveServer({ discardUnpushed: false, localOnly: false });
  assert.deepEqual(refused, { decision: "refused", reason: "bad_signature", detail: "request signature does not verify" });
  assert.deepEqual(r.state(), before, "nothing was cleared without the user's word");

  const left = await r.instance.leaveServer({ discardUnpushed: false, localOnly: true });
  assert.deepEqual(left, { decision: "left", revoked: false });
  assert.equal(r.state().deviceId, null);
  assert.equal(r.state().vrk, KEYS.vrk);
  assert.equal(r.instance.state.paired, false, "so pairing is open again");
  assert.match(r.unpair()[1], /decision=left_locally reason=bad_signature unpushed=0 local_cleared=true/);
});
