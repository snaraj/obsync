/**
 * The phone's writer holds ONE buffer, of the file's size (issue #197).
 *
 * A download on a phone is written with the adapter's single `writeBinary`,
 * so the whole file is in memory at the end. It was held twice: every part,
 * then a joined copy of all of them -- 1 GiB for a 512 MiB download, the
 * documented mobile ceiling, which is enough to end the app. The writer now
 * copies each part into one buffer of the declared size as it arrives.
 *
 * PLATFORM. Mobile only; the desktop writer streams to a temp file and is
 * covered by `nativehost.test.mjs`. These drive the real `ObsidianHost` with
 * no filesystem seam, which is what a phone is.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { FakeHost, fakeState, sandbox } from "./fake.mjs";

async function phone(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { state } = await fakeState(true);
  const written = [];
  const adapter = {
    stat: async () => null,
    exists: async () => true,
    mkdir: async () => undefined,
    writeBinary: async (path, data, options) => { written.push({ path, data, mtime: options?.mtime }); },
  };
  const plugin = {
    state,
    log: () => undefined,
    app: { vault: { adapter }, workspace: { getLeavesOfType: () => [] } },
    manifest: { version: "1.1.4" },
  };
  return { host: new ObsidianHost(plugin, null), written };
}

/** Every `Uint8Array` of at least `bytes` made while `work` runs, by length. */
async function allocations(bytes, work) {
  const Real = globalThis.Uint8Array;
  const made = [];
  globalThis.Uint8Array = new Proxy(Real, {
    construct(target, args, newTarget) {
      if (typeof args[0] === "number" && args[0] >= bytes) made.push(args[0]);
      return Reflect.construct(target, args, newTarget === globalThis.Uint8Array ? target : newTarget);
    },
  });
  try { await work(); } finally { globalThis.Uint8Array = Real; }
  return made;
}

test("a phone writes a download into one buffer of its size, each part copied in as it arrives", async (t) => {
  const { host, written } = await phone(t);
  const PART = 1 << 20;
  const size = 4 * PART + 123;
  const expected = new Uint8Array(size);
  for (let i = 0; i < size; i++) expected[i] = (i * 31 + 7) & 0xff;
  const made = await allocations(PART, async () => {
    const writer = await host.writer("Files/big.bin", size);
    for (let at = 0; at < size; at += PART) {
      const part = expected.slice(at, Math.min(size, at + PART));
      await writer.write(part);
      // The caller's buffer is its own again the moment `write` returns: a
      // writer that kept it, to join later, would commit these zeros.
      part.fill(0);
    }
    assert.deepEqual(await writer.commit(1000), { path: "Files/big.bin", mtime: 1000, size });
  });
  assert.deepEqual(made, [size], "exactly one buffer of the file's size, and no joined copy");
  assert.equal(written.length, 1);
  assert.equal(written[0].data.byteLength, size, "the one buffer is what the adapter was handed");
  // Compared as one boolean: a 4 MiB diff would be the failure's message.
  assert.ok(Buffer.from(written[0].data).equals(Buffer.from(expected.buffer)), "every part landed in place, as it was when written");
});

test("a phone's download past its declared size, or short of it, is refused and never written", async (t) => {
  const { host, written } = await phone(t);
  const over = await host.writer("Files/over.bin", 4);
  await over.write(Uint8Array.from([1, 2, 3]));
  await assert.rejects(over.write(Uint8Array.from([4, 5])), /exceeded its declared size/);
  const short = await host.writer("Files/short.bin", 4);
  await short.write(Uint8Array.from([1, 2, 3]));
  await assert.rejects(short.commit(1000), /short of its declared size/);
  assert.deepEqual(written, [], "nothing reached the vault");
});

/** What a writer says to a part past its declared size and to a commit short of it. */
async function refusals(host) {
  const said = [];
  const over = await host.writer("Files/over.bin", 4);
  await over.write(Uint8Array.from([1, 2, 3]));
  await over.write(Uint8Array.from([4, 5])).catch((error) => said.push(error.message));
  const short = await host.writer("Files/short.bin", 4);
  await short.write(Uint8Array.from([1, 2, 3]));
  await short.commit(1000).catch((error) => said.push(error.message));
  return said;
}

test("the test host holds a declared size in the phone's words, so a caller declaring the wrong one fails every suite (#197)", async (t) => {
  const { host } = await phone(t);
  const fake = new FakeHost();
  const phoneSaid = await refusals(host);
  assert.equal(phoneSaid.length, 2, "the phone refused both");
  assert.deepEqual(await refusals(fake), phoneSaid);
  assert.equal(fake.files.size, 0, "nothing reached the fake vault");
});
