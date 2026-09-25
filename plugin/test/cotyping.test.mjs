/**
 * Two devices typing in one OPEN note at the same time (issue #135).
 *
 * WHAT THE DEVICES DID. Two desktops, the note open in the editor on both,
 * typing concurrently for about a minute: one real merge each, then a conflict
 * copy for every later version, then the merge breaker, and at the end sixteen
 * copies on each device, two DIFFERENT notes under one name, and both status
 * bars reading `idle` -- for good.
 *
 * WHAT MAKES IT THIS CASE AND NOT #110. The editor is part of the loop. A write
 * that lands under an open note while keystrokes are unsaved is merged into
 * the editor's buffer and SAVED AGAIN ("has been modified externally, merging
 * changes automatically"), so every version one device applies comes straight
 * back as a new local edit on top of it, while the user goes on typing. A test
 * that stops typing before the first merge never meets it.
 *
 * The first test is the device run, end to end. The rest pin each rule it
 * needed, one at a time, because a two-engine race proves an outcome and not
 * which line produced it.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { KEYS, STEP_MS, pair, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const { pendingPublication, pushDelete, pushFile, sidDigest } = require("../build/sync/push.js");
const { CHUNK_MAX, CHUNK_MIN } = require("../build/chunker.js");

const NOTE = "Notes/Both.md";
const enc = (text) => new TextEncoder().encode(text);
/** Three lines, so the two typists never touch the same one. */
const BASE = "# Both\nthe line nobody edits\nthe last fixed line\n";
const sentinel = (letter, count) =>
  Array.from({ length: count }, (_, index) => `${letter}${String(index + 1).padStart(3, "0")}`).join(" ");
/** Typed at the very end of the note, as the desktop did in the device run. */
const A_TEXT = sentinel("A", 36);
/** Typed at the end of line 1, starting later and finishing sooner. */
const B_TEXT = ` ${sentinel("B", 12)}`;
const B_START = 15;

const KEY_MS = 200;
const AUTOSAVE_MS = 2000;
const REACT_MS = 50;
const T0 = 1757200000000;

/**
 * Obsidian's editor over one open note, as far as sync can see it.
 *
 * Keystrokes land in a buffer and reach the disk only when the editor saves.
 * A write that arrives from outside is compared with what the editor last
 * loaded or saved: with nothing unsaved the view just reloads, and with
 * keystrokes unsaved they are carried onto the new text at the place the user
 * is typing and the result is saved -- which is the second write the sync
 * engine then sees. `place` says where this user's cursor is.
 */
class OpenEditor {
  constructor(device, timers, place) {
    this.host = device.host;
    this.place = place;
    this.loaded = this.host.text(NOTE);
    this.unsaved = "";
    this.merged = 0;
    this.show();
    this.host.on("modify", (file) => {
      if (file.path === NOTE) timers.set(() => this.external(), REACT_MS);
    });
  }

  /**
   * What the editor shows, which the host reports through `editing`: a note
   * open in an editor is one someone can be typing in, and a change to it is
   * never taken for another plugin's rewrite (issue #179).
   */
  show() {
    this.host.editors.set(NOTE, this.unsaved === "" ? this.loaded : this.place(this.loaded, this.unsaved));
  }

  type(text) {
    if (text !== "") this.host.inputAt.set(NOTE, this.host.clock);
    this.unsaved += text;
    this.show();
  }

  save() {
    // A write it has not reacted to yet is read first, as the editor does on
    // its own save: an editor that wrote over it would be deleting the other
    // device's text itself, and this test is about what SYNC does.
    this.external();
    if (this.unsaved === "") return;
    const text = this.place(this.loaded, this.unsaved);
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
    if (this.unsaved === "") return;
    this.merged++;
    this.save();
  }
}

const atEnd = (text, typed) => text + typed;
const atEndOfFirstLine = (text, typed) => {
  const end = text.indexOf("\n");
  return end < 0 ? text + typed : text.slice(0, end) + typed + text.slice(end);
};

const copies = (host) => [...host.files.keys()].filter((path) => path.includes("(conflict from")).sort();
const pulls = (host) => host.logs.filter((line) => line.startsWith("pull")).join(" | ");

/**
 * A minute of two people typing into one open note, then two minutes of
 * nobody typing: the device run of #135, in virtual time. `placeA`/`placeB`
 * say where each cursor is; `textA`/`textB` are what each types.
 */
