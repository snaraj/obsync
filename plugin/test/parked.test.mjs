/**
 * One note this device cannot write must not stop it receiving everything
 * else (issue #144).
 *
 * THE DEFECT. A write refused by THIS device's filesystem -- a note locked in
 * Finder (EPERM at the rename), a read-only folder (EACCES at the temp file),
 * a full disk (ENOSPC mid-write) -- or a chunk the server quarantined while
 * every device holding it was closed (404 `unknown_chunk`) was rethrown out of
 * the pull path, and the feed retried the SAME record every five seconds
 * without moving its cursor: nothing behind it arrived, not an edit, not a new
 * note, not a deletion, in any folder, and the status bar blamed the network
 * or read `idle`. A full disk re-downloaded the whole file on every attempt.
 *
 * WHAT IS PINNED. Such a record is PARKED, by file id, in the persisted state;
 * the cursor moves on and every other change keeps arriving. The status and
 * one notice name the file and the reason in plain words. The parked file is
 * retried on a slow schedule (never a tight re-download loop), at once on
 * Sync now and at the next start, and applies once the cause clears -- across
 * a restart too. A later version of it that applies releases it. A network
 * failure is not a per-record failure and keeps its own handling.
 *
 * WHAT IS AND IS NOT EXERCISED. The real engine, pull path, transport signing
 * and state persistence, against the hand-written vault and server in
 * `fake.mjs`; the host's writer throws exactly what Node's `fs` throws (an
 * Error carrying its errno `code`). `ObsidianHost`'s own writer and a real
 * disk stay a real-device acceptance run (`docs/validation.md`).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { FakeTimers, KEYS, rig, sandbox } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { Transport } = require("../build/transport.js");
const { SyncEngine } = require("../build/sync/engine.js");
const { parseData } = require("../build/state.js");
const { Unwritable, applyChange, unwritableText } = require("../build/sync/pull.js");
const { CHUNK_MAX, CHUNK_MIN } = require("../build/chunker.js");

const enc = (text) => new TextEncoder().encode(text);
const MINUTE = 60 * 1000;

const N17 = "17".repeat(16);
const N18 = "18".repeat(16);
const NEW1 = "01".repeat(16);
const B3 = "b3".repeat(16);
const N19 = "19".repeat(16);
const BIG = "b1".repeat(16);
const N03 = "03".repeat(16);
const AFTER = "af".repeat(16);
const VICTIM = "0c".repeat(16);

/** One device, its engine, and every status it reported. */
function device(r, { request } = {}) {
  const timers = new FakeTimers();
  const statuses = [];
  const engine = new SyncEngine({
    state: r.state,
    transport: new Transport({
      request: request ?? r.server.request,
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
    onStatus: (status) => statuses.push(status),
  });
  return { engine, timers, statuses, last: () => statuses[statuses.length - 1] };
}

/** A version another device published, as the feed will deliver it. */
const foreign = (r, fileId, path, text, parents = []) => r.server.publish({
  fileId, path, bytes: enc(text), mtime: 1757200001000, parents,
  domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
});

/**
 * Make this vault refuse writes the way Node's `fs` does: an Error carrying
 * its errno `code`, at the stage the real writer meets it -- `open` for the
 * temp file in a read-only folder, `write` for a full disk, `commit` for the
 * rename over a locked note. Every attempt is counted.
 */
function refuse(host, matches, code, stage) {
  const real = host.writer.bind(host);
  const attempts = [];
  const failure = () => Object.assign(new Error(`${code}: sentinel refusal`), { code });
  host.writer = async (path) => {
    if (!matches(path)) return real(path);
    attempts.push(path);
    if (stage === "open") throw failure();
    const writer = await real(path);
    if (stage === "write") return { ...writer, write: async () => { throw failure(); } };
    return { ...writer, commit: async () => { throw failure(); } };
  };
  return { attempts, lift: () => { host.writer = real; } };
}

/** How many times the chunk this frame names was fetched. */
const fetches = (r, frame) => r.server.requests.filter((request) => request.target === `/v1/chunks/${frame.sids[0]}`).length;

const notices = (r, path) => r.host.notices.filter((notice) => notice.includes(path));

test("a locked note is parked: every later change arrives, and the status names the file, never offline", async (t) => {
  const r = await rig();
  const d = device(r);
  t.after(() => d.engine.stop());
  const n17 = await foreign(r, N17, "Notes/n17.md", "n17 as both devices first had it\n");
  const n18 = await foreign(r, N18, "Notes/n18.md", "n18 as both devices first had it\n");
  await d.engine.start();
  await d.timers.run(1000, () => r.host.text("Notes/n18.md") !== null);

  // `chflags uchg`: the rename over the note is refused, EPERM.
  const lock = refuse(r.host, (path) => path === "Notes/n17.md", "EPERM", "commit");
  await foreign(r, N17, "Notes/n17.md", "n17 edited on the other device\n", [n17.version_id]);
  await foreign(r, N18, "Notes/n18.md", "n18 edited on the other device\n", [n18.version_id]);
  const newest = await foreign(r, NEW1, "Notes/new1.md", "a note made after the locked one\n");
  await d.timers.run(1000, () => r.host.text("Notes/new1.md") !== null && r.state.data.lastSeq === newest.seq);

  assert.equal(r.host.text("Notes/n18.md"), "n18 edited on the other device\n", "the edit behind the locked note arrived");
  assert.equal(r.host.text("Notes/new1.md"), "a note made after the locked one\n", "the new note behind it arrived");
  assert.equal(r.host.text("Notes/n17.md"), "n17 as both devices first had it\n", "nothing was written over the locked note");
  assert.equal(r.state.data.lastSeq, newest.seq, "the feed cursor moved past the parked record");
  assert.deepEqual(r.state.data.parked, { [N17]: { path: "Notes/n17.md", reason: "EPERM" } });
  assert.deepEqual(d.last(), { kind: "error", message: "Cannot write Notes/n17.md here: the file is locked" });
  assert.equal(d.statuses.some((status) => status.kind === "offline"), false, "a local refusal is not the network");
  assert.equal(notices(r, "Notes/n17.md").length, 1, "one notice names the file");
  assert.match(notices(r, "Notes/n17.md")[0], /the file is locked/);
  assert.ok(
    r.host.logs.some((line) => line === `feed decision=parked reason=EPERM file=${N17} parked=1 retry_ms=60000`),
    "the park is one structured line with its reason and its retry budget",
  );
  assert.equal(r.host.logs.some((line) => line.includes("n17")), false, "no log line carries the note's name");
  // From here until the note lands, NOTHING may say `idle`: not a push's
  // drain, not a feed page, not Sync now (S74 read `idle` in 24 of 62 samples).
  const parkedFrom = d.statuses.length;

  // A push drains to the parked status, not to `idle` (the S74 flicker).
  r.host.seed("Mine.md", "typed here meanwhile\n", 5000);
  d.engine.changed("Mine.md");
  await d.timers.run(100, () => r.state.fileByPath("Mine.md") !== undefined && d.last().kind !== "syncing");
  assert.deepEqual(d.last(), { kind: "error", message: "Cannot write Notes/n17.md here: the file is locked" });

  // Another version of the same note while it is still locked, and a Sync
  // now that retries it at once: still one parked entry and still one notice.
  const third = await foreign(r, N17, "Notes/n17.md", "n17 edited again on the other device\n", [r.server.files.get(N17).heads[0]]);
  await d.timers.run(100, () => r.state.data.lastSeq === third.seq);
  const before = lock.attempts.length;
  await d.engine.syncNow();
  assert.ok(lock.attempts.length > before, "Sync now tried the parked note at once");
  assert.deepEqual(Object.keys(r.state.data.parked), [N17]);
  assert.equal(notices(r, "Notes/n17.md").length, 1, "a retry is not a new notice");
  assert.deepEqual(d.last(), { kind: "error", message: "Cannot write Notes/n17.md here: the file is locked" });

  assert.deepEqual(
    d.statuses.slice(parkedFrom).filter((status) => status.kind === "idle"),
    [],
    "the status bar never read idle while the note was parked",
  );

  // `chflags nouchg`: the next slow retry applies the newest version.
  lock.lift();
  // The pass's summary line is written after its save and right before the
  // status: waiting on the file alone would read both a step too early.
  const retried = (trigger) => () => r.host.logs.some((line) => line.startsWith(`feed decision=retried trigger=${trigger} released=1 `));
  await d.timers.run(10000, retried("timer"));
  assert.equal(r.host.text("Notes/n17.md"), "n17 edited again on the other device\n");
  assert.deepEqual(r.state.data.parked, {}, "applied, so released");
  assert.deepEqual(d.last(), { kind: "idle" }, "and the status clears by itself");
  assert.deepEqual(
    r.host.logs.filter((line) => line.startsWith("feed decision=released")),
    [`feed decision=released file=${N17} parked=0`],
    "only the parked file is released; the notes that simply applied are not asked about again",
  );
  assert.equal(notices(r, "Notes/n17.md").length, 1);

  // Locked again later: a new episode, with its own notice, starting over at
  // one minute rather than where the last one's backoff had got to.
  refuse(r.host, (path) => path === "Notes/n17.md", "EPERM", "commit");
  const fourth = await foreign(r, N17, "Notes/n17.md", "n17 edited a third time\n", [third.version_id]);
  await d.timers.run(100, () => r.state.data.lastSeq === fourth.seq);
  assert.equal(
    r.host.logs.filter((line) => line.startsWith("feed decision=parked")).at(-1),
    `feed decision=parked reason=EPERM file=${N17} parked=1 retry_ms=60000`,
  );
  assert.equal(notices(r, "Notes/n17.md").length, 2);
});

test("a read-only folder parks only its own notes, and Sync now applies them once it is writable", async (t) => {
  const r = await rig();
  const d = device(r);
  t.after(() => d.engine.stop());
  await d.engine.start();
  await d.timers.run();

  // `chmod a-w Projects/Beta`: the temp file cannot be created, EACCES.
  const readOnly = refuse(r.host, (path) => path.startsWith("Projects/Beta/"), "EACCES", "open");
  await foreign(r, B3, "Projects/Beta/b3.md", "b3, made in the read-only folder\n");
  const n19 = await foreign(r, N19, "Notes/n19.md", "n19, in a folder that is fine\n");
  await d.timers.run(1000, () => r.host.text("Notes/n19.md") !== null && r.state.data.lastSeq === n19.seq);

  assert.equal(r.host.text("Projects/Beta/b3.md"), null);
  assert.deepEqual(r.state.data.parked, { [B3]: { path: "Projects/Beta/b3.md", reason: "EACCES" } });
  assert.deepEqual(d.last(), { kind: "error", message: "Cannot write Projects/Beta/b3.md here: the folder is read-only" });
  assert.equal(notices(r, "Projects/Beta/b3.md").length, 1);

  // Nothing is retried inside the first minute.
  const attempts = readOnly.attempts.length;
  await d.timers.run(1000);
  assert.equal(readOnly.attempts.length, attempts, "a parked record is not retried in a loop");

  readOnly.lift();
  await d.engine.syncNow();
  assert.equal(r.host.text("Projects/Beta/b3.md"), "b3, made in the read-only folder\n", "Sync now applied it at once");
  assert.deepEqual(r.state.data.parked, {});
  assert.deepEqual(d.last(), { kind: "idle" });
  assert.ok(r.host.logs.some((line) => /^feed decision=retried trigger=sync_now released=1 parked=0 retry_ms=\d+ duration_ms=\d+$/.test(line)));
  await d.engine.syncNow();
  assert.equal(r.host.logs.filter((line) => line.startsWith("feed decision=retried")).length, 1, "nothing parked, nothing to retry or log");
});

test("a full disk parks the big file without re-downloading it in a loop, and lets it go when it is deleted", async (t) => {
  const r = await rig();
  const d = device(r);
  t.after(() => d.engine.stop());
  const n03 = await foreign(r, N03, "Notes/n03.md", "n03 before\n");
  await d.engine.start();
  await d.timers.run(1000, () => r.host.text("Notes/n03.md") !== null);

  // The disk fills while the attachment is written, ENOSPC.
  const full = refuse(r.host, (path) => path === "Attachments/big.bin", "ENOSPC", "write");
  const big = await foreign(r, BIG, "Attachments/big.bin", "the attachment that does not fit\n");
  await foreign(r, N03, "Notes/n03.md", "n03 after\n", [n03.version_id]);
  const after = await foreign(r, AFTER, "Notes/after.md", "made after the attachment\n");
  await d.timers.run(1000, () => r.host.text("Notes/after.md") !== null && r.state.data.lastSeq === after.seq);

  assert.equal(r.host.text("Notes/n03.md"), "n03 after\n");
  assert.deepEqual(r.state.data.parked, { [BIG]: { path: "Attachments/big.bin", reason: "ENOSPC" } });
  assert.deepEqual(d.last(), { kind: "error", message: "Cannot write Attachments/big.bin here: the disk is full" });

  // Ten minutes of a disk that stays full: the file was fetched on the first
  // attempt and by the retries 1, 3 and 7 minutes after the park, and never
  // in a loop -- where the five-second loop fetched it 120 times.
  const parkedAt = d.timers.now;
  await d.timers.run(5000, () => d.timers.now >= parkedAt + 10 * MINUTE);
  assert.equal(fetches(r, big), 4, `the attachment was fetched ${fetches(r, big)} times in ten minutes`);
  assert.equal(full.attempts.length, 4);
  assert.equal(notices(r, "Attachments/big.bin").length, 1, "one notice, not one per retry");

  // The wait doubles and then holds at half an hour: retries 15, 31, 61, 91
  // and 121 minutes after the park, so a disk that stays full for two hours
  // costs nine downloads, and a file that fits again waits at most that long.
  await d.timers.run(5000, () => d.timers.now >= parkedAt + 125 * MINUTE);
  assert.equal(fetches(r, big), 9, `the attachment was fetched ${fetches(r, big)} times in two hours`);
  assert.ok(r.host.logs.some((line) => line.startsWith("feed decision=retried trigger=timer released=0 parked=1 retry_ms=1800000 ")));
  assert.equal(notices(r, "Attachments/big.bin").length, 1, "one notice, not one per retry");

  // The other device deletes it: the tombstone settles the parked record at once.
  await r.server.publishTombstone({ fileId: BIG, path: "Attachments/big.bin", manifestKey: r.keys.manifestKey, parents: [big.version_id] });
  await d.timers.run(100, () => Object.keys(r.state.data.parked).length === 0 && d.last().kind === "idle");
  assert.deepEqual(d.last(), { kind: "idle" });
  const settledAt = d.timers.now;
  await d.timers.run(5000, () => d.timers.now >= settledAt + 40 * MINUTE);
  assert.equal(fetches(r, big), 9, "nothing is fetched for a file that no longer exists");
  assert.equal(r.host.text("Attachments/big.bin"), null);
});

test("a chunk missing on the server parks its file, and it arrives once a device restores the chunk", async (t) => {
  const r = await rig();
  const d = device(r);
  t.after(() => d.engine.stop());
  await d.engine.start();
  await d.timers.run();

  const victim = await foreign(r, VICTIM, "Attachments/victim2.bin", "the file whose chunk was quarantined\n");
  const held = r.server.chunks.get(victim.sids[0]);
  r.server.chunks.delete(victim.sids[0]);
  const behind = [];
  for (const n of [1, 2, 3]) behind.push(await foreign(r, `a${n}`.repeat(16), `Notes/after-victim-${n}.md`, `after the victim ${n}\n`));
  await d.timers.run(1000, () => r.state.data.lastSeq === behind[2].seq && r.host.text("Notes/after-victim-3.md") !== null);

  for (const n of [1, 2, 3]) assert.equal(r.host.text(`Notes/after-victim-${n}.md`), `after the victim ${n}\n`);
  assert.deepEqual(r.state.data.parked, { [VICTIM]: { path: "Attachments/victim2.bin", reason: "unknown_chunk" } });
  assert.deepEqual(d.last(), {
    kind: "error",
    message: "Cannot write Attachments/victim2.bin here: the server is missing part of it; open a device that has it",
  });
  assert.equal(d.statuses.some((status) => status.kind === "offline"), false);

  // A holder comes online and repairs the chunk; the next retry applies it.
  r.server.chunks.set(victim.sids[0], held);
  await d.timers.run(5000, () => r.host.logs.some((line) => line.startsWith("feed decision=retried trigger=timer released=1 ")));
  assert.equal(r.host.text("Attachments/victim2.bin"), "the file whose chunk was quarantined\n");
  assert.deepEqual(r.state.data.parked, {});
  assert.ok(r.host.logs.some((line) => /^feed decision=retried trigger=timer released=1 parked=0 /.test(line)));
});

test("a parked record survives a restart and applies at the next start", async (t) => {
  const r = await rig();
  const d = device(r);
  const lock = refuse(r.host, (path) => path === "Notes/n17.md", "EPERM", "commit");
  await d.engine.start();
  const n17 = await foreign(r, N17, "Notes/n17.md", "n17 while locked\n");
  await d.timers.run(1000, () => r.saved()?.parked?.[N17] !== undefined && r.saved().lastSeq === n17.seq);
  d.engine.stop();
  r.server.releaseFeed();

  // The next start of the plugin, over what was written down.
  const state = await r.reload();
  assert.deepEqual(state.data.parked, { [N17]: { path: "Notes/n17.md", reason: "EPERM" } }, "the parked record was persisted");
  assert.equal(state.data.lastSeq, n17.seq);
  lock.lift();
  const again = device({ ...r, state });
  t.after(() => again.engine.stop());
  await again.engine.start();
  await again.timers.run(100, () => r.host.logs.some((line) => line.startsWith("feed decision=retried trigger=start released=1 ")));
  assert.ok(again.timers.now < MINUTE, "applied by the start itself, not by the slow timer");
  assert.equal(r.host.text("Notes/n17.md"), "n17 while locked\n");
  assert.deepEqual(state.data.parked, {});
  assert.deepEqual(r.saved().parked, {}, "and the release is written down");
  assert.ok(r.host.logs.some((line) => /^feed decision=retried trigger=start released=1 parked=0 /.test(line)));
});

test("several parked files: the status counts them, one pass retries them all, and a refusal about one does not hold up the rest", async (t) => {
  const r = await rig();
  const answers = new Map();
  const d = device(r, {
    request: async (request) => {
      const answer = answers.get(request.url.replace(/^https?:\/\/[^/]+/, ""));
      return answer === undefined ? r.server.request(request) : answer;
    },
  });
  t.after(() => d.engine.stop());
  await d.engine.start();
  await d.timers.run();

  const full = refuse(r.host, (path) => path.startsWith("Attachments/"), "ENOSPC", "write");
  const one = await foreign(r, BIG, "Attachments/one.bin", "the first attachment that does not fit\n");
  const two = await foreign(r, VICTIM, "Attachments/two.bin", "the second attachment that does not fit\n");
  await d.timers.run(1000, () => r.state.data.lastSeq === two.seq);
  assert.deepEqual(Object.keys(r.state.data.parked), [BIG, VICTIM]);
  assert.deepEqual(d.last(), {
    kind: "error",
    message: "Cannot write Attachments/two.bin here: the disk is full (and 1 more: Show sync status)",
  });
  assert.equal(notices(r, "Attachments/one.bin").length + notices(r, "Attachments/two.bin").length, 2, "one notice per file");

  // ONE schedule for the set: both files at 1, 3 and 7 minutes, never a
  // timer per park.
  const parkedAt = d.timers.now;
  await d.timers.run(5000, () => d.timers.now >= parkedAt + 10 * MINUTE);
  assert.equal(fetches(r, one) + fetches(r, two), 8, `fetched ${fetches(r, one)} + ${fetches(r, two)} times in ten minutes`);

  // The server out of reach: the pass stops at the first file and asks again later.
  const unreachable = { status: 503, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) };
  answers.set(`/v1/files/${BIG}`, unreachable);
  answers.set(`/v1/files/${VICTIM}`, unreachable);
  await d.engine.syncNow();
  assert.deepEqual(
    r.host.logs.filter((line) => line.startsWith("feed decision=deferred")),
    [`feed decision=deferred reason=http_503 file=${BIG} trigger=sync_now`],
  );
  assert.deepEqual(Object.keys(r.state.data.parked), [BIG, VICTIM], "nothing is released on an unanswered question");

  // A refusal about ONE file does not stop the pass: the other lands.
  answers.clear();
  answers.set(`/v1/files/${BIG}`, r.server.error(404, "unknown_file"));
  full.lift();
  await d.engine.syncNow();
  assert.ok(r.host.logs.includes(`feed decision=deferred reason=http_404 file=${BIG} trigger=sync_now`));
  assert.equal(r.host.text("Attachments/two.bin"), "the second attachment that does not fit\n");
  assert.deepEqual(r.state.data.parked, { [BIG]: { path: "Attachments/one.bin", reason: "ENOSPC" } }, "kept, never forgotten");
  assert.deepEqual(d.last(), { kind: "error", message: "Cannot write Attachments/one.bin here: the disk is full" });
});

test("a retry pass waits for the feed page in flight: the two never apply side by side", async (t) => {
  const r = await rig();
  const d = device(r);
  t.after(() => d.engine.stop());
  await d.engine.start();
  await d.timers.run();
  const lock = refuse(r.host, (path) => path === "Notes/n17.md", "EPERM", "commit");
  const n17 = await foreign(r, N17, "Notes/n17.md", "n17, parked and then unlocked\n");
  await d.timers.run(100, () => r.state.data.lastSeq === n17.seq);
  lock.lift();

  // The feed's next record blocks inside its write.
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let entered = false;
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path) => {
    if (path === "Notes/slow.md") { entered = true; await gate; }
    return writer(path);
  };
  const slow = await foreign(r, N18, "Notes/slow.md", "a record the feed is still writing\n");
  await d.timers.run(100, () => entered);
  const syncing = d.engine.syncNow();
  await d.timers.run(100);
  assert.equal(r.host.text("Notes/n17.md"), null, "the retry did not run beside the feed's write");
  open();
  await d.timers.run(100, () => r.state.data.lastSeq === slow.seq && Object.keys(r.state.data.parked).length === 0);
  await syncing;
  assert.equal(r.host.text("Notes/n17.md"), "n17, parked and then unlocked\n");
  assert.equal(r.host.text("Notes/slow.md"), "a record the feed is still writing\n");
});

