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

/**
 * A phone whose adapter keeps each file's size, and leaves the first `drops`
 * writes EMPTY, as Obsidian's `writeBinary` did on Android (live,
 * 2026-09-27): it resolved over 993 bytes and the file held none, for good.
 * `landing` is the size a save leaves when it lands right after a write;
 * `late` the size one leaves once the host has looked at the third empty
 * write, before the host hears the answer (review of e27eccb, finding 1).
 * `typing` opens the note in an editor that turns busy during the first
 * write (finding 2): text the file does not hold, a keystroke, a keystroke
 * that arrives while the editor is read (review of 90d2042, finding 3), or
 * one that arrives during the retry's last look at the file (review of
 * d62f201, finding 2).
 * `saved` is the size a save leaves when it lands while the host takes its
 * first look at the empty write (finding 1).
 */
async function dropping(t, drops, { existing = null, landing = null, late = null, typing = null, saved = null } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ObsidianHost } = box.require(join(box.home, "build", "main.js"));
  const { MarkdownView } = box.require("obsidian");
  const { state } = await fakeState(true);
  const files = new Map(existing === null ? [] : [["Notes/a.md", existing]]);
  const writes = [], removed = [], logs = [];
  let left = drops, emptyLooks = 0;
  const view = Object.assign(new MarkdownView(), {
    file: { path: "Notes/a.md" },
    getViewData: () => (typing === "unsaved" && writes.length > 0 ? "typed here\n" : ""),
  });
  const adapter = {
    stat: async (path) => {
      const found = files.has(path) ? { type: "file", ...files.get(path) } : null;
      if (late !== null && writes.length === 3 && found?.size === 0) queueMicrotask(() => files.set(path, { size: late, mtime: 5 }));
      if (saved !== null && writes.length === 1 && found?.size === 0) queueMicrotask(() => files.set(path, { size: saved, mtime: 5 }));
      if (typing === "during-stat" && writes.length === 1 && found?.size === 0 && ++emptyLooks === 2) {
        queueMicrotask(() => host.inputAt.set(view, { path, at: Date.now() }));
      }
      return found;
    },
    exists: async () => true,
    mkdir: async () => undefined,
    writeBinary: async (path, data, options) => {
      writes.push(data.byteLength);
      const size = left > 0 ? (left--, 0) : landing ?? data.byteLength;
      files.set(path, { size, mtime: options.mtime });
      if (typing === "keystroke") host.inputAt.set(view, { path, at: Date.now() });
    },
    remove: async (path) => { removed.push(path); files.delete(path); },
  };
  const plugin = {
    state,
    log: (line) => logs.push(line),
    app: {
      vault: { adapter, read: async () => {
        if (typing === "during-read" && writes.length === 1) queueMicrotask(() => host.inputAt.set(view, { path: "Notes/a.md", at: Date.now() }));
        return "";
      } },
      workspace: { getLeavesOfType: () => (typing === null ? [] : [{ view }]) },
    },
    manifest: { version: "1.1.4" },
  };
  const host = new ObsidianHost(plugin, null);
  return { host, writes, removed, logs, files };
}

const HELLO = new TextEncoder().encode("hello");

test("a phone writes a download again when the write left the file empty, and records it once it holds the bytes", async (t) => {
  const { host, writes, removed, logs } = await dropping(t, 1);
  const writer = await host.writer("Notes/a.md", 5);
  await writer.write(HELLO);
  assert.deepEqual(await writer.commit(1000), { path: "Notes/a.md", mtime: 1000, size: 5 });
  assert.deepEqual(writes, [5, 5], "written once more, with the same bytes");
  assert.deepEqual(removed, []);
  assert.ok(logs.some((line) => /^host path_class=file decision=written_again reason=empty_after_write attempt=1 bytes=5 found=5 budget_writes=3 duration_ms=\d+$/.test(line)), logs.join(" | "));
  assert.equal(logs.some((line) => line.includes("write_superseded")), false, "an empty write is not a save that landed");
});

