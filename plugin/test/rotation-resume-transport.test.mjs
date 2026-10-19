import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const { Transport, ApiError } = createRequire(import.meta.url)("../build/transport.js");
const intent = { operation: "11".repeat(16), previous_map: "22".repeat(16), current_map: "33".repeat(16), target: null,
  recovery_verifier: "44".repeat(32), seal_suite: 2 };
const proof = { intent, resumeId: "55".repeat(16), verifier: intent.recovery_verifier, proof: "66".repeat(32), generation: intent.current_map };
const profile = { name: "Test coordinator", platform: "macos", app_version: "1.1.5" };
function fixture(answer) {
  const sent = [], transport = new Transport({ serverUrl: () => "https://sync.example.invalid", device: () => assert.fail("resume enrollment must be owner-authorized, not old device HMAC"),
    edgeHeaders: () => [{ name: "X-Service", value: "synthetic-edge" }], maxAttempts: 3, sleep: () => new Promise(() => {}), request: async request => {
      sent.push(request); if (answer instanceof Error) throw answer;
      return { status: answer.status, text: JSON.stringify(answer.value), headers: {}, arrayBuffer: new ArrayBuffer(0) };
    } }); return { transport, sent };
}

test("resume transport sends exact frozen intent/proof in one unsigned recover-only suite2 setup", async () => {
  const result = { device_id: "77".repeat(16), device_secret: "88".repeat(32), account_id: "99".repeat(16), recovered: true };
  const { transport, sent } = fixture({ status: 201, value: result });
  assert.deepEqual(await transport.setupRotationResume("synthetic-owner-token", profile, proof), { outcome: "ok", value: result });
  assert.equal(sent.length, 1); assert.equal(sent[0].url, "https://sync.example.invalid/v1/setup"); assert.equal(sent[0].method, "POST");
  assert.deepEqual(JSON.parse(sent[0].body), { setup_token: "synthetic-owner-token", account_name: profile.name, device: profile, seal_suite: 2,
    generation: intent.current_map, recover_only: true, recovery_verifier: intent.recovery_verifier, recovery_proof: proof.proof,
    rotation: { ...intent, resume_id: proof.resumeId } });
  assert.equal(sent[0].headers["X-Service"], "synthetic-edge");
  assert.equal(Object.keys(sent[0].headers).some(name => name.toLowerCase().startsWith("x-obsync-")), false);
});

test("resume transport malformed/broadened intent or binding refuses before any network", async () => {
  const { transport, sent } = fixture({ status: 201, value: {} });
  for (const patch of [{ resumeId: "BAD" }, { proof: "AF".repeat(32) }, { generation: intent.previous_map }, { verifier: "ab".repeat(32) },
    { intent: { ...intent, seal_suite: 1 } }, { intent: { ...intent, extra: true } }, { intent: { ...intent, current_map: intent.previous_map } }]) {
    await assert.rejects(async () => transport.setupRotationResume("synthetic-owner-token", profile, { ...proof, ...patch }));
    assert.deepEqual(sent, []);
  }
});

test("resume transport lost response stays one-shot and server refusal never changes enrollment mode", async () => {
  const lost = fixture(new Error("synthetic lost response"));
  assert.equal((await lost.transport.setupRotationResume("synthetic-owner-token", profile, proof)).outcome, "lost"); assert.equal(lost.sent.length, 1);
  for (const [status, code] of [[403, "bad_setup_token"], [409, "rotation_conflict"], [409, "resume_superseded"], [403, "bad_recovery_proof"]]) {
    const r = fixture({ status, value: { error: code, detail: "synthetic refusal" } });
    await assert.rejects(r.transport.setupRotationResume("synthetic-owner-token", profile, proof), error => error instanceof ApiError && error.status === status && error.code === code);
    assert.equal(r.sent.length, 1); assert.equal(JSON.parse(r.sent[0].body).recover_only, true);
  }
});
