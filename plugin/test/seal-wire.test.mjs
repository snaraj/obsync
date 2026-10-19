import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readManifestSeal2, readPairingSeal2, SealWireError } = require("../build/sealWire.js");
const b64 = n => Buffer.alloc(n, 0x23).toString("base64");
const cases = [
  ["manifest", readManifestSeal2, "manifest_ct", "manifest_nonce", 1 << 20],
  ["root", value => readPairingSeal2(value, "root"), "envelope", "nonce", 8192],
  ["details", value => readPairingSeal2(value, "details"), "envelope", "nonce", 2048],
];
for (const [name, read, field, nonce, cap] of cases) {
  const good = () => ({ seal_suite: 2, [field]: b64(17) });
  test(`${name}: literal suite2 and canonical packet boundaries`, () => {
    for (const n of [16, 17, cap / 4 * 3]) {
      const record = { seal_suite: 2, [field]: b64(n) };
      assert.deepEqual(read(record), new Uint8Array(n).fill(0x23));
      assert.deepEqual(record, { seal_suite: 2, [field]: b64(n) }, "read never rewrites input");
    }
    for (const n of [0, 1, 15, cap / 4 * 3 + 1]) {
      assert.throws(() => read({ seal_suite: 2, [field]: b64(n) }), SealWireError, `reject byte boundary ${n}`);
    }
  });
  test(`${name}: legacy, unknown, stripped and mixed variants refuse`, () => {
    for (const suite of [undefined, null, false, true, 1, 3, "2", {}, []]) {
      assert.throws(() => read({ ...good(), seal_suite: suite }), SealWireError, "require numeric suite2");
    }
    const missing = good(); delete missing.seal_suite;
    assert.throws(() => read(missing), SealWireError, "stripped suite refused");
    assert.throws(() => read(Object.assign([], good())), SealWireError, "array is not a sealed object");
    assert.throws(() => read(Object.assign(() => {}, good())), SealWireError, "callable is not a sealed object");
    for (const oldNonce of [undefined, null, "", "ab".repeat(12)]) {
      assert.throws(() => read({ ...good(), [nonce]: oldNonce }), SealWireError, "nonce presence refused");
    }
    assert.throws(() => read(Object.assign(Object.create({ seal_suite: 2 }), { [field]: b64(17) })), SealWireError, "own suite required");
    assert.throws(() => read(Object.assign(Object.create({ [field]: b64(17) }), { seal_suite: 2 })), SealWireError, "own packet required");
    assert.throws(() => read(Object.assign(Object.create({ [nonce]: undefined }), good())), SealWireError, "inherited nonce refused");
  });
  test(`${name}: malformed inputs never escape their fixed refusal`, () => {
    const valid = b64(16);
    for (const text of [undefined, null, 2, {}, [], valid.slice(0, -2), valid + "=", " " + valid,
      "!".repeat(24), valid.slice(0, -3) + "x=="]) {
      assert.throws(() => read({ seal_suite: 2, [field]: text }), error =>
        error instanceof SealWireError && error.message === "sealed record refused" && error.cause === undefined,
      "malformed framing is a fixed refusal");
    }
    for (const value of [null, undefined, [], 2, "synthetic hostile text"]) {
      assert.throws(() => read(value), SealWireError, "reject non-record");
    }
    const objectText = Object.defineProperty({}, "length", { get() { throw new Error("synthetic getter detail"); } });
    assert.throws(() => read({ seal_suite: 2, [field]: objectText }), SealWireError, "reject non-text before reading its properties");
    // This padding edit is another canonical packet, not malformed framing.
    // Authentication belongs to SIV; the wire parser makes no tag claim.
    assert.equal(read({ seal_suite: 2, [field]: valid.replace("==", "A=") }).length, 17);
  });
}
test("pairing budgets are an explicit closed choice", () => {
  const packet = { seal_suite: 2, envelope: b64(2048) };
  assert.equal(readPairingSeal2(packet, "root").length, 2048);
  assert.throws(() => readPairingSeal2(packet, "details"), SealWireError);
  for (const kind of [undefined, null, false, "legacy", 2]) {
    assert.throws(() => readPairingSeal2({ seal_suite: 2, envelope: b64(16) }, kind), SealWireError);
  }
});