async function session(t, { placeA, placeB, textA, textB, base = BASE, isMobileB = false }) {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB });
  // One clock for everything a device reads the time from: file mtimes, the
  // merge breaker's window, the virtual timers. A minute of typing is a
  // minute on all three.
  for (const device of [a, b]) {
    Object.defineProperty(device.host, "clock", { get: () => T0 + timers.now, set: () => undefined });
  }
  const statuses = { a: [], b: [] };
  a.engine.onStatus = (status) => statuses.a.push(status.kind);
  b.engine.onStatus = (status) => statuses.b.push(status.kind);
  // Virtual time in 10 ms steps, in slices a single wait may take.
  const advance = async (ms) => {
    const target = timers.now + ms;
    while (timers.now < target) {
      const slice = Math.min(target, timers.now + 10_000);
      await timers.run(10, () => timers.now >= slice);
    }
  };

  a.host.write(NOTE, base, a.host.clock);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text(NOTE) === base && b.state.fileByPath(NOTE) !== undefined && a.state.fileByPath(NOTE) !== undefined);
  const fileId = a.state.fileByPath(NOTE).fileId;

  const editors = { a: new OpenEditor(a, timers, placeA), b: new OpenEditor(b, timers, placeB) };
  const typedA = [...textA];
  const typedB = [...textB];
  const every = AUTOSAVE_MS / KEY_MS;
  for (let tick = 0; tick < typedA.length; tick++) {
    editors.a.type(typedA[tick] ?? "");
    const atB = tick - B_START;
    if (atB >= 0 && atB < typedB.length) editors.b.type(typedB[atB] ?? "");
    if (tick % every === every - 1) {
      editors.a.save();
      editors.b.save();
    }
    await advance(KEY_MS);
  }
  editors.a.save();
  editors.b.save();
  // Two minutes of nobody typing, then quiet windows in real time: whatever
  // the devices are going to do about it, they have done.
  await advance(120_000);
  await timers.run(STEP_MS);
  await timers.run(STEP_MS);

  const file = server.files.get(fileId);
  const decisions = (device) => device.host.logs
    .filter((line) => line.startsWith("pull"))
    .map((line) => (line.match(/decision=\S+( reason=\S+)?( role=\S+)?/) ?? [line])[0]);
  const story = [
    `desktop=${JSON.stringify(a.host.text(NOTE))}`,
    `laptop=${JSON.stringify(b.host.text(NOTE))}`,
    `copies=${copies(a.host).length}/${copies(b.host).length}`,
    `heads=${file.heads.length} versions=${file.versions.length}`,
    `head_ids=${file.heads.join(",")}`,
    `records=${a.state.fileByPath(NOTE)?.versionId}/${b.state.fileByPath(NOTE)?.versionId}`,
    `feed=${a.state.data.lastSeq}/${b.state.data.lastSeq} journal=${server.journal.at(-1)?.seq}`,
    `editor_merges=${editors.a.merged}/${editors.b.merged}`,
    `status=${statuses.a.at(-1)}/${statuses.b.at(-1)}`,
    `desktop_pulls=${decisions(a).join(",")}`,
    `laptop_pulls=${decisions(b).join(",")}`,
  ].join("\n  ");

  // The editors really were in the loop: a session in which no external
  // write ever landed under unsaved keystrokes is not this case.
  assert.ok(editors.a.merged + editors.b.merged > 0, `no write ever landed under an open editor:\n  ${story}`);
  // THE SPLIT. One note, the same bytes on both devices, one head on the
  // server and both devices standing on it: two devices on two heads are
  // split again at the next keystroke.
  assert.equal(a.host.text(NOTE), b.host.text(NOTE), `the two devices hold different notes:\n  ${story}`);
  assert.equal(file.heads.length, 1, `the note is still forked on the server:\n  ${story}`);
  assert.equal(
    a.state.fileByPath(NOTE).versionId, b.state.fileByPath(NOTE).versionId,
    `the devices stand on different heads:\n  ${story}`,
  );
  // And the same copies on both, byte for byte: a copy made on each device
  // was the dozen of #135.
  const held = (host) => copies(host).map((path) => `${path}=${host.text(path)}`);
  assert.deepEqual(held(a.host), held(b.host), `the devices hold different copies:\n  ${story}`);
  for (const path of copies(a.host)) {
    const copy = server.files.get(a.state.fileByPath(path).fileId);
    assert.equal(
      copy.versions.filter((version) => version.parents.length === 0).length, 1,
      `${path} was published by more than one device:\n  ${story}`,
    );
  }
  assert.deepEqual([statuses.a.at(-1), statuses.b.at(-1)], ["idle", "idle"], story);
  return { a, b, file, story };
}

test("two devices typing in one open note converge on one note on both", async (t) => {
  const { a, story } = await session(t, { placeA: atEnd, placeB: atEndOfFirstLine, textA: A_TEXT, textB: B_TEXT });
  // Every character both people typed, in the note itself: different lines
  // merge, so no copy at all is the honest outcome here.
  assert.ok(a.host.text(NOTE).includes(A_TEXT), `the desktop's typing is not all in the note:\n  ${story}`);
  assert.ok(a.host.text(NOTE).includes(B_TEXT), `the laptop's typing is not all in the note:\n  ${story}`);
  assert.deepEqual(copies(a.host), [], `conflict copies were made:\n  ${story}`);
});

test("desktop and mobile typing on adjacent lines retain both complete sequences without copies", async (t) => {
  const { a, story } = await session(t, {
    placeA: atEnd, placeB: atEndOfFirstLine, textA: A_TEXT, textB: B_TEXT,
    base: "# Both\n", isMobileB: true,
  });
  assert.ok(a.host.text(NOTE).includes(A_TEXT), `the desktop sequence is incomplete:\n  ${story}`);
  assert.ok(a.host.text(NOTE).includes(B_TEXT), `the phone sequence is incomplete:\n  ${story}`);
  assert.deepEqual(copies(a.host), [], `adjacent lines produced conflict copies:\n  ${story}`);
});

/**
 * THE SAME LINE. S02's second case appends to the same line on both devices.
 * Appends retain every existing character, so their additions can be joined
 * deterministically. Each keystroke is unique: loss and duplication are both
 * visible, and the main note must hold each character once with no copies.
 */
test("two devices appending on the same line converge with every keystroke once and no copies", async (t) => {
  const onLine2 = (text, typed) => {
    const lines = text.split("\n");
    lines[1] += typed;
    return lines.join("\n");
  };
  const unique = (from, count) => Array.from({ length: count }, (_, index) => String.fromCodePoint(from + index)).join("");
  const textA = unique(0x4e00, 60);
  const textB = unique(0x5000, 40);
  const { a, b, story } = await session(t, { placeA: onLine2, placeB: onLine2, textA, textB });
  for (const device of [a, b]) {
    assert.deepEqual(copies(device.host), [], `same-line appends created copies:\n  ${story}`);
    const main = [...device.host.text(NOTE)];
    for (const key of [...textA, ...textB]) {
      assert.equal(main.filter(point => point === key).length, 1,
        `a keystroke was lost or duplicated in the main note:\n  ${story}`);
    }
  }
});

// --- the rules, one at a time ------------------------------------------------

/** One version from the other device, over `rig`'s fixture keys. */
const foreign = (r, fileId, text, parents, mtime) => r.server.publish({
  fileId, path: NOTE, bytes: enc(text), mtime, parents,
  domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
});
const storms = (r) => r.host.logs.filter((line) => line.includes("reason=merge_storm"));

/**
 * THE BREAKER COUNTS A RUN, NOT A MINUTE. Eight resolutions with someone
 * typing here between every two of them are two people editing, and must
 * never trip it; six in a row after the typing stops, with the note exactly as
 * each one left it, are the loop it exists for, and must. The pair is one the
 * rule cannot see -- this device's record names a version the server does not
 * hold -- so every resolution keeps both and none of them writes the note:
 * what moves the count is the typing alone.
 */
test("repeating one foreign head does not reset the loop budget", async () => {
  const r = await rig();
  r.host.seed(NOTE, "base\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "mine\n", 2000);
  await pushFile(r.context, NOTE);
  r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: "ab".repeat(32) });
  const other = await foreign(r, base.fileId, "theirs\n", [base.versionId], 3000);
  for (let attempt = 0; attempt < 6; attempt++) await applyChange(r.context, other);
  assert.equal(storms(r).length, 1, pulls(r.host));
  assert.match(storms(r)[0], /count=6/);
  assert.ok(!r.host.logs.some((line) => line.includes("reason=independent_peer_progress")), pulls(r.host));
});