test("every refusal a disk can make is parked in plain words; any other failure is not", async () => {
  for (const [code, words] of [
    ["EPERM", "the file is locked"],
    ["EBUSY", "the file is in use by another program"],
    ["EACCES", "the folder is read-only"],
    ["EROFS", "the disk is read-only"],
    ["ENOSPC", "the disk is full"],
    ["EDQUOT", "the disk is full"],
    ["ENAMETOOLONG", "its name is too long for this device"],
  ]) {
    const r = await rig();
    refuse(r.host, () => true, code, "commit");
    const frame = await foreign(r, N17, "Notes/n17.md", "a sentinel note\n");
    await assert.rejects(
      applyChange(r.context, frame),
      (error) => error instanceof Unwritable && error.path === "Notes/n17.md" && error.reason === code,
      code,
    );
    assert.equal(unwritableText("Notes/n17.md", code), `Cannot write Notes/n17.md here: ${words}`);
  }
  // An I/O error is not a fact about one file, and neither is a code a
  // server chose: both keep the feed's own handling.
  for (const code of ["EIO", "unknown_file"]) {
    const r = await rig();
    refuse(r.host, () => true, code, "commit");
    const frame = await foreign(r, N17, "Notes/n17.md", "a sentinel note\n");
    await assert.rejects(applyChange(r.context, frame), (error) => !(error instanceof Unwritable) && error.code === code, code);
  }
});

