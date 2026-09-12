/** Exercise the actual claimant dialog method with a non-rendering Obsidian stub. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { KEYS, sandbox } from "./fake.mjs";

async function claimant(t, response, onWait = () => {}) {
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
  const plugin = {
    state: { data: { vrk: null }, save: async () => saves.push({ ...plugin.state.data }) },
    manifest: { version: "0.1.15" }, deviceName: () => "Tablet", platformName: () => "ios",
    log: (line) => logs.push(line), restartEngine: async () => { restarted++; },
    transport: {
      pairingClaim: async (pairingId, enrollToken) => {
        assert.equal(pairingId, id); assert.equal(enrollToken, token);
        calls.push("claim");
        return { outcome: "ok", value: { device_id: KEYS.deviceId, device_secret: KEYS.deviceSecret } };
      },
      pairingStatus: async () => { calls.push("creator-status"); throw new Error("creator-only route"); },
      pairingEnvelope: async (pairingId) => {
        assert.equal(pairingId, id); calls.push("envelope");
        return response({ ApiError, sealed, attempt: calls.filter((call) => call === "envelope").length });
      },
    },
  };
  const modal = new PairClaimModal({}, plugin, pairing.encodePairingCode(id, token, secret));
  modal.contentEl = { createEl: () => ({}), empty: () => {} };
  modal.close = () => modal.onClose();
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (resolve, delay) => {
    assert.equal(delay, 2000);
    assert.ok(++waits <= 3, "terminal outcomes must not poll indefinitely");
    onWait(modal, waits); resolve();
  } };
  t.after(() => { globalThis.window = previousWindow; });
  await modal.claim();
  return { calls, saves, logs, notices, restarted, state: plugin.state.data };
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
