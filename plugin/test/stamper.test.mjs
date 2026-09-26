/**
 * A plugin that rewrites a note right after every sync (issue #179, S89).
 *
 * THE STAMPER. On every `modify` of a Markdown note it waits one second --
 * re-armed by each later `modify` -- and, unless the front matter already says
 * the current second, rewrites it with that second. Its own rewrite is a
 * `modify`, so once anything touches a note it rewrites it about once a second
 * for as long as it runs, on each device, with or without obsync. Installed on
 * both devices of the 1.1.2 run, one typed line made the note bounce for five
 * minutes: 246 conflict copies on each device, about 970 notices, and at the
 * end two different notes that Sync now did not reconcile.
 *
 * The tests exercise both devices stopping, both explicit Resume orders,
 * all twenty keystrokes ending in the main note, no unbounded copies, and
 * sequential background answers. The fake editor distinguishes typing from
 * background writes exactly through the host's public editing interface.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { DEVICE_B, STEP_MS, pair, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { parseData } = require("../build/state.js");
const { SCAN_MS, SyncEngine } = require("../build/sync/engine.js");
const { ANSWER_MS, answerOf, applyChange } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
const { ApiError } = require("../build/transport.js");

const NOTE = "Notes/n10.md";
const OWN = "Notes/own.md";
const T0 = Date.UTC(2026, 8, 24, 10, 39, 0);
const second = (ms) => new Date(ms).toISOString().slice(0, 19);
const instant = (ms) => new Date(ms).toISOString();
const FRONT = /^---\nupdated: (\S+)\n---\n/;
const TYPED = "TypedS89xabcdefghijk";
/** Twenty keystrokes, each typed nowhere else, so each can be found alone. */
const KEYS = Array.from({ length: 20 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
const KEY_MS = 500;
const AUTOSAVE_MS = 2000;
const REACT_MS = 50;

/**
 * `scratch/stamper.js` from the device run, on the fake vault, stamping to the
 * millisecond. The run's stamper wrote whole seconds, and two Macs on their
 * own clocks rarely wrote the same one; two engines on ONE virtual clock fall
 * into step and write the same second on both, which merges, and the storm
 * this pins never forms.
 */
class Stamper {
  constructor(device, timers) {
    this.host = device.host;
    this.timers = timers;
    this.pending = new Map();
    this.count = 0;
    this.on = true;
    this.host.on("modify", (file) => {
      if (!this.on || !file.path.endsWith(".md")) return;
      const armed = this.pending.get(file.path);
      if (armed !== undefined) timers.clear(armed);
      this.pending.set(file.path, timers.set(() => this.stamp(file.path), 1000));
    });
  }

  stamp(path) {
    this.pending.delete(path);
    const text = this.host.text(path);
    if (!this.on || text === null) return;
    const now = instant(this.host.clock);
    const front = FRONT.exec(text);
    if (front?.[1] === now) return;
    this.count++;
    this.host.write(path, `---\nupdated: ${now}\n---\n${front ? text.slice(front[0].length) : text}`, this.host.clock);
  }

  remove() {
    this.on = false;
    for (const armed of this.pending.values()) this.timers.clear(armed);
    this.pending.clear();
  }
}

/**
 * The note open in A's editor, as sync sees it: keystrokes reach the disk when
 * the editor saves, a write from outside under unsaved keystrokes is merged
 * into the buffer and saved again (`cotyping.test.mjs`), and the host reports
 * what the editor shows through `editing`.
 */
class OpenEditor {
  constructor(device, timers) {
    this.host = device.host;
    this.loaded = this.host.text(NOTE);
    this.unsaved = "";
    this.show();
    this.host.on("modify", (file) => {
      if (file.path === NOTE) timers.set(() => this.external(), REACT_MS);
    });
  }

  typed(text) {
    return text.replace(/\n$/, "") + this.unsaved + "\n";
  }

  show() {
    this.host.editors.set(NOTE, this.unsaved === "" ? this.loaded : this.typed(this.loaded));
  }

  type(text) {
    this.host.inputAt.set(NOTE, this.host.clock);
    this.unsaved += text;
    this.show();
  }

  save() {
    this.external();
    if (this.unsaved === "") return;
    const text = this.typed(this.loaded);
    this.loaded = text;
    this.unsaved = "";
    this.show();
    this.host.write(NOTE, text, this.host.clock);
  }

  external() {
    const disk = this.host.text(NOTE);
    if (disk === null || disk === this.loaded) return;
    this.loaded = disk;
    this.show();
    if (this.unsaved !== "") this.save();
  }
}

/** Copies of `path` itself, not copies of its copies. */
const copiesOf = (host, path) => {
  const stem = `${path.slice(0, -3)} (conflict from`;
  return [...host.files.keys()].filter((name) => name.startsWith(stem) && name.split("(conflict from").length === 2);
};
const pauses = (host) => host.logs.filter((line) => line.startsWith("pull decision=paused reason=rewrite_storm"));
const pulls = (host) => host.logs.filter((line) => line.startsWith("pull")).slice(0, 60).join(" | ");

/** Two devices on one virtual clock, the note on both, and a way to let time pass. */
async function devices(t, body = "# n10\nthe first line\nthe last line\n") {
  const rig = await pair(t, "immediate", { isMobileB: false });
  const { timers, a, b } = rig;
  for (const device of [a, b]) {
    Object.defineProperty(device.host, "clock", { get: () => T0 + timers.now, set: () => undefined });
    device.statuses = [];
    device.engine.onStatus = (status) => device.statuses.push(status);
  }
  rig.wait = async (until) => {
    try {
      await timers.run(10, until);
    } catch (error) {
      throw new Error(`${error.message}\n  A: ${pulls(a.host)}\n  B: ${pulls(b.host)}\n  A all: ${a.host.logs.slice(-12).join(" | ")}\n  B all: ${b.host.logs.slice(-12).join(" | ")}`);
    }
  };
  /** Let time pass until `until` holds, or `limit` ms of virtual time have. */
  rig.until = async (until, limit) => {
    const end = timers.now + limit;
    while (!until() && timers.now < end) await rig.advance(1000);
  };
  /** Virtual time in `step` ms turns: fine while keys and pulls race, coarse for a quiet stretch. */
  rig.advance = async (ms, step = 10) => {
    const target = timers.now + ms;
    while (timers.now < target) {
      const slice = Math.min(target, timers.now + 10_000);
      await timers.run(step, () => timers.now >= slice);
    }
  };
  a.host.write(NOTE, `---\nupdated: ${second(T0 - 60_000)}\n---\n${body}`, T0 - 60_000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(NOTE) === a.host.text(NOTE) && b.state.fileByPath(NOTE) !== undefined);
  rig.fileId = a.state.fileByPath(NOTE).fileId;
  rig.versions = (device) =>
    rig.server.files.get(rig.fileId).versions.filter((version) => device === undefined || version.device_id === device);
  return rig;
}

for (const passive of [false, true]) for (const reverseResume of [false, true]) test(`two stampers stop on both devices, then one text holds every key (reverse Resume: ${reverseResume}, passive editor: ${passive})`, async (t) => {
  const rig = await devices(t);
  const { server, a, b, fileId, advance } = rig;
  const stampers = [new Stamper(a, rig.timers), new Stamper(b, rig.timers)];
  const editor = new OpenEditor(a, rig.timers);
  if (passive) new OpenEditor(b, rig.timers);
  // Twenty keystrokes in A's open editor, one every half second, as in S89.
  for (const key of KEYS) {
    editor.type(key);
    await advance(KEY_MS);
    if (rig.timers.now % AUTOSAVE_MS < KEY_MS) editor.save();
  }
  editor.save();
  await rig.until(() => b.state.data.paused[fileId] !== undefined, 60_000);
  const pausedAt = { b: rig.versions(DEVICE_B).length, log: b.host.logs.length };
  await rig.wait(() => a.state.data.paused[fileId] !== undefined);
  const heldVersions = rig.versions().length;
  const stampsAtHold = stampers.map((stamper) => stamper.count);
  await advance(300_000, STEP_MS);
  assert.equal(rig.versions().length, heldVersions, "five minutes of local stamping must publish no more note versions");
  assert.ok(stampers.every((stamper, index) => stamper.count > stampsAtHold[index]), "both stampers must keep rewriting while held");

  const story = () => [
    `versions=${rig.versions().length} (B ${rig.versions(DEVICE_B).length}, B at pause ${pausedAt.b})`,
    `copies=${copiesOf(a.host, NOTE).length}/${copiesOf(b.host, NOTE).length} stamps=${stampers[0].count}/${stampers[1].count}`,
    `notices A: ${a.host.notices.join(" || ")}`,
    `notices B: ${b.host.notices.join(" || ")}`,
    `heads=${server.files.get(fileId).heads.length} kept=${[...b.host.files.keys()].filter((path) => path !== NOTE && b.host.text(path) === b.host.text(NOTE)).length}`,
    `B: ${pulls(b.host)}`,
    `A: ${a.host.logs.filter((line) => line.startsWith("pull") || line.startsWith("sync_now")).slice(-30).join(" | ")}`,
  ].join("\n  ");

  // PAUSED, ON THE DEVICE WITH NO INPUT, even if its editor is open, within a bounded
  // number of rounds and said once. A has recent input, so A never takes its
  // own stamper for a storm: that side is the next paragraph's.
  assert.deepEqual(b.state.data.paused[fileId], { path: NOTE }, story());
  assert.deepEqual(a.state.data.paused[fileId], { path: NOTE, remote: true }, story());
  assert.match(
    pauses(b.host).find((line) => line.includes(fileId)) ?? "",
    new RegExp(`file=${fileId} seq=\\d+ answer_ms=\\d+ duration_ms=\\d+ budget_ms=${ANSWER_MS}$`),
    story(),
  );
  const told = (host) => host.notices.filter((notice) => notice.startsWith(`${NOTE} was rewritten on this device`));
  assert.equal(told(b.host).length, 1, story());
  assert.match(told(b.host)[0], /^Notes\/n10\.md was rewritten on this device right after a sync, on the same lines another device changed\. Another plugin may be rewriting it .*obsync paused syncing it here; nothing was deleted\. .*Sync now, or press Resume in Show sync status\.$/);
  assert.equal(told(a.host).length, 0, story());
  assert.equal(a.host.notices.filter((notice) => notice.startsWith(`obsync paused syncing ${NOTE}`)).length, 1, story());
  assert.ok(rig.versions().length <= 10, story());
  assert.deepEqual(b.statuses.at(-1), { kind: "paused", message: `${NOTE} (Show sync status)` }, story());

  // HELD ON BOTH DEVICES. The shared control stops A as well as B, while
  // each host plugin remains free to rewrite its own local note.
  assert.equal(rig.versions(DEVICE_B).length, pausedAt.b, story());
  const after = b.host.logs.slice(pausedAt.log).filter((line) => line.startsWith("pull") && line.includes(`file=${fileId}`));
  assert.ok(after.every((line) => line.includes("decision=skipped reason=paused")), story());
  assert.ok(copiesOf(a.host, NOTE).length <= 1 && copiesOf(b.host, NOTE).length <= 1, story());
  const keptBoth = (host) => host.notices.filter((notice) => notice.startsWith(`obsync kept both versions of ${NOTE}`));
  assert.ok(keptBoth(a.host).length <= 1 && keptBoth(b.host).length <= 1, story());
  const held = b.host.text(NOTE);

  // The stampers go, the vault is quiet for a minute, and Sync now runs on
  // both, as in S89.
  for (const stamper of stampers) stamper.remove();
  await advance(20_000, STEP_MS);
  if (reverseResume) { await b.engine.syncNow(); await a.engine.syncNow(); }
  else { await a.engine.syncNow(); await b.engine.syncNow(); }
  await rig.wait(() => b.host.text(NOTE) === a.host.text(NOTE) && b.state.data.paused[fileId] === undefined);
  await advance(5000);

  // ONE NOTE, NOTHING LOST. B takes the note to what A has, and what B held
  // while paused is kept beside it, on both. Every keystroke must be in the
  // main note itself, as required by #179's Sync now acceptance.
  assert.equal(b.host.text(NOTE), a.host.text(NOTE), story());
  assert.ok(a.host.text(NOTE).includes(KEYS), story());
  for (const device of [a, b]) {
    const everything = [...device.host.files.keys()].map((path) => device.host.text(path)).join("");
    assert.deepEqual([...KEYS].filter((key) => !everything.includes(key)), [], story());
  }
  assert.deepEqual(b.state.data.paused[fileId], undefined, story());
  const kept = [...b.host.files.keys()].filter((path) => path !== NOTE && b.host.text(path) === held);
  assert.equal(kept.length, 1, `B's paused text is in no file beside the note: ${story()}`);
  assert.equal(a.host.text(kept[0]), held, story());
  for (const device of [a, b]) assert.ok(copiesOf(device.host, NOTE).length <= 1, `Resume created a second sibling: ${story()}`);
  assert.match(b.host.logs.find((line) => line.startsWith("pull decision=resumed")) ?? "", /outcome=kept_beside .*trigger=sync_now/);
  assert.equal(b.statuses.at(-1).kind, "idle", story());
});

/**
 * THE SAME RUN WITH NOBODY SHOWING THE NOTE. Either device may be the first to
 * see two answers pauses and shares its hold, so neither publishes more
 * versions. Whichever detected the storm, Sync now
 * after the plugins go leaves one note holding what was typed.
 */
test("with the note open nowhere, the first device whose answer collides pauses it and nothing forks after", async (t) => {
  const rig = await devices(t);
  const { server, a, b, fileId, advance } = rig;
  const stampers = [new Stamper(a, rig.timers), new Stamper(b, rig.timers)];
  a.host.write(NOTE, `${a.host.text(NOTE)}${TYPED}\n`, a.host.clock);
  await rig.until(() => pauses(a.host).length > 0 || pauses(b.host).length > 0, 60_000);
  const [held, other] = b.state.data.paused[fileId] !== undefined ? [b, a] : [a, b];
  const from = held === a ? rig.versions().filter((v) => v.device_id !== DEVICE_B).length : rig.versions(DEVICE_B).length;
  await rig.wait(() => a.state.data.paused[fileId] !== undefined && b.state.data.paused[fileId] !== undefined);
  const stopped = rig.versions().length;
  const copies = copiesOf(a.host, NOTE).length;
  await advance(30_000, STEP_MS);
  const story = `paused on ${held === a ? "A" : "B"} versions=${rig.versions().length} stamps=${stampers[0].count}/${stampers[1].count}\n  ` +
    `A: ${pulls(a.host)}\n  B: ${pulls(b.host)}`;
  assert.deepEqual(held.state.data.paused[fileId], { path: NOTE }, story);
  const by = held === a ? rig.versions().filter((v) => v.device_id !== DEVICE_B).length : rig.versions(DEVICE_B).length;
  assert.equal(by, from, story);
  assert.equal(rig.versions().length, stopped, story);
  assert.ok(stopped <= 10, story);
  assert.equal(copiesOf(a.host, NOTE).length, copies, story);
  assert.ok(copies <= 1, story);
  assert.equal(other.host.notices.filter((notice) => notice.startsWith(`${NOTE} was rewritten`)).length, 0, story);
  for (const stamper of stampers) stamper.remove();
  await advance(10_000);
  await a.engine.syncNow();
  await b.engine.syncNow();
  await rig.wait(() => b.host.text(NOTE) === a.host.text(NOTE));
  await advance(5000);
  assert.equal(b.host.text(NOTE), a.host.text(NOTE), story);
  assert.ok(a.host.text(NOTE).includes(TYPED), story);
});

/**
 * RESUME, ONE NOTE, FROM SHOW SYNC STATUS; AND A RESTART IN BETWEEN. A plugin
 * on B rewrites the stamp line right after A's version arrives, while A
 * rewrites that line too: the pair does not merge, B's side is an answer to a
 * sync, and B pauses the note. One answer that merges is no storm. While
 * paused, an edit on A does not land on B and an edit on B does not leave; the
 * pause is in the saved data and a new engine over it still holds the note;
 * Resume brings A's edits in and keeps what B held beside the note.
 */
test("a paused note stays paused across a restart and Resume brings it back", async (t) => {
  const rig = await devices(t, "# n10\nstamp: 0\nbody\n");
  const { a, b, fileId, advance } = rig;
  // Someone types on A, in an editor showing the note.
  a.host.editors.set(NOTE, "what the editor shows");
  const stamp = (device, value) => device.host.write(NOTE, device.host.text(NOTE).replace(/stamp: \S+/, `stamp: ${value}`), device.host.clock);

  // A plugin on B answers A's edit on another line: it merges, and nothing pauses.
  a.host.inputAt.set(NOTE, a.host.clock);
  a.host.write(NOTE, a.host.text(NOTE).replace("body", "body A1"), a.host.clock);
  await rig.wait(() => b.host.text(NOTE)?.includes("body A1"));
  stamp(b, "B1");
  await advance(5000);
  assert.deepEqual(b.state.data.paused, {}, "an answer that merges is not a storm");
  assert.ok(a.host.text(NOTE).includes("stamp: B1"));

  // A's edit arrives, B's plugin answers on the stamp line, and A's user retypes that line meanwhile.
  a.host.inputAt.set(NOTE, a.host.clock);
  a.host.write(NOTE, a.host.text(NOTE).replace("body A1", "body A2"), a.host.clock);
  await rig.wait(() => b.host.text(NOTE)?.includes("body A2"));
  stamp(b, "B2");
  stamp(a, "A2");
  await rig.wait(() => b.state.data.paused[fileId] !== undefined);
  await advance(5000);
  assert.deepEqual(b.state.data.paused, { [fileId]: { path: NOTE } }, pulls(b.host));

  // Held both ways.
  a.host.write(NOTE, `${a.host.text(NOTE)}typed on A while paused\n`, a.host.clock);
  b.host.write(NOTE, `${b.host.text(NOTE)}typed on B while paused\n`, b.host.clock);
  await rig.wait(() => b.host.logs.some((line) => line.includes(`decision=skipped reason=paused file=${fileId}`)));
  await advance(5000);
  assert.ok(!b.host.text(NOTE).includes("typed on A while paused"));
  assert.ok(!a.host.text(NOTE).includes("typed on B while paused"));

  // Persisted, and a restart keeps it: the new engine says so as it starts.
  assert.deepEqual(parseData(JSON.parse(JSON.stringify(b.state.data)), false).paused, { [fileId]: { path: NOTE } });
  b.engine.stop();
  const statuses = [];
  const again = new SyncEngine({
    state: b.state, transport: b.transport, host: b.host, now: () => b.host.clock, timers: rig.timers,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => again.stop());
  b.plugin.engine = again;
  await again.start();
  await advance(5000);
  assert.deepEqual(statuses.at(-1), { kind: "paused", message: `${NOTE} (Show sync status)` });
  assert.ok(!b.host.text(NOTE).includes("typed on A while paused"));
  const heldText = b.host.text(NOTE);
  const fromB = rig.versions(DEVICE_B).length;

  await a.engine.resume(fileId, "status");
  await again.resume(fileId, "status");
  await rig.wait(() => b.host.text(NOTE) === a.host.text(NOTE) && a.host.text(NOTE).includes("typed on A while paused"));
  await advance(5000);
  assert.deepEqual(b.state.data.paused, {});
  assert.equal(b.host.text(NOTE), a.host.text(NOTE));
  assert.ok(a.host.text(NOTE).includes("typed on A while paused"));
  // What B held left as a note of its own; the note itself took A's, and B
  // posted no version of it that would fork it again.
  assert.equal(rig.versions(DEVICE_B).length, fromB, "resuming published this device's text over the note");
  const kept = [...b.host.files.keys()].filter((path) => path !== NOTE && b.host.text(path) === heldText);
  assert.equal(kept.length, 1, "B's edit made while paused is in no file");
  assert.equal(a.host.text(kept[0]), heldText, "and it reached A beside the note");
  assert.match(
    b.host.logs.find((line) => line.startsWith("pull decision=resumed")) ?? "",
    new RegExp(`outcome=kept_beside file=${fileId} trigger=status paused=0`),
  );
  assert.equal(statuses.at(-1).kind, "idle");
});

/**
 * THE SILENT DIVERGENCE. A plugin that answers a sync by rewriting the note
 * and keeping its modified time, with a fixed-width stamp, leaves the record's
 * `(mtime, size)` exactly true of the new bytes. The event is read when it
 * follows an arrival, and the bytes are sent; long after any arrival the
 * metadata is taken at its word, as before, so the cost is bounded by what
 * arrives.
 */
test("a same-size rewrite that keeps the recorded time right after a sync is still sent", async (t) => {
  const rig = await devices(t, "# n10\nstamp: aaaa\n");
  const { a, b, advance } = rig;
  const rewrite = (text) => {
    const was = b.host.files.get(NOTE);
    b.host.files.set(NOTE, { bytes: new TextEncoder().encode(text), mtime: was.mtime });
    b.host.emit("modify", b.host.entry(NOTE));
  };
  a.host.write(NOTE, a.host.text(NOTE).replace("# n10", "# N10"), a.host.clock);
  await rig.wait(() => b.host.text(NOTE)?.includes("# N10") && b.state.fileByPath(NOTE).versionId === a.state.fileByPath(NOTE).versionId);
  // A second later, as the device run's stamper did: the pull's own write has
  // been reported back and dropped as its echo by then.
  await advance(1000);
  const record = b.state.fileByPath(NOTE);
  rewrite(b.host.text(NOTE).replace("aaaa", "bbbb"));
  const stat = await b.host.stat(NOTE);
  assert.deepEqual([stat.mtime, stat.size], [record.mtime, record.size], "the rewrite left both numbers as recorded");
  await rig.wait(() => a.host.text(NOTE)?.includes("bbbb"));

  // Long after the last arrival, the same kind of rewrite is not read again.
  await advance(ANSWER_MS + 2 * SCAN_MS, STEP_MS);
  const posted = rig.versions().length;
  rewrite(b.host.text(NOTE).replace("bbbb", "cccc"));
  await advance(5000);
  assert.equal(rig.versions().length, posted);
});

/**
 * TYPING IS NEVER A STORM. The same rhythm -- a change here right after every
 * arrival -- in a note with real editor input is protected, and #135
 * settles it; it is never paused.
 */
test("actual input remains exempt while its editor buffer is unsaved", async (t) => {
  const rig = await devices(t);
  const { a, b, advance } = rig;
  // Someone typing on each side, in an editor showing the note.
  a.host.editors.set(NOTE, "what the editor shows");
  b.host.editors.set(NOTE, "what the editor shows");
  for (let round = 1; round <= 4; round++) {
    a.host.inputAt.set(NOTE, a.host.clock);
    a.host.write(NOTE, `${a.host.text(NOTE)}A${round}\n`, a.host.clock);
    await rig.wait(() => b.host.text(NOTE)?.includes(`A${round}\n`));
    b.host.inputAt.set(NOTE, b.host.clock);
    b.host.write(NOTE, `${b.host.text(NOTE)}B${round}\n`, b.host.clock);
    await advance(3000);
  }
  assert.deepEqual(b.state.data.paused, {});
  assert.deepEqual(pauses(b.host), []);
  assert.ok(a.host.text(NOTE).includes("B4\n"));

  // And what it takes to judge answers is bounded: a pass after the last
  // arrival and the last edit, nothing is left of either, including the
  // verdict on an edit of a note no version had reached.
  b.host.write(OWN, "only here\n", b.host.clock);
  await rig.wait(() => b.state.fileByPath(OWN) !== undefined);
  b.host.write(OWN, "only here, edited\n", b.host.clock);
  await advance(2 * SCAN_MS + ANSWER_MS, STEP_MS);
  assert.deepEqual([b.engine.context.arrivals.size, b.engine.context.answering.size], [0, 0]);
});

/**
 * WHAT THE STATUS SAYS, IN ONE ORDER: a parked file (it needs the person and
 * names the cause), then a paused note, then `idle`.
 */
test("the status names a parked file before a paused note, and a paused note before idle", async (t) => {
  const rig = await devices(t);
  const { b, fileId } = rig;
  const absent = "88".repeat(16);
  b.state.data.paused[fileId] = { path: NOTE };
  b.state.data.parked["77".repeat(16)] = { path: "Notes/locked.md", reason: "EPERM" };
  await b.engine.resume(absent, "status");
  assert.equal(b.statuses.at(-1).kind, "error");
  assert.match(b.statuses.at(-1).message, /^Cannot write Notes\/locked\.md here/);
  delete b.state.data.parked["77".repeat(16)];
  await b.engine.resume(absent, "status");
  assert.deepEqual(b.statuses.at(-1), { kind: "paused", message: `${NOTE} (Show sync status)` });
  b.state.data.paused["99".repeat(16)] = { path: "Notes/other.md" };
  await b.engine.resume(absent, "status");
  assert.deepEqual(b.statuses.at(-1), { kind: "paused", message: "Notes/other.md and 1 more (Show sync status)" });
  delete b.state.data.paused["99".repeat(16)];

  // A restart with nothing else to do still says so: the note is still paused.
  b.engine.stop();
  const statuses = [];
  const again = new SyncEngine({
    state: b.state, transport: b.transport, host: b.host, now: () => b.host.clock, timers: rig.timers,
    onStatus: (status) => statuses.push(status),
  });
  t.after(() => again.stop());
  await again.start();
  assert.deepEqual(statuses, [{ kind: "paused", message: `${NOTE} (Show sync status)` }]);
  await again.resume(fileId, "status");
  assert.equal(statuses.at(-1).kind, "idle");
});

/**
 * A RESUME THAT FAILS LEAVES THE NOTE PAUSED. The versions the feed moved past
 * while it was paused are only ever asked of the server by a resume, so one
 * that could not ask must not let the note go back to syncing as if it had.
 */
test("a resume that cannot reach the server leaves the note paused", async (t) => {
  const rig = await devices(t);
  const { b, fileId } = rig;
  b.host.write(NOTE, `${b.host.text(NOTE)}held here\n`, b.host.clock);
  b.state.data.paused[fileId] = { path: NOTE };
  const getFile = b.transport.getFile;
  b.transport.getFile = async () => { throw new ApiError(0, "unreachable", "no answer"); };
  await b.engine.resume(fileId, "status");
  b.transport.getFile = getFile;
  assert.deepEqual(b.state.data.paused, { [fileId]: { path: NOTE } });
  assert.match(b.host.logs.find((line) => line.startsWith("pull decision=resumed")) ?? "", new RegExp(`outcome=failed_\\S+ file=${fileId} trigger=status paused=1`));
  assert.equal(b.statuses.at(-1).kind, "paused");
});

// --- the verdict, one clause at a time -------------------------------------

/**
 * One device, one pair that does not merge: a version from another device
 * rewrites the line this device's unpushed edit rewrote. Whether the note is
 * paused is the verdict on that edit, and each case below changes one fact.
 */
async function collide({ mtime, editor = false, typed = false, judged, pulled = false } = {}) {
  const r = await rig();
  const now = r.host.clock;
  r.host.seed(NOTE, "# n10\nline: 0\n", now - 60_000);
  const base = await pushFile(r.context, NOTE);
  const record = r.state.fileByPath(NOTE);
  r.context.arrivals.set(NOTE, now - 1000);
  if (pulled) {
    // The note here is a version this device PULLED, stamped with the clock
    // of the device that wrote it: a time inside the window, and no edit here.
    const v1 = await r.server.publish({
      fileId: base.fileId, path: NOTE, bytes: new TextEncoder().encode("# n10\nline: pulled\n"), mtime: now,
      parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
    assert.equal(await applyChange(r.context, v1), "applied");
  } else {
    r.host.seed(NOTE, "# n10\nline: here\n", mtime);
  }
  if (editor) r.host.editors.set(NOTE, editor === "unsaved" ? "old passive editor text" : r.host.text(NOTE));
  if (typed) r.host.inputAt.set(NOTE, now);
  if (judged !== undefined) r.context.answering.set(record.fileId, { mtime, arrived: judged });
  const theirs = await r.server.publish({
    fileId: base.fileId, path: NOTE, bytes: new TextEncoder().encode("# n10\nline: there\n"), mtime: now,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  await applyChange(r.context, theirs);
  return { paused: r.state.data.paused[base.fileId] !== undefined, text: r.host.text(NOTE), logs: r.host.logs };
}

test("an unpushed edit made right after a sync, to a note no editor shows, pauses its pair", async () => {
  const now = (await rig()).host.clock;
  const storm = await collide({ mtime: now });
  assert.equal(storm.paused, true, storm.logs.join(" | "));
  assert.equal(storm.text, "# n10\nline: here\n", "a pause writes nothing");
  assert.match(storm.logs.find((line) => line.startsWith("pull decision=paused")) ?? "", /answer_ms=1000 duration_ms=1000 budget_ms=5000$/);
});

test("the same pair is settled by the rule when the edit was typed, came long after the sync, or before it", async () => {
  const now = (await rig()).host.clock;
  for (const [what, facts] of [
    ["typed and saved in an editor", { mtime: now, editor: true, typed: true }],
    ["input arrived after the watcher judged a background write", { mtime: now, editor: true, typed: true, judged: now - 1000 }],
    ["long after the sync", { mtime: now - 1000 + ANSWER_MS }],
    ["made before the sync", { mtime: now - 1001 }],
    ["judged typed when it settled, the editor since closed", { mtime: now, judged: null }],
    ["no edit here: a pulled version stamped by its own device", { mtime: now, pulled: true }],
  ]) {
    const settled = await collide(facts);
    assert.equal(settled.paused, false, `${what}: ${settled.logs.filter((line) => line.startsWith("pull")).join(" | ")}`);
  }
});

/** Explicit Sync now cannot trust metadata a plugin deliberately preserved. */
test("Sync now reads a silent fixed-width rewrite after the arrival window expired", async (t) => {
  const run = await devices(t, "# n10\nvalue: aaaa\n");
  const { a, b, advance } = run;
  await advance(ANSWER_MS + 2 * SCAN_MS, STEP_MS);
  const record = b.state.fileByPath(NOTE);
  const held = b.host.files.get(NOTE);
  b.host.files.set(NOTE, { bytes: new TextEncoder().encode(b.host.text(NOTE).replace("aaaa", "bbbb")), mtime: held.mtime });
  assert.deepEqual([held.mtime, held.bytes.length], [record.mtime, record.size]);
  const before = run.versions().length;
  await b.engine.syncNow();
  await run.wait(() => a.host.text(NOTE)?.includes("bbbb"));
  assert.equal(run.versions().length, before + 1);
  await b.engine.syncNow();
  assert.equal(run.versions().length, before + 1, "unchanged bytes published another version");
});


test("strictly alternating background answers stop without needing a conflicting pair", async (t) => {
  const run = await devices(t, "line: 0\n");
  const { a, b, fileId } = run;
  for (let turn = 1; turn <= 6; turn++) {
    const [local, other] = turn % 2 ? [b, a] : [a, b];
    if (local.state.data.paused[fileId] !== undefined) break;
    local.host.write(NOTE, local.host.text(NOTE).replace(/line: \d+/, `line: ${turn}`), local.host.clock);
    await run.wait(() => other.host.text(NOTE)?.includes(`line: ${turn}`) || other.state.data.paused[fileId] !== undefined);
  }
  await run.wait(() => a.state.data.paused[fileId] !== undefined && b.state.data.paused[fileId] !== undefined);
  const stopped = run.versions().length;
  await run.advance(30_000, STEP_MS);
  assert.ok(stopped <= 7, `posted ${stopped} versions`);
  assert.equal(run.versions().length, stopped);
  assert.equal(copiesOf(a.host, NOTE).length + copiesOf(b.host, NOTE).length, 0);
});

test("a paused note takes no later ordinary feed frame", async () => {
  const r = await rig();
  r.host.seed(NOTE, "held here\n");
  const ours = await pushFile(r.context, NOTE);
  r.state.data.paused[ours.fileId] = { path: NOTE };
  const theirs = await r.server.publish({ fileId: ours.fileId, path: NOTE, bytes: new TextEncoder().encode("must stay remote\n"), mtime: r.host.clock + 1000, parents: [ours.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  assert.equal(await applyChange(r.context, theirs), "skipped");
  assert.equal(r.host.text(NOTE), "held here\n");
});


for (const reverseResume of [false, true]) test(`a published answer and its newer paused text share one copy after Resume (reverse: ${reverseResume})`, async (t) => {
  const rig = await devices(t, "# n10\nABCD\n");
  const { a, b, fileId, advance } = rig;
  const stampers = [new Stamper(a, rig.timers), new Stamper(b, rig.timers)];
  const post = b.transport.postVersion.bind(b.transport);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); for (const stamper of stampers) stamper.remove(); });
  b.transport.postVersion = async (...args) => { entered(); await gate; return post(...args); };
  stampers[1].stamp(NOTE);
  const oldText = b.host.text(NOTE);
  // A real publication already in flight when the detector persists its hold.
  const older = pushFile(b.engine.need(), NOTE);
  await started;
  b.state.data.paused[fileId] = { path: NOTE };
  await b.state.save();
  const { publishPause } = require("../build/sync/pause.js");
  // The control uses the same transport; let it pass without releasing the note.
  b.transport.postVersion = post;
  await publishPause(b.engine.need(), fileId, NOTE, true);
  await rig.wait(() => a.state.data.paused[fileId] !== undefined);
  release(); await older;
  const editor = new OpenEditor(a, rig.timers);
  for (const key of "EFGHIJKLMNOPQRST") { editor.type(key); await advance(500); editor.save(); }
  const heldVersions = rig.versions().length;
  const counts = stampers.map((stamper) => stamper.count);
  await advance(300_000, STEP_MS);
  assert.equal(rig.versions().length, heldVersions);
  assert.ok(stampers.every((stamper, index) => stamper.count > counts[index]));
  const held = b.host.text(NOTE);
  assert.notEqual(held, oldText, "the local stamper must advance past the published answer");
  for (const stamper of stampers) stamper.remove();
  if (reverseResume) { await b.engine.syncNow(); await a.engine.syncNow(); }
  else { await a.engine.syncNow(); await b.engine.syncNow(); }
  await rig.wait(() => a.host.text(NOTE) === b.host.text(NOTE) && b.state.data.paused[fileId] === undefined);
  await advance(5000);
  for (const device of [a, b]) {
    assert.ok(device.host.text(NOTE).includes("ABCDEFGHIJKLMNOPQRST"));
    const copies = copiesOf(device.host, NOTE);
    assert.equal(copies.length, 1, "Resume must advance the published-answer copy instead of creating another sibling");
    assert.equal(device.host.text(copies[0]), held);
  }
  const copyId = b.state.fileByPath(copiesOf(b.host, NOTE)[0]).fileId;
  const copy = rig.server.files.get(copyId);
  const { decryptRecordManifest } = require("../build/sync/pull.js");
  const { decryptChunk, unhex } = require("../build/crypto.js");
  const history = await Promise.all(copy.versions.map(async (version) => {
    const manifest = await decryptRecordManifest(b.engine.need(), { ...version, file_id: copyId, domain_id: copy.domain_id });
    const parts = await Promise.all(manifest.chunks.map(async (chunk) => decryptChunk(rig.keys.domainKey, unhex(chunk.cid), await b.transport.getChunk(chunk.sid))));
    return new TextDecoder().decode(Buffer.concat(parts));
  }));
  assert.ok(history.includes(oldText), "the older published answer must remain in the one copy's history");
  assert.ok(history.includes(held), "the latest held rewrite must be durably published");
});

// A saved passive view is the native n13 reproduction: both editors were open,
// but only A received any keyboard input. B's plugin answer must still hold.
test("a passive saved editor does not exempt a colliding background rewrite", async () => {
  const now = (await rig()).host.clock;
  assert.equal((await collide({ mtime: now, editor: true })).paused, true);
});

test("a passive editor still loading an external write is not unsaved user input", async () => {
  const now = (await rig()).host.clock;
  assert.equal((await collide({ mtime: now, editor: "unsaved" })).paused, true);
});

test("answer flags distinguish actual input from passive buffer lag", async () => {
  const r = await rig(), arrived = r.host.clock - 1000;
  r.context.arrivals.set(NOTE, arrived);
  r.host.seed(NOTE, "new external text", r.host.clock);
  r.host.editors.set(NOTE, "old passive buffer");
  assert.equal(await answerOf(r.context, NOTE, r.host.clock), arrived);
  r.host.inputAt.set(NOTE, r.host.clock);
  assert.equal(await answerOf(r.context, NOTE, r.host.clock), null);
});

for (const typed of [false, true]) test(`a later arrival cannot erase the verdict on a waiting local save (typed: ${typed})`, async (t) => {
  const run = await devices(t, "# n10\nlocal: base\nremote: base\n");
  const { a, b, fileId, advance } = run;
  await a.engine.stopAndWait();
  await b.engine.stopAndWait();
  const ac = a.engine.need(), bc = b.engine.need();
  const firstArrival = bc.arrivals.get(NOTE);
  assert.equal(typeof firstArrival, "number");
  await advance(500);
  b.host.write(NOTE, b.host.text(NOTE).replace("local: base", "local: changed"), b.host.clock);
  if (typed) {
    b.host.inputAt.set(NOTE, b.host.clock);
    await b.engine.answered(bc, await b.host.stat(NOTE));
    b.host.inputAt.delete(NOTE); // The editor has closed before the next arrival.
  }
  const saved = await b.host.stat(NOTE);
  await advance(100);
  a.host.write(NOTE, a.host.text(NOTE).replace("remote: base", "remote: changed"), a.host.clock);
  const next = await pushFile(ac, NOTE);
  const frame = run.server.journal.find(entry => entry.version_id === next.versionId);
  assert.equal(await b.engine.receive(bc, frame), "skipped", "the pending local save must publish before this fast-forward");
  assert.ok(bc.arrivals.get(NOTE) > saved.mtime, "a later arrival replaces the old arrival time");
  await b.engine.answered(bc, saved); // The debounced watcher finally settles.
  const posted = await pushFile(bc, NOTE);
  const { decryptRecordManifest } = require("../build/sync/pull.js");
  const manifest = await decryptRecordManifest(ac, run.server.journal.find(entry => entry.version_id === posted.versionId));
  assert.equal(manifest.answer === true, !typed, "the published verdict describes this save, not the most recent arrival");
});

for (const mode of ["unchanged", "missing", "replaced", "outside"]) test(`arrival bookkeeping cannot classify ${mode} bytes as a local rewrite`, async (t) => {
  const run = await devices(t, "# n10\nunchanged\n");
  const { a, b, fileId, advance } = run;
  await a.engine.stopAndWait();
  await b.engine.stopAndWait();
  const ac = a.engine.need(), bc = b.engine.need();
  await advance(500);
  a.host.write(NOTE, "# n10\nremote edit\n", a.host.clock);
  const next = await pushFile(ac, NOTE);
  const frame = run.server.journal.find(entry => entry.version_id === next.versionId);
  const stat = b.host.stat.bind(b.host);
  if (mode === "missing") b.host.files.delete(NOTE);
  if (mode === "outside") b.state.data.syncFolders = ["Elsewhere"];
  if (mode === "replaced" || mode === "outside") b.host.stat = async path => {
    if (path === NOTE) {
      assert.notEqual(mode, "outside", "do not inspect a note outside the selected folders");
      b.host.seed(NOTE, "an unrelated local file", b.host.clock);
      b.state.setFile(NOTE, { ...b.state.fileByPath(NOTE), fileId: "aa".repeat(16) });
    }
    return await stat(path);
  };
  await b.engine.receive(bc, frame);
  assert.equal(bc.answering.size, 0, "a remote version, vanished file or different identity provides no local-edit proof");
  if (mode === "unchanged") assert.equal(b.host.text(NOTE), a.host.text(NOTE));
});

test("arrival bookkeeping does not inspect an old path outside the selected folders", async (t) => {
  const run = await devices(t, "# n10\nbase\n");
  const { a, b, fileId } = run;
  await a.engine.stopAndWait();
  await b.engine.stopAndWait();
  const ac = a.engine.need(), bc = b.engine.need();
  b.state.data.syncFolders = ["Inside"];
  const frame = await run.server.publish({ fileId, path: "Inside/moved.md", bytes: new TextEncoder().encode("moved\n"),
    mtime: b.host.clock, parents: [b.state.fileByPath(NOTE).versionId], domainKey: ac.domainKey, manifestKey: ac.manifestKey });
  const stat = b.host.stat.bind(b.host);
  let inspected = 0;
  b.host.stat = async path => { if (path === NOTE) inspected++; return await stat(path); };
  await b.engine.receive(bc, frame);
  assert.equal(inspected, 0, "incoming metadata may name a selected destination without admitting its unselected old path");
  assert.equal(bc.answering.size, 0);
});

for (const mode of ["echo", "invalid", "nested"]) test(`a ${mode} version supplies no pre-write arrival evidence`, async (t) => {
  const run = await devices(t, "# n10\nbase\n");
  const { a, b, advance } = run;
  await a.engine.stopAndWait();
  await b.engine.stopAndWait();
  const ac = a.engine.need(), bc = b.engine.need();
  const before = bc.arrivals.get(NOTE);
  const original = b.host.text(NOTE);
  await advance(ANSWER_MS + 1);
  a.host.write(NOTE, "# n10\nremote\n", a.host.clock);
  const next = await pushFile(ac, NOTE);
  const frame = { ...run.server.journal.find(entry => entry.version_id === next.versionId) };
  if (mode === "echo") frame.device_id = bc.deviceId;
  if (mode === "invalid") frame.manifest_ct = "AAAA";
  if (mode === "nested") b.host.inNestedVault = async path => path === NOTE;
  await b.engine.receive(bc, frame);
  assert.equal(bc.arrivals.get(NOTE), before, "an ignored or unauthenticated record cannot replace arrival evidence");
  assert.equal(b.host.text(NOTE), original);
});

test("a host plugin can recognize an arrival before the incoming write returns", async (t) => {
  const run = await devices(t, "# n10\nbase\n");
  const { a, b, advance } = run;
  await a.engine.stopAndWait();
  await b.engine.stopAndWait();
  const ac = a.engine.need(), bc = b.engine.need();
  await advance(ANSWER_MS + 1);
  a.host.write(NOTE, "# n10\nremote\n", a.host.clock);
  const next = await pushFile(ac, NOTE);
  const frame = run.server.journal.find(entry => entry.version_id === next.versionId);
  const writer = b.host.writer.bind(b.host);
  let observed;
  b.host.writer = async path => {
    const sink = await writer(path), commit = sink.commit.bind(sink);
    sink.commit = async mtime => {
      const stat = await commit(mtime);
      if (path === NOTE) observed = await answerOf(bc, NOTE, b.host.clock);
      return stat;
    };
    return sink;
  };
  assert.equal(await b.engine.receive(bc, frame), "applied");
  assert.equal(observed, b.host.clock, "the filesystem event must already have the authenticated arrival's time");
});

// Native n14: A sees B's published automatic answer BEFORE B sees A's
// competing save. A's active editor must not first be replaced by the older
// answer (splitting ABCDEFGH into the copy and ABCDIJKL into the main note).
// Deliver the real encrypted versions in that order, then run both engines
// with their stampers still enabled through typing, hold and both Resume orders.
for (const reverseResume of [false, true]) test(`a peer answer holds an overlapping active editor before its first copy (reverse: ${reverseResume})`, async (t) => {
  const run = await devices(t, "# n10\nABCD\n");
  const { a, b, fileId, advance } = run;
  await a.engine.stopAndWait();
  await b.engine.stopAndWait();
  const ac = a.engine.need(), bc = b.engine.need();
  const stampers = [new Stamper(a, run.timers), new Stamper(b, run.timers)];
  t.after(() => { for (const stamper of stampers) stamper.remove(); });
  const editor = new OpenEditor(a, run.timers);
  new OpenEditor(b, run.timers);
  // Both start from ABCD. A has saved EFGH when B posts its one-second
  // background answer to ABCD, with a different front-matter stamp.
  for (const key of "EFGH") { editor.type(key); await advance(500); }
  editor.save();
  stampers[0].stamp(NOTE);
  const ours = await pushFile(ac, NOTE);
  await advance(10);
  stampers[1].stamp(NOTE);
  bc.answering.set(fileId, { mtime: b.host.clock, arrived: b.host.clock - 1000 });
  const theirs = await pushFile(bc, NOTE);
  const frame = run.server.journal.find((entry) => entry.version_id === theirs.versionId);
  const { decryptRecordManifest } = require("../build/sync/pull.js");
  assert.equal((await decryptRecordManifest(ac, frame)).answer, true, "the actual published version must carry the background verdict");
  assert.equal(frame.parents.includes(ours.versionId), false, "the peer answer must be a competing branch");
  const before = a.host.text(NOTE);
  assert.equal(await applyChange(ac, frame), "skipped");
  assert.equal(a.host.text(NOTE), before, "the active main note must not be replaced before holding");
  assert.equal(copiesOf(a.host, NOTE).length, 0, "hold before making the first copy");
  assert.deepEqual(a.state.data.paused[fileId], { path: NOTE, remote: true });
  const { pauseId } = require("../build/sync/pause.js");
  const id = await pauseId(ac, fileId);
  const control = run.server.journal.findLast((entry) => entry.file_id === id);
  assert.ok(control, "the editor-side detector must publish the shared hold");
  await applyChange(bc, control);
  assert.deepEqual(b.state.data.paused[fileId], { path: NOTE }, "the answer's author must retain the background Resume role");
  assert.equal(run.server.files.get(id).versions.length, 1, "receiving the hold cannot answer it with another control");
  await a.engine.start();
  await b.engine.start();
  for (const key of "IJKLMNOPQRST") { editor.type(key); await advance(500); editor.save(); }
  const stopped = run.versions().length;
  const stamps = stampers.map((stamper) => stamper.count);
  await advance(300_000, STEP_MS);
  assert.equal(run.versions().length, stopped, "five minutes of local stamping must post no note versions");
  assert.ok(stopped <= 4);
  assert.ok(stampers.every((stamper, index) => stamper.count > stamps[index]));
  for (const stamper of stampers) stamper.remove();
  const held = b.host.text(NOTE);
  if (reverseResume) { await b.engine.syncNow(); await a.engine.syncNow(); }
  else { await a.engine.syncNow(); await b.engine.syncNow(); }
  await run.wait(() => a.host.text(NOTE) === b.host.text(NOTE) && b.state.data.paused[fileId] === undefined);
  await advance(5000);
  for (const device of [a, b]) {
    assert.ok(device.host.text(NOTE).includes("ABCDEFGHIJKLMNOPQRST"), "all twenty characters must remain in the main note");
    const copies = copiesOf(device.host, NOTE);
    assert.equal(copies.length, 1);
    assert.equal(device.host.text(copies[0]), held, "the latest held background content must also survive");
    assert.deepEqual(device.state.data.paused, {});
    assert.equal(device.statuses.at(-1).kind, "idle");
    assert.equal(device.engine.pending.size, 0);
    assert.equal(device.engine.inFlight.size, 0);
  }
  const quiet = run.server.journal.length;
  await advance(5000);
  assert.equal(run.server.journal.length, quiet, "settlement must stay quiet");
});