test("peer versions that incorporate our own output still consume the loop budget", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  const ours = await pushFile(r.context, NOTE);
  // A saved local edit remains unpushed while the peer keeps answering the
  // same local publication. No new local edit breaks this run of decisions.
  r.host.seed(NOTE, "ONE\ntwo\nTHREE LOCAL\n", 3000);
  let parent = ours.versionId;
  for (let word = 1; word <= 6; word++) {
    const frame = await foreign(r, base.fileId, `ONE\nTWO ${word}\nthree\n`, [parent], 4000 + word);
    parent = frame.version_id;
    await applyChange(r.context, frame);
  }
  assert.equal(storms(r).length, 1, pulls(r.host));
  assert.match(storms(r)[0], /count=6/);
  assert.ok(!r.host.logs.some((line) => line.includes("reason=independent_peer_progress")), pulls(r.host));
});

test("one typist can stop while the peer continues its independent branch", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  await pushFile(r.context, NOTE);
  let parent = base.versionId;
  for (let word = 1; word <= 8; word++) {
    r.host.clock += 1000;
    const frame = await foreign(r, base.fileId, `one\ntwo\nTHREE ${word}\n`, [parent], 3000 + word);
    parent = frame.version_id;
    assert.equal(await applyChange(r.context, frame), "merged", pulls(r.host));
    assert.equal(r.host.text(NOTE), `ONE\ntwo\nTHREE ${word}\n`);
  }
  assert.deepEqual(copies(r.host), []);
  assert.deepEqual(storms(r), []);
  assert.ok(r.host.logs.some((line) => line.includes("reason=independent_peer_progress")));
});

test("superseded typing frames neither merge nor consume the loop budget", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  await pushFile(r.context, NOTE);
  let parent = base.versionId;
  const frames = [];
  for (let word = 1; word <= 8; word++) {
    const frame = await foreign(r, base.fileId, `one\ntwo\nTHREE ${word}\n`, [parent], 3000 + word);
    frames.push(frame);
    parent = frame.version_id;
  }
  const journal = r.server.journal.length;
  for (const frame of frames.slice(0, -1)) {
    assert.equal(await applyChange(r.context, frame), "skipped");
    assert.equal(r.host.text(NOTE), "ONE\ntwo\nthree\n");
  }
  assert.equal(r.server.journal.length, journal, "old typing frames produced new merge versions");
  assert.equal(r.context.merges.size, 0, "obsolete frames consumed the merge-loop budget");
  assert.equal(await applyChange(r.context, frames.at(-1)), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), "ONE\ntwo\nTHREE 8\n");
  assert.deepEqual(copies(r.host), []);
  assert.deepEqual(storms(r), []);
});

test("the merge breaker counts resolutions in a row, and an edit here starts the count again", async () => {
  const r = await rig();
  r.host.seed(NOTE, "the line both sides start from\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "the line this device wrote\n", 2000);
  await pushFile(r.context, NOTE);
  const held = () => r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: "ab".repeat(32) });

  for (let round = 1; round <= 8; round++) {
    r.host.seed(NOTE, `the line this device wrote, edit ${round}\n`, 3000 + round);
    held();
    const frame = await foreign(r, base.fileId, `the other device, round ${round}\n`, [base.versionId], 4000 + round);
    assert.equal(await applyChange(r.context, frame), "conflict_copy", pulls(r.host));
  }
  assert.deepEqual(storms(r), [], "resolutions broken by typing tripped the breaker");

  // The typing stops. The run began at the resolution that found the last
  // edit, so five more make six in a row, and the sixth is refused.
  for (let round = 9; round <= 13; round++) {
    const frame = await foreign(r, base.fileId, `the other device, round ${round}\n`, [base.versionId], 4000 + round);
    await applyChange(r.context, frame);
  }
  assert.equal(storms(r).length, 1, `six in a row did not trip it: ${pulls(r.host)}`);
  assert.match(storms(r)[0], /count=6 window_ms=60000 counted=in_a_row_note_unchanged/);
});

/**
 * A RUN OF MERGES IS STILL A RUN. Every one of these resolutions WRITES the
 * note -- a clean merge -- and nothing is typed here. The note changes each
 * time, but only by the resolution's own hand, so the count must run: a
 * breaker that read its own writes as the user's would never stop a loop that
 * merges.
 */
test("merges that rewrite the note with nothing typed here still trip the breaker", async () => {
  const r = await rig();
  // Every edit two lines from any other: this merge reads neighbouring lines
  // as one hunk.
  const lines = Array.from({ length: 14 }, (_, index) => `l${index}`);
  const text = (upper) => `${lines.map((line, index) => (upper.includes(index) ? line.toUpperCase() : line)).join("\n")}\n`;
  r.host.seed(NOTE, text([]), 1000);
  const base = await pushFile(r.context, NOTE);
  // This device's own edit, published: every version below is a fork of it.
  r.host.seed(NOTE, text([0]), 2000);
  await pushFile(r.context, NOTE);

  const results = [];
  for (let round = 1; round <= 6; round++) {
    // Each write lands at its own moment, as real ones do.
    r.host.clock += 1000;
    const frame = await foreign(r, base.fileId, text([2 * round]), [base.versionId], 4000 + round);
    results.push(await applyChange(r.context, frame));
  }
  assert.deepEqual(results.slice(0, 5), ["merged", "merged", "merged", "merged", "merged"], pulls(r.host));
  assert.notEqual(results[5], "merged", pulls(r.host));
  assert.equal(storms(r).length, 1);
});

/**
 * A CRISS-CROSS MERGES. Both devices resolved the same fork while each held a
 * keystroke the other had not seen, so the two merges differ and share TWO
 * newest ancestors. Either one alone as the base reads the other side's half
 * of the first merge as a conflicting edit; the two merged are the base both
 * devices would have posted had neither been typing.
 */
async function crissCross(r, other) {
  r.host.seed(NOTE, "one\ntwo\nthree\nfour\nfive\n", 1000);
  const base = await pushFile(r.context, NOTE);
  const publish = (text, parents, mtime) => foreign(r, base.fileId, text, parents, mtime);
  const left = await other(base);
  const right = await publish("one\ntwo\nthree\nfour\nFIVE\n", [base.versionId], 3000);
  const MINE = "ONE a\ntwo\nthree\nfour\nFIVE\n";
  const ours = await publish(MINE, [left.version_id, right.version_id], 4000);
  const theirs = await publish("ONE\ntwo\nthree\nfour\nFIVE b\n", [left.version_id, right.version_id], 5000);
  r.host.seed(NOTE, MINE, 4000);
  r.state.setFile(NOTE, {
    fileId: base.fileId, versionId: ours.version_id, mtime: 4000, size: enc(MINE).length, sha256: await sidDigest(ours.sids),
  });
  return theirs;
}

