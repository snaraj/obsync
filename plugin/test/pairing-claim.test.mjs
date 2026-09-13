/** Exercise the actual claimant dialog method with a non-rendering Obsidian stub. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KEYS, sandbox } from "./fake.mjs";

async function claimant(t, response, onWait = () => {}, beforeKeySave = async () => {}, beforeClaim = async () => {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { PairClaimModal } = box.require(join(box.home, "build/ui/modals.js"));
  const { ApiError } = box.require(join(box.home, "build/transport.js"));
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const notices = box.require("obsidian").notices;
  const id = "12".repeat(16), token = "34".repeat(32), secret = new Uint8Array(16).fill(56);
  const sealed = await pairing.sealEnvelope(secret, id, { vrk: KEYS.vrk });
  const calls = [], saves = [], logs = [];
  let restarted = 0, waits = 0;
  const state = { data: { vrk: null, serverUrl: "https://sync.example.invalid" }, assertAvailable() {}, save: async () => {
      const snapshot = { ...state.data };
      if (snapshot.vrk !== null) await beforeKeySave({ saves, plugin, restartCalls: () => restarted });
      saves.push(snapshot);
    } };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const plugin = Object.assign(new Plugin(), {
    state,
    manifest: { version: "0.1.15" }, deviceName: () => "Tablet", platformName: () => "ios",
    log: (line) => logs.push(line), restartEngine: async () => {
      restarted++;
      assert.equal(saves.at(-1)?.vrk, KEYS.vrk, "the approved key must already be persisted");
    },
    transport: {
      pairingClaim: async (pairingId, enrollToken) => {
        assert.equal(pairingId, id); assert.equal(enrollToken, token);
        calls.push("claim");
        await beforeClaim(plugin);
        return { outcome: "ok", value: { device_id: KEYS.deviceId, device_secret: KEYS.deviceSecret } };
      },
      pairingStatus: async () => { calls.push("creator-status"); throw new Error("creator-only route"); },
      pairingEnvelope: async (pairingId) => {
        assert.equal(pairingId, id); calls.push("envelope");
        return response({ ApiError, sealed, plugin, modal, attempt: calls.filter((call) => call === "envelope").length });
      },
    },
  });
  const modal = new PairClaimModal({}, plugin, pairing.encodePairingCode(id, token, secret));
  modal.contentEl = { createEl: () => ({}), empty: () => {} };
  modal.close = () => modal.onClose();
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (resolve, delay) => {
    assert.equal(delay, 2000);
    assert.ok(++waits <= 3, "terminal outcomes must not poll indefinitely");
    onWait(modal, waits, plugin); resolve();
  } };
  t.after(() => { globalThis.window = previousWindow; });
  await modal.claim();
  return { calls, saves, logs, notices, restarted, state: state.data, current: plugin.state.data };
}

test("a claimant waits on its envelope, then saves the approved key before restarting sync", async (t) => {
  const result = await claimant(t, ({ ApiError, sealed, attempt }) => {
    if (attempt === 1) throw new ApiError(409, "not_approved", "approval pending");
    return { outcome: "ok", value: sealed };
  }, (modal) => { void modal.claim(); }); // Repeated taps do not claim twice.
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope"]);
  assert.equal(result.saves.length, 2);
  assert.equal(result.saves[0].vrk, null);
  assert.equal(result.saves[1].vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
  assert.ok(result.logs.includes("pairing role=claimant decision=waiting reason=not_approved"));
  assert.ok(result.logs.includes("pairing role=claimant decision=paired"));
  assert.ok(result.notices.some((notice) => notice.includes("this device is paired")));
});

test("sync stays stopped while the approved key save is pending", async (t) => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const saving = new Promise((resolve) => { entered = resolve; });
  const finished = claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), undefined,
    async (observation) => { entered(observation); await held; });
  let before;
  try {
    const observation = await Promise.race([saving, finished.then(() => {
      throw new Error("claim finished before entering the key save");
    })]);
    before = observation.restartCalls();
    assert.equal(observation.saves.length, 1, "only the device credential is persisted while the key write is held");
    assert.equal(observation.saves[0].vrk, null);
  } finally {
    release();
  }
  const result = await finished;
  assert.equal(before, 0);
  assert.equal(result.restarted, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
});

test("a rejected approved-key save never starts sync", async (t) => {
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), undefined,
    async () => { throw new Error("fixture key save failed"); });
  assert.equal(result.restarted, 0);
  assert.equal(result.saves.length, 1);
  assert.equal(result.saves[0].vrk, null);
  assert.ok(result.notices.some((notice) => notice.includes("fixture key save failed")));
  assert.ok(!result.notices.some((notice) => notice.includes("this device is paired")));
});

test("only the explicit pending-approval refusal permits another envelope request", async (t) => {
  for (const [status, code] of [[403, "not_approved"], [409, "not_claimant"], [410, "pairing_expired"]]) {
    await t.test(`${status} ${code}`, async (subtest) => {
      const result = await claimant(subtest, ({ ApiError }) => { throw new ApiError(status, code, "terminal refusal"); });
      assert.deepEqual(result.calls, ["claim", "envelope"]);
      assert.equal(result.state.vrk, null);
      assert.equal(result.restarted, 0);
      assert.ok(result.notices.some((notice) => notice.includes(code)));
      assert.ok(result.logs.includes(`pairing role=claimant decision=failed reason=${code}`));
    });
  }
});

test("a lost envelope response is surfaced once and never fetched again", async (t) => {
  const result = await claimant(t, () => ({ outcome: "lost", reason: "network", status: 0 }));
  assert.deepEqual(result.calls, ["claim", "envelope"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("collecting the sealed vault key")));
  assert.ok(result.logs.includes("pairing role=claimant decision=failed reason=local_or_lost"));
});

test("an unclassified local error cannot masquerade as pending approval", async (t) => {
  const result = await claimant(t, () => { throw Object.assign(new Error("local failure"), { status: 409, code: "not_approved" }); });
  assert.deepEqual(result.calls, ["claim", "envelope"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("local failure")));
});

test("closing while waiting leaves the one-time envelope unconsumed", async (t) => {
  const result = await claimant(t, () => assert.fail("a closed dialog must not fetch"), (modal) => modal.onClose());
  assert.deepEqual(result.calls, ["claim"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
});

for (const stage of ["claim", "envelope", "key save"]) {
  test(`a superseded ${stage} completion cannot adopt credentials or restart the replacement session`, async (t) => {
    const replacement = { data: { vrk: "replacement sentinel", serverUrl: "https://new.example.invalid" }, save: () => assert.fail("replacement state must not be written") };
    const replace = (plugin) => { plugin.state = replacement; plugin.lifecycle = {}; };
    const result = await claimant(t, ({ sealed, plugin }) => {
      if (stage === "envelope") replace(plugin);
      return { outcome: "ok", value: sealed };
    }, undefined, async ({ plugin }) => { if (stage === "key save") replace(plugin); },
    async (plugin) => { if (stage === "claim") replace(plugin); });
    assert.deepEqual(result.current, replacement.data);
    assert.equal(result.restarted, 0);
    assert.equal(result.saves.length, stage === "claim" ? 0 : stage === "envelope" ? 1 : 2);
    assert.ok(result.notices.some((notice) => notice.includes("previous plugin session is inactive")));
  });
}

test("closing during an already-dispatched envelope preserves its key without starting another session", async (t) => {
  const result = await claimant(t, ({ sealed, modal }) => {
    modal.onClose();
    return { outcome: "ok", value: sealed };
  });
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 0);
  assert.deepEqual(result.calls, ["claim", "envelope"]);
});
