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
import { DEVICE_B, FakeHost, KEYS, SECRET_B, STEP_MS, fakeState, pair, rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { EditorBusy, applyChange } = require("../build/sync/pull.js");
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
 * What the server lists of a file: its ten newest versions and every head
 * (`OBSYNC_RETENTION_VERSIONS`), the rest read one at a time, and counted.
 */
function listing(transport) {
  const getFile = transport.getFile.bind(transport), getVersion = transport.getVersion.bind(transport);
  const seen = { reads: [] };
  transport.getFile = async (...args) => {
    const file = await getFile(...args);
    return { ...file, versions: file.versions.filter((version, at) => at < 10 || file.heads.includes(version.version_id)) };
  };
  transport.getVersion = async (fileId, id, ...rest) => { seen.reads.push(id); return getVersion(fileId, id, ...rest); };
  return seen;
}

/**
 * The host's own refusal: nothing is written to a note someone is typing in,
 * or whose editor holds what its file does not (`main.ts`, `assertEditorIdle`).
 */
function refusing(host, busy = async (path) => host.editors.has(path) && (host.typing(path) || await host.editing(path) === "unsaved")) {
  const writer = host.writer.bind(host);
  const refused = { count: 0 };
  host.writer = async (path, size) => {
    const output = await writer(path, size);
    return { ...output, commit: async (mtime) => {
      if (await busy(path)) { refused.count++; throw new EditorBusy(); }
      return output.commit(mtime);
    } };
  };
  return refused;
}

/**
 * A minute of two people typing into one open note, then two minutes of
 * nobody typing: the device run of #135, in virtual time. `placeA`/`placeB`
 * say where each cursor is; `textA`/`textB` are what each types. `host` is
 * the run as Obsidian 1.13 and the server make it (#227): a save a keystroke,
 * the server's listing, and no write under an open editor.
 */
async function session(t, { placeA, placeB, textA, textB, base = BASE, isMobileB = false, host = false }) {
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB });
  // One clock for everything a device reads the time from: file mtimes, the
  // merge breaker's window, the virtual timers. A minute of typing is a
  // minute on all three.
  for (const device of [a, b]) {
    Object.defineProperty(device.host, "clock", { get: () => T0 + timers.now, set: () => undefined });
  }
  const refused = host ? [refusing(a.host), refusing(b.host)] : [];
  for (const [index, device] of [a, b].entries()) {
    if (host) {
      listing(device.transport);
      const ready = device.host.editorReady.bind(device.host);
      device.host.editorReady = async (path) => {
        const allowed = await ready(path);
        if (!allowed) refused[index].count++;
        return allowed;
      };
    } else {
      // Deliberately permissive legacy host: this case exercises a native
      // merge under unsaved input. The guarded host cases count refusals at
      // both the preparation and final-commit boundaries.
      device.host.editorReady = async () => true;
    }
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
  if (!host) {
    // Exercise the permissive legacy host's unsaved-input merge deliberately.
    // A faster publication path can otherwise land every write in a saved
    // gap and make this test's required branch depend on crypto scheduling.
    const writer = a.host.writer.bind(a.host), type = editors.a.type.bind(editors.a);
    let release, delayed = false;
    editors.a.type = (text) => { type(text); if (text && release) { release(); release = null; } };
    a.host.writer = async (...args) => {
      const output = await writer(...args);
      return { ...output, commit: async (...commitArgs) => {
        if (args[0] === NOTE && !delayed) {
          delayed = true;
          await new Promise((resolve) => { release = resolve; });
          assert.notEqual(editors.a.unsaved, "", "legacy incoming write meets real pending input");
        }
        return output.commit(...commitArgs);
      } };
    };
    t.after(() => release?.());
  }
  const typedA = [...textA];
  const typedB = [...textB];
  const every = host ? 1 : AUTOSAVE_MS / KEY_MS;
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
    `refused=${refused.map((device) => device.count).join("/")}`,
    `status=${statuses.a.at(-1)}/${statuses.b.at(-1)}`,
    `desktop_pulls=${decisions(a).join(",")}`,
    `laptop_pulls=${decisions(b).join(",")}`,
  ].join("\n  ");

  // The editors really were in the loop: a session in which no external
  // write ever landed under unsaved keystrokes is not this case -- nor, on
  // the host that refuses those writes, one in which none was refused.
  if (host) assert.ok(refused.every((device) => device.count > 0), `no write was refused under an open editor:\n  ${story}`);
  else assert.ok(editors.a.merged + editors.b.merged > 0, `no write ever landed under an open editor:\n  ${story}`);
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
 * AS OBSIDIAN AND THE SERVER MAKE IT (issue #227). Obsidian 1.13 saves a note
 * a keystroke after it is typed, the server lists ten versions and every head,
 * and nothing is written to a note someone is typing in: neither device merges
 * until the typing stops, and the fork grows by a version a keystroke. Two
 * desktops typing so on 2026-09-27 kept forty-six conflict copies, and one
 * person's typing was in them and not in the note.
 */
test("two devices saving every keystroke into one open note keep both sequences without copies (#227)", async (t) => {
  const textB = ` ${sentinel("B", 16)}`;
  const { a, story } = await session(t, { placeA: atEnd, placeB: atEndOfFirstLine, textA: sentinel("A", 20), textB, host: true });
  assert.ok(a.host.text(NOTE).includes(sentinel("A", 20)), `the desktop's typing is not all in the note:\n  ${story}`);
  assert.ok(a.host.text(NOTE).includes(textB), `the laptop's typing is not all in the note:\n  ${story}`);
  assert.deepEqual(copies(a.host), [], `conflict copies were made:\n  ${story}`);
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

for (const isMobile of [false, true]) test(`prefix and word-boundary edits reconcile into one encrypted history (${isMobile ? "mobile" : "desktop"})`, async () => {
  for (const [original, left, right, expected] of [
    ["ABCDEFGHIJKL", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"],
    ["# Both", "# Both A001 A002", "# Both B001 B002", "# Both A001 A002 B001 B002"],
  ]) {
    const r = await rig({ isMobile });
    r.host.seed(NOTE, original, 1000);
    const base = await pushFile(r.context, NOTE);
    r.host.seed(NOTE, left, 2000);
    await pushFile(r.context, NOTE);
    const incoming = await foreign(r, base.fileId, right, [base.versionId], 3000);
    assert.equal(await applyChange(r.context, incoming), "merged", pulls(r.host));
    assert.equal(r.host.text(NOTE), expected);
    assert.ok(r.host.logs.some(line => /^pull decision=merged .* duration_ms=[0-9]+ announced=(true|false)$/.test(line)), pulls(r.host));
    assert.deepEqual(copies(r.host), []);
    const file = r.server.files.get(base.fileId);
    assert.equal(file.heads.length, 1);
    assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
    r.host.seed(NOTE, expected + "!", 4000);
    await pushFile(r.context, NOTE);
    assert.equal(r.server.files.get(base.fileId).heads.length, 1);
    assert.deepEqual(copies(r.host), []);
  }
});

test("a refused text merge reports typing state and elapsed time without note text", async () => {
  const r = await rig();
  const { head } = await overlap(r);
  await applyChange(r.context, head);
  assert.ok(r.host.logs.some(line => /^pull decision=unmerged reason=overlap file=[a-f0-9]+ typing=false duration_ms=[0-9]+$/.test(line)), pulls(r.host));
});

for (const isMobile of [false, true]) test(`continued adjacent appends reconcile without copies (${isMobile ? "mobile" : "desktop"})`, async () => {
  const r = await rig({ isMobile });
  r.host.seed(NOTE, "Desktop: START\nPhone: START", 1000);
  const base = await pushFile(r.context, NOTE);
  // A third receiver can combine both typists' early additions before either
  // sees it. Each later branch then changes both lines relative to this base.
  r.host.seed(NOTE, "Desktop: STARTABC\nPhone: STARTab", 2000);
  await pushFile(r.context, NOTE);
  const incoming = await foreign(r, base.fileId, "Desktop: STARTAB\nPhone: STARTabc", [base.versionId], 3000);
  assert.equal(await applyChange(r.context, incoming), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), "Desktop: STARTABC\nPhone: STARTabc");
  assert.deepEqual(copies(r.host), []);
  assert.deepEqual(storms(r), []);
  const file = r.server.files.get(base.fileId);
  assert.equal(file.heads.length, 1);
  assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
  // An ordinary follow-up must keep the common result and advance that head.
  r.host.seed(NOTE, "Desktop: STARTABCD\nPhone: STARTabc", 4000);
  await pushFile(r.context, NOTE);
  assert.equal(r.server.files.get(base.fileId).heads.length, 1);
  assert.deepEqual(copies(r.host), []);
});

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

for (const sameLine of [false, true]) test(`a passive third device merges alternating progress from two independent typists (${sameLine ? "same line" : "adjacent lines"})`, async () => {
  const r = await rig();
  const textAt = (a, b) => sameLine ? `Shared: START|${"A".repeat(a)}${"b".repeat(b)}`
    : `Desktop: START${"A".repeat(a)}\nPhone: START${"b".repeat(b)}`;
  const baseText = textAt(0, 0);
  r.host.seed(NOTE, baseText, 1000);
  const base = await pushFile(r.context, NOTE);
  const parents = [base.versionId, base.versionId];
  for (let count = 1; count <= 12; count++) {
    for (const side of [0, 1]) {
      r.host.clock += 1000;
      const text = side === 0 ? textAt(count, 0) : textAt(0, count);
      const frame = await r.server.publish({ fileId: base.fileId, path: NOTE, bytes: enc(text),
        mtime: 2000 + 2 * count + side, parents: [parents[side]],
        deviceId: (side === 0 ? "ab" : "cd").repeat(16),
        domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
      parents[side] = frame.version_id;
      await applyChange(r.context, frame);
    }
    assert.equal(r.host.text(NOTE), textAt(count, count), pulls(r.host));
    assert.deepEqual(copies(r.host), [], pulls(r.host));
    assert.deepEqual(storms(r), [], pulls(r.host));
  }
  assert.equal(r.server.files.get(base.fileId).heads.length, 1);
});

test("alternating authors do not exempt a feedback loop and forgotten authors leave no bookkeeping", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  const ours = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "ONE\ntwo\nTHREE LOCAL\n", 3000);
  let parent = ours.versionId;
  for (let round = 1; round <= 6; round++) {
    const frame = await r.server.publish({ fileId: ours.fileId, path: NOTE,
      bytes: enc(`ONE\nTWO ${round}\nthree\n`), mtime: 4000 + round,
      parents: [parent], deviceId: (round % 2 ? "ab" : "cd").repeat(16),
      domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
    parent = frame.version_id;
    await applyChange(r.context, frame);
  }
  assert.equal(storms(r).length, 1, pulls(r.host));
  assert.ok(!r.host.logs.some(line => line.includes("reason=independent_peer_progress")));
  // Retention can forget an inactive author. Keep no per-author entry whose
  // version the received graph no longer carries, even during a refused loop.
  const tally = r.context.merges.get(ours.fileId);
  tally.remote.set("ee".repeat(16), "ff".repeat(32));
  const last = await foreign(r, ours.fileId, "ONE\nTWO 7\nthree\n", [parent], 5000);
  await applyChange(r.context, last);
  assert.ok(!tally.remote.has("ee".repeat(16)), "forgotten graph ancestry was retained");
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
    // Typing is published before any merge of it (#227), so an upload that
    // starts once the merge is writing re-sends bytes already published: a
    // rename's, or one onto a restored server's head.
    if (late) await pushFile(r.context, NOTE);
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
        sending = pushFile(r.context, NOTE, true);
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

  // The typing goes out first, on the head it was typed on (#227), and nothing
  // of it is written over or copied meanwhile.
  assert.equal(await applyChange(r.context, theirs), "skipped", pulls(r.host));
  assert.ok(r.host.logs.some((line) => line.includes("decision=deferred reason=unpublished_edit")), pulls(r.host));
  assert.equal(r.host.text(NOTE), typed, "an identical peer head displaced text typed on its shared content");
  assert.deepEqual(copies(r.host), [], "the old graph base invented an overlap between identical heads");
  const pushed = await pushFile(r.context, NOTE);
  await applyChange(r.context, theirs);
  assert.equal(r.host.text(NOTE), typed, "an identical peer head displaced text typed on its shared content");
  assert.deepEqual(copies(r.host), [], "the old graph base invented an overlap between identical heads");
  const file = r.server.files.get(root.fileId);
  assert.equal(file.heads.length, 1, "the equivalent heads and typed edit settle together");
  assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
  assert.deepEqual(file.versions[0].parents, [pushed.versionId, theirs.version_id].sort());
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

/** The other typist: a second device on `r`'s server, driven by hand as `r` is. */
async function peer(r) {
  const { Transport } = require("../build/transport.js");
  const host = new FakeHost({ deviceName: "laptop" });
  const { state } = await fakeState();
  state.data.deviceId = DEVICE_B;
  state.data.deviceSecret = SECRET_B;
  r.server.addDevice(DEVICE_B, SECRET_B, "laptop", "macos");
  const transport = new Transport({
    request: r.server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: DEVICE_B, secret: Uint8Array.from(Buffer.from(SECRET_B, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const context = {
    ...r.context, state, transport, host, deviceId: DEVICE_B,
    authored: new Set(), written: new Set(), trashed: new Set(), moved: new Set(), createdFolders: new Set(),
    refused: new Set(), merges: new Map(), pushedAt: new Map(), answering: new Map(), arrivals: new Map(),
    forked: new Set(), deviceNames: new Map(), now: () => host.clock,
  };
  return { host, state, transport, context };
}

/**
 * THE INTERLEAVING OF ISSUE #227. Two typists on two lines each resolve the
 * same fork at once, and each holds a save its push has not sent yet: the
 * watcher sends a save 150 ms after the editor writes it, and a feed record
 * or the push's own reconciliation lands inside that window. A merge made
 * then carried the unsent text, so the two devices posted two different
 * merges of one pair -- a criss-cross, one level deeper each round while both
 * typed, until three levels found at once refused it and one typist's line
 * was settled into a copy (CI, 1.1.4 train: `A0A015`, `A01012`). A merge holds
 * its two parents and nothing else; the typing goes out first, and the fork it
 * makes merges to one version on both devices.
 */
test("two devices merging one fork while each holds an unsent save post one merge of it (#227)", async () => {
  const x = await rig();
  const y = await peer(x);
  const lines = (one, last) => `# Both${one}\nthe line nobody edits\nthe last fixed line\n${last}`;
  const frame = (id) => x.server.journal.find((entry) => entry.version_id === id);
  x.host.seed(NOTE, lines("", ""), 1000);
  const base = await pushFile(x.context, NOTE);
  assert.equal(await applyChange(y.context, frame(base.versionId)), "applied", pulls(y.host));

  // Each device resolves the fork at once: neither posts until both have
  // read it and either reached their post or finished.
  const together = async (fromX, fromY) => {
    let open, reached = 0;
    const gate = new Promise((resolve) => { open = resolve; });
    const arrive = () => { if (++reached === 2) open(); };
    const posts = [x, y].map((device) => device.transport.postVersion);
    for (const device of [x, y]) {
      const post = device.transport.postVersion.bind(device.transport);
      device.transport.postVersion = async (...args) => { arrive(); await gate; return post(...args); };
    }
    try {
      return await Promise.all([
        applyChange(x.context, frame(fromY)).finally(arrive),
        applyChange(y.context, frame(fromX)).finally(arrive),
      ]);
    } finally { [x.transport.postVersion, y.transport.postVersion] = posts; }
  };
  // Each types and sends a save, then types again and saves; the second save
  // is not sent yet when the other's first arrives.
  x.host.seed(NOTE, lines("", "A001"), 2000);
  const sentX = await pushFile(x.context, NOTE);
  y.host.seed(NOTE, lines(" B001", ""), 2000);
  const sentY = await pushFile(y.context, NOTE);
  x.host.seed(NOTE, lines("", "A001 A002"), 3000);
  y.host.seed(NOTE, lines(" B001 B002", ""), 3000);
  await together(sentX.versionId, sentY.versionId);

  const file = x.server.files.get(base.fileId);
  const pair = [sentX.versionId, sentY.versionId].sort().join();
  const merges = file.versions.filter((version) => [...version.parents].sort().join() === pair);
  assert.ok(merges.length <= 1, `two merges of one pair, a criss-cross:\n  ${pulls(x.host)}\n  ${pulls(y.host)}`);
  for (const device of [x, y]) {
    assert.ok(device.host.logs.some((line) => /decision=deferred reason=unpublished_edit .*age_ms=-?\d+ duration_ms=\d+ budget_ms=10000/.test(line)),
      pulls(device.host));
  }
  assert.equal(x.host.text(NOTE), lines("", "A001 A002"), "the unsent save here was written over");
  assert.equal(y.host.text(NOTE), lines(" B001 B002", ""), "the unsent save there was written over");

  // The typing goes out, and the fork it makes merges to one version on both.
  const nextX = await pushFile(x.context, NOTE);
  const nextY = await pushFile(y.context, NOTE);
  assert.deepEqual(await together(nextX.versionId, nextY.versionId), ["merged", "merged"], `${pulls(x.host)}\n  ${pulls(y.host)}`);
  const done = x.server.files.get(base.fileId);
  assert.equal(done.heads.length, 1, "the two merges of the typed pair were not one version");
  for (const device of [x, y]) {
    assert.equal(device.host.text(NOTE), lines(" B001 B002", "A001 A002"));
    assert.equal(device.state.fileByPath(NOTE).versionId, done.heads[0]);
    assert.deepEqual(copies(device.host), []);
  }
});

/**
 * What goes out first is only text no version holds (#227). An incoming
 * version that already holds the unsent save, and more, is taken as it is and
 * nothing is posted; a head without a plaintext digest (an older plugin's)
 * cannot be compared with the note, and is merged as before.
 */
test("an incoming version that holds the unsent save is taken, and a head without a digest is merged (#227)", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const first = await pushFile(r.context, NOTE);
  await pushFile(r.context, NOTE, true);
  r.host.seed(NOTE, "one\ntwo\nTHREE\n", 2000);
  const theirs = await foreign(r, first.fileId, "ONE\ntwo\nTHREE\n", [first.versionId], 3000);
  const posted = r.server.journal.length;
  assert.equal(await applyChange(r.context, theirs), "applied", pulls(r.host));
  assert.equal(r.server.journal.length, posted, "a version was posted for text the incoming version holds");
  assert.equal(r.host.text(NOTE), "ONE\ntwo\nTHREE\n");
  assert.equal(r.state.fileByPath(NOTE).versionId, theirs.version_id);

  const { encryptChunk, hex } = require("../build/crypto.js");
  const old = await rig();
  old.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const root = await pushFile(old.context, NOTE);
  const bytes = enc("ONE\ntwo\nthree\n");
  const { cid, sid, ciphertext } = await encryptChunk(old.keys.domainKey, bytes);
  old.server.chunks.set(sid, ciphertext);
  const legacy = await old.server.publishManifest({
    fileId: root.fileId, sids: [sid], parents: [root.versionId], deviceId: KEYS.deviceId, manifestKey: old.keys.manifestKey, bytes: bytes.length,
    manifest: { v: 1, path: NOTE, size: bytes.length, mtime: 2000, domain: KEYS.domainId, chunks: [{ sid, cid: hex(cid), len: bytes.length }], sha256: "", deleted: false },
  });
  old.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  old.state.setFile(NOTE, { fileId: root.fileId, versionId: legacy.version_id, mtime: 2000, size: bytes.length, sha256: await sidDigest([sid]) });
  const other = await foreign(old, root.fileId, "one\ntwo\nTHREE\n", [root.versionId], 3000);
  assert.equal(await applyChange(old.context, other), "merged", pulls(old.host));
  assert.equal(old.host.text(NOTE), "ONE\ntwo\nTHREE\n");
});

/**
 * A THIRD DEVICE, OPEN AND IDLE WHILE TWO TYPE (issue #227, live 2026-09-29).
 * Nothing stops its writes, so it merges every arrival, each against a base
 * the server's listing holds: it never walked the ancestry, and remembered
 * none of it. When the typists stopped, one merged the third device's merge
 * with its own newer typing while the third merged that typist's older
 * version: two heads sharing two ancestors, whose base lies across the whole
 * history of the other typist's line. Read version by version it passed the
 * budget, the base was refused, and the pair was settled by rule: the words
 * that typist wrote last went into a copy. What a resolution is shown is
 * remembered, as what it reads is, so that base costs no read.
 */
test("a device that merged every arrival remembers what it was shown, and merges the criss-cross over the whole history (#227)", async () => {
  const r = await rig();
  const seen = listing(r.transport);
  const lines = (one, last) => `# Both${one}\nthe line nobody edits\nthe last fixed line\n${last}`;
  r.host.seed(NOTE, lines("", ""), 1000);
  const base = await pushFile(r.context, NOTE);
  let stamp = 1000;
  const publish = (text, parents, deviceId) => r.server.publish({ fileId: base.fileId, path: NOTE, bytes: enc(text), mtime: stamp += 1000,
    parents, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey, deviceId });
  const [LAPTOP, DESKTOP] = ["1a".repeat(16), "2b".repeat(16)];
  let a = "", b = "", laptop = base.versionId, desktop = base.versionId;
  for (let k = 1; k <= 36; k++) {
    a += `${k === 1 ? "" : " "}A${k}`;
    b += ` B${k}`;
    laptop = (await publish(lines("", a), [laptop], LAPTOP)).version_id;
    assert.equal(await applyChange(r.context, r.server.journal.at(-1)), k === 1 ? "applied" : "merged", pulls(r.host));
    desktop = (await publish(lines(b, ""), [desktop], DESKTOP)).version_id;
    assert.equal(await applyChange(r.context, r.server.journal.at(-1)), "merged", pulls(r.host));
  }
  const walked = seen.reads.length;
  // The desktop types on, and this device merges that older version ...
  const older = await publish(lines(`${b} B37`, ""), [desktop], DESKTOP);
  const shown = r.state.fileByPath(NOTE).versionId;
  assert.equal(await applyChange(r.context, older), "merged", pulls(r.host));
  // ... while the laptop types on, which this device has not taken yet, and
  // the desktop merges this device's previous merge with its newer typing.
  for (let k = 37, more = a; k <= 46; k++) {
    more += ` A${k}`;
    laptop = (await publish(lines("", more), [laptop], LAPTOP)).version_id;
  }
  const newer = await publish(lines(`${b} B37 B38`, ""), [older.version_id], DESKTOP);
  const theirs = await publish(lines(`${b} B37 B38`, a), [shown, newer.version_id], DESKTOP);
  // Their merge already holds this device's: it is taken as it is.
  assert.equal(await applyChange(r.context, theirs), "applied", pulls(r.host));
  assert.equal(r.host.text(NOTE), lines(`${b} B37 B38`, a));
  assert.deepEqual(copies(r.host), [], pulls(r.host));
  assert.ok(r.host.logs.some((line) => line.includes("reason=criss_cross level=1 ok=true")), pulls(r.host));
  assert.ok(!r.host.logs.some((line) => line.includes("reason=merge_ancestry_limit")), pulls(r.host));
  assert.ok(seen.reads.length - walked <= 2, `the criss-cross read ${seen.reads.length - walked} versions it had been shown`);
});

/**
 * Two typists, on the first line and the last, who each resolve every fork at
 * once while holding a keystroke the other has not seen: each round is a
 * criss-cross one level above the last. `climb(n)` adds `n` rounds and leaves
 * this device on its own side of the last one, that side's text in the note.
 * Each word is PREPENDED, so the append-only rule cannot resolve against an
 * older base: this fixture must exercise recursive bases. `filler` is the
 * second line, which nobody edits.
 */
async function ladder(r, path = NOTE, filler = "two") {
  const lines = (one, five) => `${one}\n${filler}\nthree\nfour\n${five}\n`;
  r.host.seed(path, lines("one", "five"), 1000);
  const base = await pushFile(r.context, path);
  let mtime = 1000;
  const publish = (text, parents) => r.server.publish({
    fileId: base.fileId, path, bytes: enc(text), mtime: (mtime += 1000), parents,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  let [one, five] = ["ONE", "FIVE"];
  let ours = await publish(lines(one, "five"), [base.versionId]);
  let theirs = await publish(lines("one", five), [base.versionId]);
  let level = 0;
  return async (rounds) => {
    for (const top = level + rounds; level < top;) {
      level++;
      const pair = [ours.version_id, theirs.version_id];
      ours = await publish(lines(`a${level} ${one}`, five), pair);
      theirs = await publish(lines(one, `b${level} ${five}`), pair);
      [one, five] = [`a${level} ${one}`, `b${level} ${five}`];
    }
    const mine = r.host.seed(path, lines(one, five.replace(/^b\d+ /, "")), mtime);
    r.state.setFile(path, {
      fileId: base.fileId, versionId: ours.version_id, mtime, size: mine.length, sha256: await sidDigest(ours.sids),
    });
    return { ours, theirs, one, five, lines, publish, fileId: base.fileId };
  };
}

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
  for (const levels of [3, 4]) {
    const r = await rig();
    const { theirs, one, five, lines } = await (await ladder(r))(levels);

    const result = await applyChange(r.context, theirs);
    if (levels === 3) {
      assert.equal(result, "merged", pulls(r.host));
      assert.equal(r.host.text(NOTE), lines(one, five));
      assert.deepEqual(copies(r.host), []);
    } else {
      assert.notEqual(result, "merged", pulls(r.host));
      assert.ok(r.host.logs.some((line) => line.includes("reason=criss_cross level=3 ok=false")), pulls(r.host));
    }
    assert.ok(!r.host.logs.some((line) => line.includes("reason=criss_cross level=4")), pulls(r.host));
    assert.equal(r.host.logs.some((line) => line.includes("reason=history_budget level=4 budget_levels=3")), levels === 4,
      "the refused fourth level is reported without traversing or merging it");
  }
});

/**
 * THE ROUND AFTER (issue #227). Two people typing on different lines, each
 * device resolving every fork at once: this device merges a pair three levels
 * down, and meanwhile the phone merged that SAME pair holding its next
 * keystroke while the desktop typed its own onto its merge. The next fork's
 * base is that pair's base one level down, so this walk is four levels deep.
 * Walked from the bottom again it was refused, and the fork was settled by
 * rule: one device's saved typing went into a copy and out of the note it was
 * being typed in (the co-typing run on a busy CI machine, 2026-09-27). The
 * base of that pair was found one round ago, and a version never changes.
 */
test("a criss-cross one level deeper every round keeps merging while both type (#227)", async () => {
  const r = await rig();
  const { ours, theirs, one, five, lines, publish, fileId } = await (await ladder(r))(3);
  assert.equal(await applyChange(r.context, theirs), "merged", pulls(r.host));
  const phone = await publish(lines(one, `b4 ${five}`), [ours.version_id, theirs.version_id]);
  r.host.seed(NOTE, lines(`a4 ${one}`, five), 9000);
  await pushFile(r.context, NOTE);

  assert.equal(await applyChange(r.context, phone), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), lines(`a4 ${one}`, `b4 ${five}`));
  assert.deepEqual(copies(r.host), []);
  const file = r.server.files.get(fileId);
  assert.equal(file.heads.length, 1);
  assert.equal(r.state.fileByPath(NOTE).versionId, file.heads[0]);
  assert.ok(r.host.logs.some((line) => /reason=criss_cross level=2 ok=true found=before/.test(line)), pulls(r.host));
  assert.ok(!r.host.logs.some((line) => line.includes("ok=false")), pulls(r.host));
});

/**
 * The bound is on the levels ONE resolution walks, and a level found before is
 * no walk: a device that resolved the first round and then met the fourth
 * finds the rest at the bound itself. A device that never met the first round
 * still settles a fourth by rule (above).
 */
test("a level found in an earlier round is not walked again, even at the bound (#227)", async () => {
  const r = await rig();
  const climb = await ladder(r);
  assert.equal(await applyChange(r.context, (await climb(1)).theirs), "merged", pulls(r.host));
  const { theirs, one, five, lines } = await climb(3);

  assert.equal(await applyChange(r.context, theirs), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), lines(one, five));
  assert.deepEqual(copies(r.host), []);
  assert.ok(r.host.logs.some((line) => line.includes("reason=criss_cross level=4 ok=true found=before")), pulls(r.host));
});

/**
 * What is remembered is bounded by what one merge holds: the newest bases,
 * together no longer than one chunk of text, the oldest forgotten first. A
 * note whose base fills a chunk leaves no room for the one found before it,
 * which is then walked from the bottom again, as a device that never met it.
 */
test("a saved editor reuses a verified parent merge across skipped criss-cross levels", async () => {
  const r = await rig(), climb = await ladder(r);
  r.host.typing = () => true;
  r.host.editorReady = async () => true;
  assert.equal(await applyChange(r.context, (await climb(3)).theirs), "merged", pulls(r.host));
  const { theirs, one, five, lines } = await climb(4);
  assert.equal(await applyChange(r.context, theirs), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), lines(one, five));
  assert.deepEqual(copies(r.host), []);
  assert.ok(r.host.logs.some((line) => line.includes("found=verified_merge")), pulls(r.host));
});

test("remembered bases hold one merge input's worth, the oldest forgotten first (#227)", async () => {
  const r = await rig();
  // A 4 KiB base, then one 2 KiB short of a chunk: together over it, while
  // every text of either ladder stays inside one chunk.
  const small = await ladder(r, NOTE, "t".repeat(4096));
  assert.equal(await applyChange(r.context, (await small(1)).theirs), "merged", pulls(r.host));
  const BIG = "Notes/Big.md";
  const big = await ladder(r, BIG, "x".repeat(CHUNK_MAX - 2048));
  assert.equal(await applyChange(r.context, (await big(1)).theirs), "merged", pulls(r.host));
  const { theirs } = await small(3);

  assert.notEqual(await applyChange(r.context, theirs), "merged", pulls(r.host));
  assert.ok(r.host.logs.some((line) => line.includes("reason=criss_cross level=3 ok=false")), pulls(r.host));
  // The newest is kept: the big note's next rounds find its first one.
  assert.equal(await applyChange(r.context, (await big(3)).theirs), "merged", pulls(r.host));
  assert.ok(r.host.logs.some((line) => line.includes("reason=criss_cross level=4 ok=true found=before")), pulls(r.host));
});

/**
 * THE FORK TWO TYPISTS GROW (issue #227), as this device sees it. Each round
 * is a save here and one from the other device, on its own line, and a
 * resolution that merges and is refused its write, because nothing is written
 * to a note someone is typing in (`main.ts`, `assertEditorIdle`) while
 * `editor.typing` holds. `round()` answers what the resolution came to and
 * how many versions it read. `older` is history below the fork's base.
 */
async function typists(r, older = []) {
  const seen = listing(r.transport);
  const editor = { typing: true };
  refusing(r.host, async (path) => path === NOTE && editor.typing);
  const lines = (one, last) => `# Both${one}\nthe line nobody edits\nthe last fixed line\n${last}`;
  const history = [];
  for (const text of older) {
    r.host.seed(NOTE, text, 100 + history.length);
    history.push((await pushFile(r.context, NOTE)).versionId);
  }
  r.host.seed(NOTE, lines("", ""), 1000);
  const base = await pushFile(r.context, NOTE);
  const typed = { a: "", b: "", theirs: { version_id: base.versionId } };
  let count = 0;
  const round = async () => {
    count++;
    [typed.a, typed.b] = [`${typed.a}A${count} `, `${typed.b} B${count}`];
    r.host.seed(NOTE, lines("", typed.a), 1000 + count);
    await pushFile(r.context, NOTE);
    typed.theirs = await foreign(r, base.fileId, lines(typed.b, ""), [typed.theirs.version_id], 2000 + count);
    const reads = seen.reads.length;
    const outcome = await applyChange(r.context, typed.theirs).catch((error) => error.reason);
    return `${outcome}:${seen.reads.length - reads}`;
  };
  return { seen, editor, lines, base, typed, round, history };
}

/**
 * While both type, nothing merges, and each round sinks the fork's base two
 * versions further below the ten the server lists. Every resolution read
 * that ancestry again, until the read budget refused it and the fork was
 * settled by rule: one person's typing went into a copy (two desktops,
 * 2026-09-27). A version never changes, so it is read once, in one round,
 * never below the base, and the fork merges the moment the typing stops.
 */
test("a fork two typists grow round after round is read once and merges when they stop (#227)", async () => {
  const r = await rig();
  // Twelve older versions: the first resolution is shown the ten newest, so
  // the oldest of the history were never shown, and only the base, found
  // again among what was, stops the walk above them.
  const older = Array.from({ length: 12 }, (_, k) => `draft ${k}`);
  const { seen, editor, lines, base, typed, round, history } = await typists(r, older);
  const rounds = [];
  for (let count = 0; count < 48; count++) rounds.push(await round());

  assert.deepEqual(rounds.map((entry) => entry.split(":")[0]), Array(48).fill("active_editor"), pulls(r.host));
  // Every version a resolution was shown is remembered as well: no round reads.
  assert.equal(rounds.filter((entry) => !entry.endsWith(":0")).length, 0, rounds.join(" "));
  assert.equal(new Set(seen.reads).size, seen.reads.length, "a version was read twice");
  assert.ok(!seen.reads.some((id) => history.includes(id)), "history below the fork was read");
  assert.ok(r.host.logs.some((line) => /reason=merge_ancestry .*reads=0 recalled=[1-9]/.test(line)), pulls(r.host));
  editor.typing = false;
  assert.equal(await applyChange(r.context, typed.theirs), "merged", pulls(r.host));
  assert.equal(r.host.text(NOTE), lines(typed.b, typed.a));
  assert.deepEqual(copies(r.host), []);
  assert.equal(r.server.files.get(base.fileId).heads.length, 1);
});

/**
 * What is remembered of the version graph is bounded as the bases are: the
 * oldest forgotten first, together no longer than one merge input. A version
 * that big leaves no room for the typists' ancestry, which is read again.
 */
test("remembered versions hold one merge input's worth, the oldest forgotten first (#227)", async () => {
  const r = await rig();
  const { round } = await typists(r);
  for (let count = 0; count < 7; count++) await round();
  assert.equal(await round(), "active_editor:0", pulls(r.host));

  const BIG = "Notes/Big.md";
  r.host.seed(BIG, "big\n", 1000);
  const root = await pushFile(r.context, BIG);
  r.host.seed(BIG, "big here\n", 2000);
  await pushFile(r.context, BIG);
  const other = await r.server.publish({ fileId: root.fileId, path: BIG, bytes: enc("big there\n"), mtime: 3000,
    parents: [root.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  // The feed now reaches the same cache before getFile does. Apply identical
  // hostile memory pressure at both entry points, not two bodies for one id.
  other.pad = "x".repeat(CHUNK_MAX);
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async (id) => {
    const file = await getFile(id);
    return id !== root.fileId ? file : { ...file, versions: file.versions
      .filter((version) => version.version_id !== root.versionId)
      .map((version) => (version.version_id === other.version_id ? { ...version, pad: "x".repeat(CHUNK_MAX) } : version)) };
  };
  assert.equal(await applyChange(r.context, other), "merged", pulls(r.host));
  const held = r.host.logs.filter((line) => line.includes("reason=merge_ancestry")).at(-1).match(/held_chars=(\d+)/)[1];
  assert.ok(Number(held) <= CHUNK_MAX, `remembered ${held} characters`);
  assert.match(await round(), /^active_editor:[1-9]/, pulls(r.host));
  // What that round read is remembered in its turn: the next reads nothing.
  assert.equal(await round(), "active_editor:0", pulls(r.host));
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
for (const incomplete of [false, true]) test(`a fork whose other head a later version has replaced is left for that version (incomplete view: ${incomplete})`, async () => {
  const r = await rig();
  const { base, other, head } = await overlap(r);
  await foreign(r, base.fileId, "theirs, and then some\n", [other.version_id], 4000);
  if (incomplete) {
    const third = await foreign(r, base.fileId, "third device's replacement\n", [base.versionId], 5000);
    const getFile = r.transport.getFile.bind(r.transport);
    // An incomplete current-head view cannot use the earlier blanket history
    // shortcut. The visible descendant must still prove this pair obsolete.
    r.transport.getFile = async fileId => {
      const file = await getFile(fileId);
      return { ...file, versions: file.versions.filter(version => version.version_id !== third.version_id) };
    };
  }
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

/** Both devices preserve the same losing head before either sees a receipt. */
test("two devices settling the same overlap publish one shared conflict-copy version", async (t) => {
  const { server, timers, a, b } = await pair(t);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS);
  await Promise.all([a.engine.stopAndWait(), b.engine.stopAndWait()]);
  // Driven by hand from here: a stopped engine's own signal would end every request.
  const left = { ...a.engine.context, signal: undefined }, right = { ...b.engine.context, signal: undefined };
  a.host.seed(NOTE, "base\n", 1000);
  const base = await pushFile(left, NOTE);
  await applyChange(right, server.journal.at(-1));
  a.host.seed(NOTE, "desktop replacement\n", 2000);
  b.host.seed(NOTE, "phone replacement\n", 3000);
  const ours = await pushFile(left, NOTE);
  const ourFrame = server.journal.at(-1);
  const theirs = await pushFile(right, NOTE);
  const theirFrame = server.journal.at(-1);
  assert.equal(server.files.get(base.fileId).heads.length, 2);

  let release;
  const joined = new Promise(resolve => { release = resolve; });
  const attempts = [];
  // Let a broken single-publisher path reach an assertion, not cancellation.
  const timeout = setTimeout(release, 1000);
  t.after(() => { clearTimeout(timeout); release(); });
  for (const device of [a, b]) {
    const post = device.transport.postVersion.bind(device.transport);
    device.transport.postVersion = async (fileId, version) => {
      if (fileId !== base.fileId && version.parents.length === 0) {
        attempts.push({ device: device.state.data.deviceId, fileId });
        if (attempts.length === 2) release();
        await joined;
      }
      return post(fileId, version);
    };
  }
  await Promise.all([applyChange(left, theirFrame), applyChange(right, ourFrame)]);
  clearTimeout(timeout);
  assert.equal(attempts.length, 2, "both devices must preserve the losing head independently");
  assert.equal(new Set(attempts.map(attempt => attempt.device)).size, 2);
  assert.deepEqual(copies(a.host), copies(b.host), "the devices named different conflict copies");
  assert.equal(copies(a.host).length, 1);
  const copy = copies(a.host)[0];
  const recordA = a.state.fileByPath(copy), recordB = b.state.fileByPath(copy);
  assert.equal(recordA.fileId, recordB.fileId);
  const stored = server.files.get(recordA.fileId);
  assert.equal(stored.versions.length, 1, "the same conflict copy was published twice");
  assert.equal(stored.heads.length, 1, "the preserved copy was itself forked");
  assert.equal(recordA.versionId, recordB.versionId, "devices must record the acknowledged copy version");
  assert.equal(recordA.versionId, stored.heads[0]);
  assert.equal(server.deduplicated.filter(entry => entry.fileId === recordA.fileId).length, 1);
  const desktopKept = ours.versionId < theirs.versionId;
  for (const device of [a, b]) {
    assert.equal(device.host.text(NOTE), desktopKept ? "desktop replacement\n" : "phone replacement\n");
    assert.equal(device.host.text(copy), desktopKept ? "phone replacement\n" : "desktop replacement\n");
  }
  assert.equal(server.files.get(base.fileId).heads.length, 1);
  assert.equal(a.state.fileByPath(NOTE).versionId, b.state.fileByPath(NOTE).versionId);
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
 * NOT WRITTEN, NOT CLAIMED (issue #227). With someone typing in the losing
 * note, the kept head's write is refused, and the note still holds the losing
 * head and what was typed on it. Its record said the kept head, so the next
 * save went out as that head's child: the kept head's text out of the note on
 * every device, and in no copy.
 */
test("a losing note whose editor refuses the kept head keeps its record, and its next save its parent (#227)", async () => {
  const { r, ours, head } = await losing();
  const refused = refusing(r.host, async (path) => path === NOTE);
  const TYPED = "mine\nand a line typed here since\n";
  r.host.seed(NOTE, TYPED, 5555);

  await assert.rejects(applyChange(r.context, head), (error) => error.reason === "active_editor");
  assert.equal(refused.count, 1);
  assert.equal(r.host.text(NOTE), TYPED);
  assert.equal(r.state.fileByPath(NOTE).versionId, ours.versionId, "the record names a head the note does not hold");
  assert.ok(r.host.logs.some((line) => line.includes("decision=released reason=not_written role=yield")), pulls(r.host));
  await pushFile(r.context, NOTE);
  assert.deepEqual(r.server.files.get(ours.fileId).versions[0].parents, [ours.versionId], "the save went out over the kept head");
});

/** A phone whose write of `path` stays empty however often it is made (#242, `write_dropped` in main.ts). */
function dropping(host, path) {
  const writer = host.writer.bind(host);
  host.writer = async (at, size) => {
    const output = await writer(at, size);
    return at !== path ? output : { ...output, commit: async () => {
      host.seed(path, "", 9000);
      throw Object.assign(new Error("write_dropped: sentinel"), { code: "write_dropped" });
    } };
  };
}

/**
 * A MERGE OR A KEPT HEAD THE PHONE COULD NOT WRITE (#242; M3241). Not only a
 * download: every write a phone can leave empty marks its name before it
 * commits, and the empty file it leaves is never sent as the note -- not by
 * the push that finds it, which no refusal has reached yet.
 */
test("a merge the phone leaves empty marks its note, and none of the empty file is sent (#242)", async () => {
  const r = await rig();
  r.host.seed(NOTE, "one\ntwo\nthree\n", 1000);
  const base = await pushFile(r.context, NOTE);
  const other = await foreign(r, base.fileId, "one\ntwo\nTHREE\n", [base.versionId], 3000);
  r.host.seed(NOTE, "ONE\ntwo\nthree\n", 2000);
  await pushFile(r.context, NOTE);
  dropping(r.host, NOTE);
  const head = { ...other, heads: r.server.files.get(base.fileId).heads, conflicted: true };
  await assert.rejects(applyChange(r.context, head), (error) => error.reason === "write_dropped");
  assert.ok(r.host.logs.some((line) => line.includes("decision=publishing reason=merge_receipt")), pulls(r.host));
  assert.equal(r.host.text(NOTE), "");
  assert.equal(r.state.data.dropped[NOTE], base.fileId, "the merge's empty file was left unmarked");
  const journal = r.server.journal.length;
  assert.equal((await pushFile(r.context, NOTE)).status, "growing");
  assert.equal(r.server.journal.length, journal, "the merge's empty file was sent as the note");
});

test("a kept head the phone leaves empty marks its note, and none of the empty file is sent (#242)", async () => {
  const { r, ours, head } = await losing();
  dropping(r.host, NOTE);
  await assert.rejects(applyChange(r.context, head), (error) => error.reason === "write_dropped");
  assert.ok(r.host.logs.some((line) => line.includes("decision=released reason=not_written role=yield")), pulls(r.host));
  assert.equal(r.host.text(NOTE), "");
  assert.equal(r.state.data.dropped[NOTE], ours.fileId, "the kept head's empty file was left unmarked");
  const journal = r.server.journal.length;
  assert.equal((await pushFile(r.context, NOTE)).status, "growing");
  assert.equal(r.server.journal.length, journal, "the kept head's empty file was sent as the note");
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