for (const late of [false, true]) {
  test(`a merge includes the upload receipt before choosing its parents (late: ${late})`, async () => {
    const r = await rig();
    r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
    const base = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
    await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "ONE TYPED\ntwo\nthree\n", 2500);
    const other = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);
    let release, acknowledged, decided;
    const gate = new Promise((resolve) => { release = resolve; });
    const ackReady = new Promise((resolve) => { acknowledged = resolve; });
    const decision = new Promise((resolve) => { decided = resolve; });
    const post = r.transport.postVersion.bind(r.transport);
    let calls = 0;
    r.transport.postVersion = async (...args) => {
      const result = await post(...args);
      if (++calls === 1) { acknowledged(result); await gate; }
      else decided("merged_before_receipt");
      return result;
    };
    const log = r.host.log.bind(r.host);
    r.host.log = (line) => {
      log(line);
      if (line.includes("decision=waiting reason=upload_receipt")) decided("waited");
    };
    let sending;
    if (late) {
      const writer = r.host.writer.bind(r.host);
      r.host.writer = async (path) => {
        r.host.writer = writer;
        sending = pushFile(r.context, NOTE);
        await ackReady;
        return writer(path);
      };
    } else {
      sending = pushFile(r.context, NOTE);
      await ackReady;
    }
    const applying = applyChange(r.context, other);
    let observed;
    try { observed = await decision; }
    finally { release(); }
    const uploaded = await sending;
    await applying;
    assert.equal(observed, "waited", "the merge omitted an upload whose bytes it already carried");
    assert.equal(r.host.text(NOTE), "ONE TYPED\ntwo\nTHREE\n");
    assert.deepEqual(copies(r.host), []);
    const file = r.server.files.get(base.fileId);
    assert.equal(file.heads.length, 1);
    assert.deepEqual(file.versions[0].parents, [uploaded.versionId, other.version_id].sort());
  });
}

test("a delayed upload acknowledgement cannot replace a newer pulled record", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  const post = r.transport.postVersion.bind(r.transport);
  let release, arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const posted = new Promise((resolve) => { arrived = resolve; });
  r.transport.postVersion = async (...args) => {
    const result = await post(...args);
    r.transport.postVersion = post;
    arrived(result);
    await gate;
    return result;
  };
  const sending = pushFile(r.context, NOTE, true);
  const ack = await posted;
  const merged = "one\ntwo\nTHREE\n";
  const next = await foreign(r, base.fileId, merged, [ack.value.version_id], 3000);
  try {
    await applyChange(r.context, next);
    assert.equal(r.host.text(NOTE), merged);
    assert.equal(r.state.fileByPath(NOTE).versionId, next.version_id);
  } finally { release(); }
  await sending;
  assert.equal(r.state.fileByPath(NOTE).versionId, next.version_id,
    "the old upload receipt replaced the version the editor already loaded");
  r.host.seed(NOTE, "ONE TYPED\ntwo\nTHREE\n", 4000);
  await pushFile(r.context, NOTE);
  assert.deepEqual(r.server.files.get(base.fileId).versions[0].parents, [next.version_id],
    "the next keystrokes must descend from the pulled content");
});

test("a merge includes an upload completed after it read the version graph", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  await pushFile(r.context, NOTE);
  const other = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);
  const writer = r.host.writer.bind(r.host);
  let uploaded;
  r.host.writer = async (path) => {
    r.host.writer = writer;
    // Same bytes and stat, newer publication: the file recheck cannot see it,
    // and the publication promise has gone by the time the merge checks it.
    uploaded = await pushFile(r.context, NOTE, true);
    return writer(path);
  };
  await applyChange(r.context, other);
  const file = r.server.files.get(base.fileId);
  assert.equal(file.heads.length, 1, "the completed upload was left as an orphan head");
  assert.deepEqual(file.versions[0].parents, [uploaded.versionId, other.version_id].sort());
  assert.equal(r.host.text(NOTE), "ONE\ntwo\nTHREE\n");
  assert.deepEqual(copies(r.host), []);
  assert.ok(r.host.logs.some((line) => line.includes("reason=merge_parent_advanced")));
});

for (const boundary of ["write", "receipt"]) {
  test(`an editor upload inherits the pending merge at its ${boundary} boundary`, async () => {
    const r = await rig();
    r.host.seed(NOTE, "one\ntwo\nthree\nfour\nfive\n", 1000);
    const base = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, "ONE\ntwo\nthree\nfour\nfive\n", 2000);
    await pushFile(r.context, NOTE);
    const other = await foreign(r, base.fileId, "one\ntwo\nthree\nfour\nFIVE\n", [base.versionId], 3000);
    const typed = "ONE TYPED\ntwo\nthree\nfour\nFIVE\n";
    let sending, reserved, mergeId;
    const enqueue = () => {
      reserved = pendingPublication(r.context, NOTE) !== undefined;
      r.host.seed(NOTE, typed, 4000);
      sending = pushFile(r.context, NOTE);
    };
    if (boundary === "write") {
      const writer = r.host.writer.bind(r.host);
      r.host.writer = async (path) => {
        const output = await writer(path);
        return { ...output, commit: async (mtime) => {
          const landed = await output.commit(mtime);
          enqueue();
          return landed;
        } };
      };
    }
    const post = r.transport.postVersion.bind(r.transport);
    r.transport.postVersion = async (...args) => {
      const ack = await post(...args);
      if (mergeId === undefined) {
        mergeId = ack.value.version_id;
        if (boundary === "receipt") enqueue();
      }
      return ack;
    };
    await applyChange(r.context, other);
    await sending;
    const file = r.server.files.get(base.fileId);
    assert.deepEqual(file.versions[0].parents, [mergeId], "the editor upload forked from the pre-merge parent");
    assert.equal(reserved, true, "the merged bytes were visible before their publication was reserved");
    assert.equal(file.heads.length, 1);
    assert.equal(r.host.text(NOTE), typed);
    assert.deepEqual(copies(r.host), []);
  });
}

