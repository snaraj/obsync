/**
 * A file too large for one version is refused before any chunk is sent
 * (issue #330).
 *
 * One version's encrypted manifest -- path, size and chunk list -- is at most
 * `MANIFEST_CT_MAX` base64 characters on the server, about 4,850 chunks. The
 * push used to upload every chunk of a larger file, hours of it, and only the
 * version post was refused. It now measures the manifest first: by size when
 * the size decides, by the file's cut points when the content does.
 *
 * The cut-point cases lower the ceiling for a 40 MiB fixture: the band where
 * content decides starts near 4.7 GiB at the real one, which no unit test
 * reads. The arithmetic is the same at every ceiling.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const push = require("../build/sync/push.js");
const { bytesSource, chunkLengths } = require("../build/chunker.js");
const { SyncEngine } = require("../build/sync/engine.js");

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** Deterministic incompressible-looking bytes: a fixture, never a secret. */
function noise(size, seed = 0x2330a5) {
  const data = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    data[i] = x & 0xff;
  }
  return data;
}

/** Every chunk request and version post the device made. */
const uploads = (server) => server.requests.filter((request) => request.target.startsWith("/v1/chunks") || /\/versions$/.test(request.target));

/** How many times the push opened a read of `path`. */
function reads(host, path) {
  const opened = { count: 0 };
  const source = host.source.bind(host);
  host.source = (at, size) => {
    if (at === path) opened.count++;
    return source(at, size);
  };
  return opened;
}

/** The ceiling the arithmetic is measured against, for one test. */
function ceiling(t, value) {
  const real = push.MANIFEST_CT_MAX;
  push.MANIFEST_CT_MAX = value;
  t.after(() => { push.MANIFEST_CT_MAX = real; });
}

const verdict = (host) => host.logs.filter((line) => line.includes("reason=manifest_ceiling"));

test("a file the size alone puts over the ceiling is refused with no request and no read (#330)", async () => {
  const r = await rig();
  r.host.seed("Archive.bin", "placeholder\n", 1000);
  const stat = r.host.stat.bind(r.host);
  r.host.stat = async (path) => path === "Archive.bin" ? { path, mtime: 1000, size: 40 * GiB } : stat(path);
  const opened = reads(r.host, "Archive.bin");
  await assert.rejects(push.pushFile(r.context, "Archive.bin"), push.TooLarge);
  assert.deepEqual(uploads(r.server), [], "a request left the device for a refused file");
  assert.equal(opened.count, 0, "the size alone decides, and nothing was read");
  // The fewest chunks 40 GiB can be, 8 MiB each, the last with one digit of length.
  const bare = JSON.stringify({ v: 1, path: "Archive.bin", size: 40 * GiB, mtime: 1000, domain: r.context.domainId, chunks: [], sha256: "", deleted: false, answer: true }).length;
  const least = 4 * Math.ceil((bare + 5120 * 162 - 1 - 6 + 16) / 3);
  assert.ok(least > push.MANIFEST_CT_MAX);
  assert.deepEqual(verdict(r.host).map((line) => line.replace(/duration_ms=\d+/, "duration_ms=")),
    [`push path_class=file decision=refused reason=manifest_ceiling bytes=${40 * GiB} chunks=5120 manifest_bytes=${least} budget=1048576 decided_by=size duration_ms=`]);
});

test("a large file the size alone clears is read once, as before, and says nothing of the ceiling", async () => {
  const r = await rig();
  r.host.seed("Video.bin", noise(20 * MiB), 1000);
  const opened = reads(r.host, "Video.bin");
  const outcome = await push.pushFile(r.context, "Video.bin");
  assert.equal(outcome.status, "pushed");
  assert.equal(opened.count, 1, "a file the size clears was read twice");
  assert.deepEqual(verdict(r.host), []);
});