test("a download a phone keeps leaving empty is refused as that file's, never recorded, and nothing is removed", async (t) => {
  // Nothing on a phone can remove the empty file without racing a save that
  // lands after the last look at it.
  for (const existing of [null, { size: 7, mtime: 1 }]) {
    const { host, writes, removed, logs, files } = await dropping(t, 99, { existing });
    const writer = await host.writer("Notes/a.md", 5);
    await writer.write(HELLO);
    await assert.rejects(writer.commit(1000), (error) => error.code === "write_dropped", `existing=${JSON.stringify(existing)}`);
    assert.deepEqual(writes, [5, 5, 5], "three writes, then no more");
    assert.deepEqual(removed, []);
    assert.equal(files.get("Notes/a.md")?.size, 0, "the platform's empty file stays at the name");
    assert.ok(logs.includes("host path_class=file decision=refused reason=write_dropped cause=budget writes=3 bytes=5 budget_writes=3"), logs.join(" | "));
  }
  // A save that lands while the phone looks at its third empty write is met
  // by the last look before the refusal: kept, and the write stands down.
  const { host, writes, removed, logs, files } = await dropping(t, 99, { late: 12 });
  const writer = await host.writer("Notes/a.md", 5);
  await writer.write(HELLO);
  assert.deepEqual(await writer.commit(1000), { path: "Notes/a.md", mtime: 1000, size: 5 });
  assert.deepEqual(writes, [5, 5, 5]);
  assert.deepEqual(removed, []);
  assert.equal(files.get("Notes/a.md").size, 12, "the late save was not kept");
  assert.ok(logs.includes("host path_class=file decision=write_superseded size=5 found=12"), logs.join(" | "));
});

test("a phone never writes a download again beneath an editor that became busy during the first write (#135)", async (t) => {
  for (const typing of ["unsaved", "keystroke", "during-read", "during-stat"]) {
    const { host, writes, logs } = await dropping(t, 99, { typing });
    const writer = await host.writer("Notes/a.md", 5);
    await writer.write(HELLO);
    await assert.rejects(writer.commit(1000), (error) => error.code === "write_dropped" && /editor is busy/.test(error.message), typing);
    assert.deepEqual(writes, [5], `${typing}: the first write only`);
    assert.ok(logs.includes("host path_class=file decision=refused reason=write_dropped cause=editor_busy writes=1 bytes=5 budget_writes=3"), logs.join(" | "));
  }
});

test("a save that lands while a phone looks at its empty write is kept, and no retry writes over it (review of 90d2042)", async (t) => {
  const { host, writes, files, logs } = await dropping(t, 99, { saved: 36 });
  const writer = await host.writer("Notes/a.md", 5);
  await writer.write(HELLO);
  assert.deepEqual(await writer.commit(1000), { path: "Notes/a.md", mtime: 1000, size: 5 });
  assert.deepEqual(writes, [5], "the first write only");
  assert.equal(files.get("Notes/a.md").size, 36, "the save was written over");
  assert.ok(logs.includes("host path_class=file decision=write_superseded size=5 found=36"), logs.join(" | "));
});

test("an empty download is written once, and a file holding other bytes is a save that landed, not written again", async (t) => {
  const empty = await dropping(t, 0);
  const none = await empty.host.writer("Notes/empty.md", 0);
  assert.deepEqual(await none.commit(1000), { path: "Notes/empty.md", mtime: 1000, size: 0 });
  assert.deepEqual(empty.writes, [0]);
  const saved = await dropping(t, 0, { landing: 9 });
  const writer = await saved.host.writer("Notes/a.md", 5);
  await writer.write(HELLO);
  assert.deepEqual(await writer.commit(1000), { path: "Notes/a.md", mtime: 1000, size: 5 });
  assert.deepEqual(saved.writes, [5]);
  assert.ok(saved.logs.includes("host path_class=file decision=write_superseded size=5 found=9"), saved.logs.join(" | "));
});

test("the test host holds a declared size in the phone's words, so a caller declaring the wrong one fails every suite (#197)", async (t) => {
  const { host } = await phone(t);
  const fake = new FakeHost();
  const phoneSaid = await refusals(host);
  assert.equal(phoneSaid.length, 2, "the phone refused both");
  assert.deepEqual(await refusals(fake), phoneSaid);
  assert.equal(fake.files.size, 0, "nothing reached the fake vault");
});