test("a delayed merge receipt cannot replace a newer recorded version", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\nfour\nfive\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\nfour\nfive\n", 2000);
  await pushFile(r.context, NOTE);
  const other = await foreign(r, base.fileId, "one\ntwo\nthree\nfour\nFIVE\n", [base.versionId], 3000);
  const post = r.transport.postVersion.bind(r.transport);
  let release, arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const posted = new Promise((resolve) => { arrived = resolve; });
  r.transport.postVersion = async (...args) => {
    const result = await post(...args);
    r.transport.postVersion = post;
    arrived(result);
    await gate;
    return result;
  };
  const merging = applyChange(r.context, other);
  const ack = await posted;
  const text = "ONE\ntwo\nTHREE TYPED\nfour\nFIVE\n";
  const next = await foreign(r, base.fileId, text, [ack.value.version_id], 4000);
  try {
    // Model a record advanced by another local lifecycle operation while the
    // receipt is withheld. Pull merges now serialize behind that receipt, so
    // waiting for a second merge before releasing it would deadlock the test.
    r.host.seed(NOTE, text, 4000);
    r.state.setFile(NOTE, { fileId: base.fileId, versionId: next.version_id,
      mtime: 4000, size: enc(text).length, sha256: await sidDigest(next.sids) });
    await r.state.save();
    assert.equal(r.host.text(NOTE), text);
    assert.equal(r.state.fileByPath(NOTE).versionId, next.version_id);
  } finally { release(); }
  await merging;
  assert.equal(r.state.fileByPath(NOTE).versionId, next.version_id,
    "the merge receipt replaced the version the editor already loaded");
  assert.equal(r.host.text(NOTE), text);
  assert.deepEqual(copies(r.host), []);
});

test("identical merged heads retain typing saved after their shared content", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\nfour\nfive\n", 1000);
  const root = await pushFile(r.context, NOTE);
  const publish = (text, parents, mtime) => foreign(r, root.fileId, text, parents, mtime);
  const left = await publish("ONE\ntwo\nthree\nfour\nfive\n", [root.versionId], 2000);
  const right = await publish("one\ntwo\nthree\nfour\nFIVE\n", [root.versionId], 3000);
  const nextLeft = await publish("ONE NEXT\ntwo\nthree\nfour\nfive\n", [left.version_id], 4000);
  const nextRight = await publish("one\ntwo\nthree\nfour\nFIVE NEXT\n", [right.version_id], 5000);
  const shared = "ONE NEXT\ntwo\nthree\nfour\nFIVE NEXT\n";
  // Each merge saw the other's new publication before its own upload was
  // acknowledged. Their bytes agree but their recorded parent pairs differ.
  const ours = await publish(shared, [left.version_id, nextRight.version_id], 6000);
  const theirs = await publish(shared, [right.version_id, nextLeft.version_id], 7000);
  r.host.seed(NOTE, shared, 6000);
  r.state.setFile(NOTE, { fileId: root.fileId, versionId: ours.version_id,
    mtime: 6000, size: enc(shared).length, sha256: await sidDigest(ours.sids) });
  const typed = "ONE NEXT TYPED\ntwo\nthree\nfour\nFIVE NEXT\n";
  r.host.seed(NOTE, typed, 8000);

  await applyChange(r.context, theirs);
  assert.equal(r.host.text(NOTE), typed, "an identical peer head displaced text typed on its shared content");
  assert.deepEqual(copies(r.host), [], "the old graph base invented an overlap between identical heads");
  const file = r.server.files.get(root.fileId);
  assert.equal(file.heads.length, 1, "the equivalent heads and typed edit settle together");
  assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
  assert.deepEqual(file.versions[0].parents, [ours.version_id, theirs.version_id].sort());
});

test("two merges of one pair merge again, on the pair merged as their base", async () => {
  const r = await rig();
  const theirs = await crissCross(r, (base) => foreign(r, base.fileId, "ONE\ntwo\nthree\nfour\nfive\n", [base.versionId], 2000));

  assert.equal(await applyChange(r.context, theirs), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), "ONE a\ntwo\nthree\nfour\nFIVE b\n");
  assert.deepEqual(copies(r.host), []);
  assert.ok(r.host.logs.some((line) => line.includes("decision=merge_base reason=criss_cross")), pulls(r.host));
});

test("a clean-looking append uses both shared ancestors without replaying their text", async () => {
  const r = await rig();
  r.host.seed(NOTE, "ab\n", 1000);
  const root = await pushFile(r.context, NOTE);
  const right = await foreign(r, root.fileId, "abR\n", [root.versionId], 2000);
  const left = await foreign(r, root.fileId, "abL\n", [root.versionId], 3000);
  const parents = [left.version_id, right.version_id];
  const ours = await foreign(r, root.fileId, "abLRx\n", parents, 4000);
  const theirs = await foreign(r, root.fileId, "abLyR\n", parents, 5000);
  const mine = r.host.seed(NOTE, "abLRx\n", 4000);
  r.state.setFile(NOTE, { fileId: root.fileId, versionId: ours.version_id,
    mtime: 4000, size: mine.length, sha256: await sidDigest(ours.sids) });
  assert.equal(await applyChange(r.context, theirs), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), "abLyRx\n", "the shared R is old text, not two independent additions");
  assert.deepEqual(copies(r.host), []);
  assert.equal(r.server.files.get(root.fileId).heads.length, 1);
});

for (const deeper of [false, true]) test(`an unresolvable shared base cannot be replaced by one ancestor (deeper: ${deeper})`, async () => {
  const r = await rig();
  r.host.seed(NOTE, "ab\n", 1000);
  const root = await pushFile(r.context, NOTE);
  let stamp = 1000;
  const post = (text, parents) => foreign(r, root.fileId, text, parents, stamp += 1000);
  const right = await post("XY\n", [root.versionId]);
  const left = await post("abL\n", [root.versionId]);
  let parents = [left.version_id, right.version_id];
  if (deeper) {
    const a = await post("abL1\n", parents), b = await post("abL2\n", parents);
    parents = [a.version_id, b.version_id];
  }
  const text = deeper ? "abL12" : "abL";
  const ours = await post(text + "x\n", parents), theirs = await post(text + "y\n", parents);
  const mine = r.host.seed(NOTE, text + "x\n", stamp - 1000);
  r.state.setFile(NOTE, { fileId: root.fileId, versionId: ours.version_id,
    mtime: stamp - 1000, size: mine.length, sha256: await sidDigest(ours.sids) });
  assert.notEqual(await applyChange(r.context, theirs), "merged", pulls(r.host));
  assert.equal(copies(r.host).length, 1);
  assert.deepEqual([r.host.text(NOTE), r.host.text(copies(r.host)[0])].sort(), [text + "x\n", text + "y\n"].sort());
});