test("between the bounds the cut points decide: exactly at the ceiling is sent, one chunk over is refused before any chunk (#330)", async (t) => {
  const r = await rig();
  const data = noise(40 * MiB);
  const lengths = await chunkLengths(bytesSource(data));
  // A second file of exactly one chunk more, the same bytes in front.
  let longer = null;
  for (let extra = 1; longer === null; extra++) {
    const candidate = new Uint8Array(data.length + extra * MiB);
    candidate.set(data);
    candidate.set(noise(extra * MiB, 0x77 + extra), data.length);
    if ((await chunkLengths(bytesSource(candidate))).length === lengths.length + 1) longer = candidate;
  }
  r.host.seed("One.bin", data, 1000);
  r.host.seed("Two.bin", longer, 1000);

  // A ceiling the size cannot decide for this file: the fewest chunks fit, the most do not.
  ceiling(t, 1500);
  const opened = reads(r.host, "One.bin");
  await assert.rejects(push.pushFile(r.context, "One.bin"), push.TooLarge);
  const [measured] = verdict(r.host);
  assert.match(measured, new RegExp(`decision=refused reason=manifest_ceiling bytes=${data.length} chunks=${lengths.length} manifest_bytes=\\d+ budget=1500 decided_by=cut_points`));
  const exact = Number(/manifest_bytes=(\d+)/.exec(measured)[1]);
  assert.ok(exact > 1500);
  // MEASURED EXACTLY, against the longest manifest those cut points make, built
  // here by JSON.stringify rather than by the push's arithmetic: every chunk
  // entry, the commas, `answer`, and the 16 bytes sealing adds, in base64.
  const longest = JSON.stringify({ v: 1, path: "One.bin", size: data.length, mtime: 1000, domain: r.context.domainId,
    chunks: lengths.map((len) => ({ sid: "0".repeat(64), cid: "0".repeat(64), len })), sha256: "", deleted: false, answer: true });
  assert.equal(exact, 4 * Math.ceil((new TextEncoder().encode(longest).length + 16) / 3), "the cut-point pass measured another manifest");
  assert.equal(opened.count, 1);
  assert.deepEqual(uploads(r.server), [], "a chunk left the device for a refused file");

  // AT EXACTLY THE CEILING it is sent, and what is posted is within the room measured for it.
  push.MANIFEST_CT_MAX = exact;
  r.host.seed("One.bin", data, 2000);
  const outcome = await push.pushFile(r.context, "One.bin");
  assert.equal(outcome.status, "pushed");
  const posted = r.server.requests.filter((request) => /\/versions$/.test(request.target)).map((request) => JSON.parse(request.json).manifest_ct.length);
  assert.equal(posted.length, 1);
  assert.ok(posted[0] <= exact && exact - posted[0] <= 16, `measured ${exact} for a manifest of ${posted[0]}`);

  // ONE CHUNK OVER, refused, and nothing of it sent.
  const before = uploads(r.server).length;
  await assert.rejects(push.pushFile(r.context, "Two.bin"), push.TooLarge);
  assert.equal(uploads(r.server).length, before, "a chunk of the larger file left the device");
  assert.match(verdict(r.host).at(-1), new RegExp(`decision=refused .* chunks=${lengths.length + 1} `));
  push.MANIFEST_CT_MAX = exact - 1;
  r.host.seed("One.bin", data, 3000);
  await assert.rejects(push.pushFile(r.context, "One.bin"), push.TooLarge, "one character over still sent");

  // ASKED AGAIN, the same file at the same size and time is not read again.
  const again = reads(r.host, "Two.bin");
  await assert.rejects(push.pushFile(r.context, "Two.bin"), push.TooLarge);
  assert.equal(again.count, 0, "the verdict was not kept");
});

test("the engine names a refused file once, with its size, keeps it in the status, and sends nothing (#330)", async (t) => {
  const r = await rig();
  r.host.seed("Archive.bin", "placeholder\n", 1000);
  const stat = r.host.stat.bind(r.host);
  r.host.stat = async (path) => path === "Archive.bin" ? { path, mtime: 1000, size: 40 * GiB } : stat(path);
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({ state: r.state, transport: r.transport, host: r.host, now: () => r.host.clock, timers, onStatus: (status) => statuses.push(status) });
  t.after(() => engine.stop());
  await engine.start();
  await engine.syncNow();
  await engine.syncNow();
  assert.deepEqual(uploads(r.server).filter((request) => !request.target.startsWith(`/v1/files/${r.context.mapFileId}`)), [], "a request left the device");
  const said = r.host.said.filter((notice) => notice.kind === "error");
  assert.equal(said.length, 1, r.host.notices.join(" | "));
  assert.deepEqual(r.host.notices.filter((text) => text.includes("Archive")),
    ["obsync: did not send \"Archive.bin\": at 40 GiB it is too large to sync, and none of it was sent. Move it out of the synced folders or split it into smaller files; Troubleshooting has more under \"A file is too large to sync\"."]);
  assert.deepEqual(engine.current(), { kind: "error", code: "too_large",
    message: "Did not send \"Archive.bin\": at 40 GiB it is too large to sync, and none of it was sent. Move it out of the synced folders or split it into smaller files; Troubleshooting has more under \"A file is too large to sync\"." });
});