test("a chunk missing from a batch fetch parks its file exactly as a missing single chunk does", async () => {
  const r = await rig();
  // Two chunks, fetched in one batch, neither held by the server.
  const sids = ["5a".repeat(32), "5b".repeat(32)];
  const frame = await r.server.publishManifest({
    fileId: BIG,
    manifest: {
      v: 1, path: "Attachments/two-chunks.bin", size: CHUNK_MAX + CHUNK_MIN, mtime: 1757200001000,
      domain: KEYS.domainId, sha256: "", deleted: false,
      chunks: [{ sid: sids[0], cid: "6a".repeat(32), len: CHUNK_MAX }, { sid: sids[1], cid: "6b".repeat(32), len: CHUNK_MIN }],
    },
    sids, parents: [], deviceId: "ff".repeat(16), manifestKey: r.keys.manifestKey, bytes: CHUNK_MAX + CHUNK_MIN,
  });
  await assert.rejects(
    applyChange(r.context, frame),
    (error) => error instanceof Unwritable && error.path === "Attachments/two-chunks.bin" && error.reason === "unknown_chunk",
  );
  assert.ok(r.server.requests.some((request) => request.target === "/v1/chunks/get"), "the batch route was the one asked");
  assert.equal(r.host.text("Attachments/two-chunks.bin"), null);
});