test("typing beyond a criss-cross head is published before another merge of that pair", async () => {
  const r = await rig();
  const theirs = await crissCross(r, (base) => foreign(r, base.fileId, "ONE\ntwo\nthree\nfour\nfive\n", [base.versionId], 2000));
  const prior = r.state.fileByPath(NOTE).versionId;
  const typed = "ONE a TYPED\ntwo\nthree\nfour\nFIVE\n";
  r.host.seed(NOTE, typed, 6000);
  const count = r.server.journal.length;
  assert.equal(await applyChange(r.context, theirs), "skipped", pulls(r.host));
  assert.ok(r.host.logs.some((line) => line.includes("reason=unpublished_criss_cross")), pulls(r.host));
  assert.equal(r.server.journal.length, count, "unpublished typing made another different merge of the same pair");
  assert.equal(r.host.text(NOTE), typed);
  assert.equal(r.state.fileByPath(NOTE).versionId, prior);
  await pushFile(r.context, NOTE);
  await applyChange(r.context, theirs);
  assert.equal(r.host.text(NOTE), "ONE a TYPED\ntwo\nthree\nfour\nFIVE b\n");
  assert.deepEqual(copies(r.host), []);
  const file = r.server.files.get(r.state.fileByPath(NOTE).fileId);
  assert.equal(file.heads.length, 1);
  assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
});

/**
 * AND AGAIN. The two merges of that pair can be merged differently in turn,
 * each device holding one more keystroke, and then the two ancestors of the
 * next pair are themselves a criss-cross: their base is their own two
 * ancestors merged, one level further down. A device run that met it kept a
 * conflict copy of a note two people were typing on different lines of. Each
 * level down downloads and holds two more versions of a graph another device
 * shapes, so three levels merge and a fourth is settled by rule.
 */
test("merges of merges of one pair merge again, three levels down and no further", async () => {
  const lines = (one, five) => `${one}\ntwo\nthree\nfour\n${five}\n`;
  for (const levels of [3, 4]) {
    const r = await rig();
    r.host.seed(NOTE, lines("one", "five"), 1000);
    const base = await pushFile(r.context, NOTE);
    let mtime = 1000;
    const publish = (text, parents) => foreign(r, base.fileId, text, parents, (mtime += 1000));
    let [one, five] = ["ONE", "FIVE"];
    let ours = await publish(lines(one, "five"), [base.versionId]);
    let theirs = await publish(lines("one", five), [base.versionId]);
    // Prepend each word so the append-only rule cannot resolve directly
    // against an older base: this fixture must exercise recursive bases.
    for (let level = 1; level <= levels; level++) {
      const pair = [ours.version_id, theirs.version_id];
      ours = await publish(lines(`a${level} ${one}`, five), pair);
      theirs = await publish(lines(one, `b${level} ${five}`), pair);
      [one, five] = [`a${level} ${one}`, `b${level} ${five}`];
    }
    const mine = r.host.seed(NOTE, lines(one, five.replace(/^b\d+ /, "")), mtime);
    r.state.setFile(NOTE, {
      fileId: base.fileId, versionId: ours.version_id, mtime, size: mine.length, sha256: await sidDigest(ours.sids),
    });

    const result = await applyChange(r.context, theirs);
    if (levels === 3) {
      assert.equal(result, "merged", pulls(r.host));
      assert.equal(r.host.text(NOTE), lines(one, five));
      assert.deepEqual(copies(r.host), []);
    } else {
      assert.notEqual(result, "merged", pulls(r.host));
      assert.ok(r.host.logs.some((line) => line.includes("reason=criss_cross level=3 ok=false")), pulls(r.host));
    }
    assert.ok(!r.host.logs.some((line) => line.includes("level=4")), pulls(r.host));
  }
});

/**
 * The same shape with the second ancestor above one chunk: a merge input is
 * held whole in memory, and the version graph is another device's to shape.
 * No merge is made, none of its chunks is ever asked for, and the pair is
 * settled by rule like any other that does not merge.
 */
test("a criss-cross whose other ancestor is above one chunk is never assembled", async () => {
  const r = await rig();
  const sid = (n) => String(n).padStart(2, "0").repeat(32);
  const theirs = await crissCross(r, (base) => r.server.publishManifest({
    fileId: base.fileId,
    manifest: {
      v: 1, path: NOTE, size: CHUNK_MAX + CHUNK_MIN, mtime: 2000, domain: KEYS.domainId,
      chunks: [{ sid: sid(1), cid: sid(9), len: CHUNK_MAX }, { sid: sid(2), cid: sid(8), len: CHUNK_MIN }],
      sha256: "", deleted: false,
    },
    sids: [sid(1), sid(2)],
    parents: [base.versionId],
    deviceId: "ffffffffffffffffffffffffffffffff",
    manifestKey: r.keys.manifestKey,
    bytes: CHUNK_MAX + CHUNK_MIN,
  }));

  assert.ok(["skipped", "applied"].includes(await applyChange(r.context, theirs)), pulls(r.host));
  assert.ok(!r.host.logs.some((line) => line.includes("decision=merged")), pulls(r.host));
  assert.ok(!r.server.requests.some((request) => request.target.includes(sid(1))), "the multi-chunk ancestor was fetched");
});

/**
 * A VERSION OVER AN UNPUSHED EDIT IS THE PUSH'S TO MERGE. It descends from the
 * version this device recorded, and the note holds a keystroke not yet
 * published: 1.1.2 kept a conflict copy of it, one for every version the other
 * device sent while someone typed here. Nothing is written and nothing is
 * copied; the push that carries the edit forks the file, and that fork merges.
 */
