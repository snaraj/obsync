/**
 * The growing-file guard and the end-of-read invariant (issue #99).
 *
 * A 916 MB video copied into a real vault was published at 376 MB. The
 * guard's doc comment said the file was stat-ed twice `RECHECK_MS` apart; the
 * code stat-ed it twice in the SAME turn and re-armed a timer in between, so
 * the two observations were microseconds apart and a file growing at a
 * gigabyte a minute looked perfectly still. These tests pin both halves of
 * the fix: the gap between the two stats, and the size check at the end of
 * the read that catches a copy which stalls for longer than one recheck.
 *
 * PLATFORM. The guard and the invariant are engine and push code, identical
 * on desktop and mobile, so the slice test runs on both hosts; what differs
 * is only how the host reads (`main.ts`), and the fake host models the
 * whole-file mobile read.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine, QUIET_MS, RECHECK_MS } = require("../build/sync/engine.js");
const { pushFile } = require("../build/sync/push.js");
const c = require("../build/crypto.js");

const enc = (text) => new TextEncoder().encode(text);

function engineOf({ host, server, state }, timers) {
  return new SyncEngine({
    state,
    transport: new Transport({
      request: server.request,
      serverUrl: () => state.data.serverUrl,
      device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
      edgeHeaders: () => [],
      now: () => host.clock,
      sleep: async () => undefined,
      maxAttempts: 2,
      log: (line) => host.logs.push(line),
    }),
    host,
    now: () => host.clock,
    timers,
  });
}

/** Every version the server holds for the one vault file, newest first. */
function versionsOf(server) {
  const ids = server.vaultFiles();
  assert.ok(ids.length <= 1, `the test vault holds one file (${ids.length})`);
  return ids.length === 0 ? [] : server.files.get(ids[0]).versions;
}

/**
 * A copy landing `slices` blocks, one every `PAUSE_MS` of virtual time. The
 * pause is longer than `RECHECK_MS` on purpose: that is exactly the shape the
 * old guard could not see, because each pair of stats fell inside one pause.
 */
const PAUSE_MS = 600;

function copyInSlices(host, timers, path, slices, sliceBytes = 1024, mtime = 3000) {
  host.seed(path, new Uint8Array(0), mtime);
  let landed = 0;
  const grow = () => {
    const file = host.files.get(path);
    const next = new Uint8Array(file.bytes.length + sliceBytes);
    next.set(file.bytes);
    next.fill(0x41 + landed, file.bytes.length);
    host.files.set(path, { bytes: next, mtime });
    landed++;
    if (landed < slices) timers.set(grow, PAUSE_MS);
  };
  timers.set(grow, PAUSE_MS);
  return { finished: () => landed === slices, size: () => slices * sliceBytes };
}

for (const isMobile of [false, true]) {
  test(`a file still being copied is never published mid-copy (${isMobile ? "mobile" : "desktop"} host)`, async () => {
    assert.ok(PAUSE_MS > RECHECK_MS, "the copy must pause for longer than one recheck");
    assert.ok(PAUSE_MS < QUIET_MS, "and for less than the quiet window the guard requires");
    const rigged = await rig({ isMobile });
    const { host, server, state } = rigged;
    const timers = new FakeTimers();
    const engine = engineOf(rigged, timers);
    await engine.start();

    const copy = copyInSlices(host, timers, "Media/Clip.bin", 6);
    engine.changed("Media/Clip.bin");
    await timers.run(100, () => state.fileByPath("Media/Clip.bin") !== undefined);
    engine.stop();

    assert.equal(copy.finished(), true, "the copy finished before anything was published");
    const versions = versionsOf(server);
    assert.equal(versions.length, 1, "exactly one version, never an intermediate one");
    assert.equal(versions[0].bytes, copy.size(), "the version carries the finished file");
    assert.equal(state.fileByPath("Media/Clip.bin").size, copy.size());
    // And the bytes the server holds really are the finished file's.
    const held = versions[0].sids.reduce((total, sid) => total + server.chunks.get(sid).length, 0);
    assert.ok(held >= copy.size(), "every chunk of the finished file was uploaded");
  });
}