test("a server that cannot be reached is not a per-record failure: nothing is parked and the feed waits", async (t) => {
  const r = await rig();
  let down = false;
  const d = device(r, {
    request: async (request) => (down && request.url.includes("/v1/chunks/")
      ? { status: 503, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }
      : r.server.request(request)),
  });
  t.after(() => d.engine.stop());
  await d.engine.start();
  await d.timers.run();
  down = true;
  const frame = await foreign(r, N18, "Notes/n18.md", "waiting for the server\n");
  await d.timers.run(1000, () => r.host.logs.some((line) => line.startsWith("feed decision=retry reason=")));

  assert.deepEqual(r.state.data.parked, {}, "an unreachable server parks nothing");
  assert.ok(r.state.data.lastSeq < frame.seq, "and the cursor waits for it");
  assert.equal(d.last().kind, "offline");
  down = false;
  await d.timers.run(1000, () => r.state.data.lastSeq === frame.seq);
  assert.equal(r.host.text("Notes/n18.md"), "waiting for the server\n");
});

test("a parked entry in the data file is input: a file id and a vault path, or it is dropped", () => {
  const data = parseData({
    parked: {
      [N17]: { path: "Notes/n17.md", reason: "EPERM" },
      [N18]: { path: "../outside.md", reason: "EPERM" },
      [NEW1]: { path: "Notes/new1.md", reason: 7 },
      "not-a-file-id": { path: "Notes/x.md", reason: "EPERM" },
      [`${N19}/../../v1/devices`]: { path: "Notes/x.md", reason: "EPERM" },
      [B3]: "junk",
    },
  }, false);
  // A damaged reason only chooses words: the record itself is still owed.
  assert.deepEqual(data.parked, {
    [N17]: { path: "Notes/n17.md", reason: "EPERM" },
    [NEW1]: { path: "Notes/new1.md", reason: "" },
  });
  assert.equal(unwritableText("Notes/new1.md", ""), "Cannot write Notes/new1.md here: it could not be written");
  assert.deepEqual(parseData({ parked: [] }, false).parked, {});
});

test("Show sync status lists every parked file with its reason", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { StatusModal } = box.require(join(box.home, "build/ui/modals.js"));
  const drawn = [];
  const element = () => ({ createEl: (tag, attributes = {}) => { drawn.push(attributes.text ?? tag); return element(); }, empty: () => {} });
  const data = parseData({}, false);
  data.parked = {
    [N17]: { path: "Notes/n17.md", reason: "EPERM" },
    [BIG]: { path: "Attachments/big.bin", reason: "ENOSPC" },
  };
  const modal = new StatusModal({}, {
    state: { data, localBytes: () => 0 },
    statusText: () => "error — Cannot write Attachments/big.bin here: the disk is full (and 1 more: Show sync status)",
  });
  modal.contentEl = element();
  modal.setTitle = () => {};
  modal.onOpen();
  assert.ok(drawn.includes("Cannot write Notes/n17.md here: the file is locked"), drawn.join(" | "));
  assert.ok(drawn.includes("Cannot write Attachments/big.bin here: the disk is full"), drawn.join(" | "));
});