test("a version arriving over an unpushed edit is merged by that edit's push, not copied", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  const next = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);

  assert.equal(await applyChange(r.context, next), "skipped", pulls(r.host));
  assert.equal(r.host.text(NOTE), "ONE\ntwo\nthree\n", "the unpushed edit was written over");
  assert.deepEqual(copies(r.host), [], "a version that merges was kept as a conflict copy");
  assert.ok(r.host.logs.some((line) => line.includes("decision=deferred reason=unpushed_edit")), pulls(r.host));
  assert.ok(r.context.forked.has(base.fileId), "a note waiting on its push is not counted as waiting");

  const pushed = await pushFile(r.context, NOTE);
  assert.equal(pushed.ack.conflicted, true, "the edit was not published onto the version it was made on");
  // What the push's own reconciliation then does with the other head.
  assert.equal(await applyChange(r.context, { ...next, conflicted: true }), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), "ONE\ntwo\nTHREE\n");
  assert.deepEqual(copies(r.host), []);
  assert.ok(!r.context.forked.has(base.fileId), "a settled note is still counted as waiting");
});

/**
 * The version was left to that push, so the push must happen. An edit undone
 * before it runs leaves the note holding the recorded bytes again, and a push
 * that answered `unchanged` would leave the other device's version unapplied
 * here, with nothing left to bring it in.
 */
test("an edit undone before its push still publishes, so the version it held back comes in", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  const next = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);
  assert.equal(await applyChange(r.context, next), "skipped", pulls(r.host));

  r.host.seed(NOTE, "one\ntwo\nthree\n", 2500);
  const pushed = await pushFile(r.context, NOTE);
  assert.equal(pushed.status, "pushed", "the push found the recorded bytes and published nothing");
  await applyChange(r.context, { ...next, conflicted: true });
  assert.equal(r.host.text(NOTE), "one\ntwo\nTHREE\n");
});

/**
 * An unpushed edit that is already IN the arriving version is not deferred:
 * that version is the merge, and it is adopted, record and all.
 */
test("a version that already holds the unpushed edit is adopted as it is", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "one\ntwo\nTHREE\n", 2000);
  const next = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);

  assert.equal(await applyChange(r.context, next), "applied", pulls(r.host));
  const record = r.state.fileByPath(NOTE);
  const stat = await r.host.stat(NOTE);
  assert.equal(record.versionId, next.version_id);
  assert.deepEqual([record.mtime, record.size], [stat.mtime, stat.size], "the record does not describe the note");
});

/**
 * THE NOTE IS LOOKED AT AGAIN BEFORE IT IS WRITTEN. A merge downloads its
 * inputs first, and an editor saves while someone types: a save landing in
 * between must survive, and a merge of bytes the note no longer holds must not
 * be published. The writer is where such a save lands in this fake.
 */
function saveWhenWriterOpens(r, text, mtime) {
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path) => {
    r.host.writer = writer;
    r.host.seed(NOTE, text, mtime);
    return await writer(path);
  };
}

test("a save landing while a merge downloads is not written over", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  await pushFile(r.context, NOTE);
  const fork = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);
  const SAVED = "ONE\ntwo\nthree\nand a line typed meanwhile\n";
  saveWhenWriterOpens(r, SAVED, 2500);
  const journal = r.server.journal.length;

  assert.equal(await applyChange(r.context, fork), "skipped", pulls(r.host));
  assert.equal(r.host.text(NOTE), SAVED, "the merge wrote over a save");
  assert.equal(r.server.journal.length, journal, "a merge of bytes the note no longer holds was published");
  assert.ok(r.host.logs.some((line) => line.includes("decision=deferred reason=saved_during_merge")), pulls(r.host));
  assert.ok(r.context.forked.has(base.fileId), "a note waiting on the push of that save is not counted as waiting");
});

test("a save landing while a version downloads is not written over", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  const next = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);
  saveWhenWriterOpens(r, "ONE\ntwo\nthree\n", 2500);

  assert.equal(await applyChange(r.context, next), "skipped", pulls(r.host));
  assert.equal(r.host.text(NOTE), "ONE\ntwo\nthree\n", "the version was written over a save made while it downloaded");
  assert.deepEqual(copies(r.host), [], "a save that merges was answered with a conflict copy");
  assert.ok(r.host.logs.some((line) => line.includes("decision=local_edit_kept reason=saved_during_pull")), pulls(r.host));
});

// --- a fork that does not merge, settled by rule (issue #135) ----------------

/** Two heads over one base that overlap, with this device holding `mine`. */
async function overlap(r, mine = "mine\n", theirs = "theirs\n") {
  r.host.seed(NOTE, "base\n", 1000);
  const base = await pushFile(r.context, NOTE);
  const other = await foreign(r, base.fileId, theirs, [base.versionId], 3000);
  r.host.seed(NOTE, mine, 2000);
  const ours = await pushFile(r.context, NOTE);
  return { base, ours, other, head: { ...other, heads: r.server.files.get(base.fileId).heads, conflicted: true } };
}

/** Draw forks until this device's head is the one that loses the rule. */
async function losing() {
  for (let draw = 0; draw < 64; draw++) {
    const r = await rig();
    const fork = await overlap(r);
    if (fork.ours.versionId > fork.other.version_id) return { r, ...fork };
  }
  throw new Error("no losing fork in 64 draws");
}

/**
 * A head a later version has replaced is not a pair to settle: the version
 * that replaced it is, and the feed brings it next. Settling the stale pair
 * would keep the wrong text and close a fork that is not there.
 */
test("a fork whose other head a later version has replaced is left for that version", async () => {
  const r = await rig();
  const { base, other, head } = await overlap(r);
  await foreign(r, base.fileId, "theirs, and then some\n", [other.version_id], 4000);
  const journal = r.server.journal.length;

  assert.equal(await applyChange(r.context, head), "skipped", pulls(r.host));
  assert.ok(r.host.logs.some((line) => line.includes("decision=skipped reason=superseded_head")), pulls(r.host));
  assert.equal(r.server.journal.length, journal, "a stale pair was closed");
  assert.equal(r.host.text(NOTE), "mine\n");
  assert.deepEqual(copies(r.host), []);
});

/**
 * The feed and a push's own reconciliation settle one fork side by side. On
 * the device whose head lost, only one of them may move its note: two made a
 * copy each, and the second wrote the kept version over a note the first had
 * already changed.
 */