test("a push whose file grows while it is read publishes nothing and says both sizes", async () => {
  const { host, server, state, context } = await rig();
  host.seed("Copy.bin", "aaaa", 1000);
  const realRead = host.read.bind(host);
  // The copy lands four more bytes while this read is in flight: the shape
  // the two-stat guard cannot see, because it agreed before the read began.
  host.read = async (path) => {
    const bytes = await realRead(path);
    host.seed(path, new Uint8Array([...bytes, ...enc("bbbb")]), 1000);
    return bytes;
  };

  const outcome = await pushFile(context, "Copy.bin");
  assert.equal(outcome.status, "growing");
  assert.equal(outcome.versionId, "");
  assert.equal(server.vaultFiles().length, 0, "no version exists for a file that moved");
  assert.equal(state.fileByPath("Copy.bin"), undefined, "and no record claims one does");

  const line = host.logs.find((entry) => entry.includes("decision=abandoned"));
  assert.ok(line, `the abandoned push is logged: ${host.logs.join(" | ")}`);
  assert.match(line, /reason=changed_during_read/);
  assert.match(line, /(^| )bytes=4( |$)/, "the size the read started from");
  assert.match(line, /(^| )bytes_after=8( |$)/, "the size it ended at");
  assert.match(line, /duration_ms=\d+/);
});

test("a file that vanishes during the read is abandoned rather than published", async () => {
  const { host, server, context } = await rig();
  host.seed("Gone.bin", "aaaa", 1000);
  const realRead = host.read.bind(host);
  host.read = async (path) => {
    const bytes = await realRead(path);
    host.files.delete(path);
    return bytes;
  };
  const outcome = await pushFile(context, "Gone.bin");
  assert.equal(outcome.status, "growing");
  assert.equal(server.vaultFiles().length, 0);
  assert.ok(host.logs.some((line) => line.includes("bytes_after=-1")));
});

test("an abandoned push re-arms the debounce and the finished file is published whole", async () => {
  const rigged = await rig();
  const { host, server, state } = rigged;
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  await engine.start();

  host.seed("Late.bin", "aaaa", 1000);
  let grown = false;
  const realRead = host.read.bind(host);
  host.read = async (path) => {
    const bytes = await realRead(path);
    if (!grown && path === "Late.bin") {
      grown = true;
      host.seed(path, new Uint8Array([...bytes, ...enc("bbbb")]), 1000);
    }
    return bytes;
  };

  engine.changed("Late.bin");
  await timers.run(100, () => state.fileByPath("Late.bin") !== undefined);
  engine.stop();

  assert.equal(grown, true, "the first read really did race the copy");
  const versions = versionsOf(server);
  assert.equal(versions.length, 1, "the abandoned attempt posted nothing");
  assert.equal(versions[0].bytes, 8, "the version carries the finished file");
  assert.equal(state.fileByPath("Late.bin").size, 8);
});

test("a rename abandoned mid-read still publishes as a rename, not as new content", async () => {
  const rigged = await rig();
  const { host, server, state, keys: k } = rigged;
  const timers = new FakeTimers();
  const engine = engineOf(rigged, timers);
  host.seed("Notes/Old.md", "stable bytes", 1000);
  await engine.start();
  await timers.run(100, () => state.fileByPath("Notes/Old.md") !== undefined);
  const fileId = state.fileByPath("Notes/Old.md").fileId;

  // The bytes do not change, so only the forced rename push can post a
  // version; abandoning it must not silently drop the force.
  host.files.set("Notes/New.md", host.files.get("Notes/Old.md"));
  host.files.delete("Notes/Old.md");
  let raced = false;
  const realStat = host.stat.bind(host);
  host.stat = async (path) => {
    const stat = await realStat(path);
    if (!raced && path === "Notes/New.md" && stat !== null) {
      raced = true;
      return { ...stat, size: stat.size + 1 };
    }
    return stat;
  };
  engine.renamed("Notes/Old.md", "Notes/New.md");
  // `renamed` records the new path immediately with `mtime: -1`; the push is
  // what replaces it, so that is what the wait is for.
  await timers.run(100, () => (state.fileByPath("Notes/New.md")?.mtime ?? -1) !== -1);
  engine.stop();

  assert.equal(raced, true, "the abandon path really ran");
  assert.equal(state.fileByPath("Notes/New.md").fileId, fileId, "the same file id moved");
  const paths = [];
  for (const frame of server.journal) {
    const binder = await c.contentVersionId(frame.file_id, frame.parents, frame.sids);
    paths.push(JSON.parse(await c.decryptManifest(
      k.manifestKey, frame.file_id, binder,
      Uint8Array.from(Buffer.from(frame.manifest_nonce, "hex")), c.unbase64(frame.manifest_ct),
    )).path);
  }
  assert.ok(paths.includes("Notes/New.md"), `the new name was published: ${paths.join(", ")}`);
});