test("two settlements of one fork at once on the losing device make one copy", async () => {
  const { r, base, head } = await losing();
  // The first to write its copy is held there until the other has finished:
  // the other must find the note already claimed and leave it alone.
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const create = r.host.createWriter.bind(r.host);
  let first = true;
  r.host.createWriter = async (path, size, check) => {
    if (first) { first = false; await gate; }
    return create(path, size, check);
  };

  const runs = [applyChange(r.context, head), applyChange(r.context, head)];
  void Promise.race(runs).then(open);
  const results = await Promise.all(runs);
  assert.ok(results.includes("applied"), results.join(","));
  assert.equal(copies(r.host).length, 1, `${JSON.stringify(copies(r.host))} ${pulls(r.host)}`);
  assert.equal(r.host.text(copies(r.host)[0]), "mine\n");
  assert.equal(r.host.text(NOTE), "theirs\n");
  // And the record says what the note is: the head that closed the fork, at
  // the note's own size and time. A second settlement undoing the first's
  // record is a note the next push publishes against the wrong parent.
  const record = r.state.fileByPath(NOTE);
  const stat = await r.host.stat(NOTE);
  assert.deepEqual(r.server.files.get(base.fileId).heads, [record.versionId], pulls(r.host));
  assert.deepEqual([record.mtime, record.size], [stat.mtime, stat.size], pulls(r.host));
});

/**
 * Text typed here on top of the losing head is in no version. It goes into the
 * copy, and the copy's record must not describe it as published: that is
 * what the watcher and the scan read to decide the copy needs a push, and a
 * copy recorded as clean keeps the text on this device alone.
 */
test("text typed on top of the losing head is published as the copy's next version", async () => {
  const { r, head } = await losing();
  const TYPED = "mine\nand a line typed here since\n";
  r.host.seed(NOTE, TYPED, 5555);

  assert.equal(await applyChange(r.context, head), "applied", pulls(r.host));
  const copy = copies(r.host)[0];
  assert.equal(r.host.text(copy), TYPED, "the text typed here is not in the copy");
  const record = r.state.fileByPath(copy);
  const stat = await r.host.stat(copy);
  assert.notDeepEqual([record.mtime, record.size, record.sha256 === ""], [stat.mtime, stat.size, false],
    "the copy is recorded as published, so nothing will push the text typed here");
  const pushed = await pushFile(r.context, copy);
  assert.equal(pushed.status, "pushed");
  const next = r.server.files.get(record.fileId).versions[0];
  assert.deepEqual(next.parents, [record.versionId], "the text was not published as the copy's next version");
});

/**
 * The losing device keeps its note in the copy BEFORE the kept version takes
 * the name, and looks again between the two: a save landing while the copy
 * is written is newer than the copy, and is never written over.
 */
test("a save landing while the losing note is copied keeps the note", async () => {
  const { r, head } = await losing();
  const SAVED = "mine, and a word typed while the copy was written\n";
  const create = r.host.createWriter.bind(r.host);
  r.host.createWriter = async (path, size, check) => {
    const writer = await create(path, size, check);
    return { ...writer, commit: async (mtime) => { const stat = await writer.commit(mtime); r.host.seed(NOTE, SAVED, 7777); return stat; } };
  };

  assert.equal(await applyChange(r.context, head), "skipped", pulls(r.host));
  assert.equal(r.host.text(NOTE), SAVED, "the kept version was written over a save");
  assert.ok(r.host.logs.some((line) => line.includes("decision=deferred reason=saved_during_copy")), pulls(r.host));
});

/**
 * NEVER `syncing` FOR GOOD. A note waiting on this device's own push counts as
 * work only while that push is in flight. Nothing in flight -- a push that
 * never came, or a fork waiting for later work -- must come to rest,
 * or the status bar reads `syncing` forever over nothing happening.
 */
test("a file left with two heads, or a note whose push is not in flight, comes to rest", async (t) => {
  const { server, timers, a, keys: k } = await pair(t);
  const statuses = [];
  a.engine.onStatus = (status) => statuses.push(status);
  const OTHER = "Notes/Other.md";
  a.host.write(NOTE, "base\n", 1000);
  a.host.write(OTHER, "one\ntwo\nthree\n", 1000);
  await a.engine.start();
  await timers.run(STEP_MS, () => a.state.fileByPath(NOTE) !== undefined && a.state.fileByPath(OTHER) !== undefined);
  const note = a.state.fileByPath(NOTE);
  const other = a.state.fileByPath(OTHER);
  const keys = { domainKey: k.domainKey, manifestKey: k.manifestKey };

  // A deletion over an edit settles to one live head (#178).
  a.host.seed(NOTE, "base, edited here\n", 2000);
  await server.publishTombstone({ fileId: note.fileId, path: NOTE, manifestKey: k.manifestKey, parents: [note.versionId] });
  // And a note left for a push that nothing has queued: edited with no event.
  a.host.seed(OTHER, "ONE\ntwo\nthree\n", 2000);
  await server.publish({ fileId: other.fileId, path: OTHER, bytes: enc("one\ntwo\nTHREE\n"), mtime: 3000, parents: [other.versionId], ...keys });
  await timers.run(STEP_MS, () => a.host.logs.some((line) => line.includes("decision=deferred reason=unpushed_edit")));
  await timers.run(STEP_MS);

  assert.equal(server.files.get(note.fileId).heads.length, 1, "delete-versus-edit has settled (#178)");
  assert.deepEqual(statuses.at(-1), { kind: "idle" }, JSON.stringify(statuses.slice(-4)));
  assert.equal(a.engine.context.forked.size, 0, "a note with nothing in flight is still counted");
});


/**
 * A NOTE DELETED HERE IS NOT A SAVE MADE DURING THE PULL (issue #173 on top
 * of #135). The last-moment check refuses to write over a note whose bytes
 * moved; a note that is gone has no bytes to lose, and delete versus edit
 * keeps the edit. So the edit lands, the note comes back, and the deletion
 * this device has not sent yet finds it here and is no deletion at all: one
 * head, the edit on it.
 */
test("a note deleted here and edited elsewhere before the deletion is sent comes back with the edit", async () => {
  const r = await rig();
  r.host.seed(NOTE, "base\n", 1000);
  const created = await pushFile(r.context, NOTE);
  r.host.files.delete(NOTE);
  const edit = await foreign(r, created.fileId, "base\nand an edit made elsewhere\n", [created.versionId], 3000);

  assert.equal(await applyChange(r.context, edit), "applied", pulls(r.host));
  assert.equal(r.host.text(NOTE), "base\nand an edit made elsewhere\n", "the edit did not bring the note back");
  assert.equal(r.state.fileByPath(NOTE).versionId, edit.version_id);
  assert.equal(await pushDelete(r.context, NOTE), null, "a deletion was sent for a note that is back");
  assert.deepEqual(r.server.files.get(created.fileId).heads, [edit.version_id], "the file forked on the server");
  assert.ok(!r.server.journal.some((frame) => frame.deleted));
});
