/**
 * Newest-first browsing and the automatic filtered search (issue #102).
 *
 * "Restore from history" walked the journal OLDEST first, 20 versions per
 * click, with no cumulative progress. On a vault whose journal held about
 * 6,300 records after a day of use, recovering a note deleted near the end
 * took on the order of 300 clicks, and six clicks with a filter set produced
 * six identical "Checked 20 records; 0 outside selection or refused" lines
 * and no running total. The constraints behind that shape are real -- the
 * server is blind, so a filename filter can only be applied after each
 * manifest is fetched and decrypted here, and `GET /v1/changes?since=N` is a
 * forward-only cursor -- so the fix changes the pacing and the direction, not
 * the bounds.
 *
 * The journal here is 500 versions with the target at record 480, which is
 * the issue's own reproduction.
 *
 * PLATFORM. Dialog and browser code above the `VaultHost` port; identical on
 * desktop and mobile, and the reads are the same bounded `limit=1` pages on
 * both.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { HISTORY_SCAN_RECORDS, HISTORY_SEARCH_MS, HistoryBrowser, HistoryOperation } = require("../build/sync/history.js");

const enc = (text) => new TextEncoder().encode(text);
const TARGET = "Notes/the-deleted-note.md";
const RECORDS = 500;
const AT = 480;

/** A journal of 500 versions with the wanted note at record 480. */
async function journal(r) {
  for (let i = 1; i <= RECORDS; i++) {
    await r.server.publish({
      fileId: String(i).padStart(2, "0").padStart(32, "0"),
      path: i === AT ? TARGET : `Notes/note-${i}.md`,
      bytes: enc(`VERSION ${i}`),
      mtime: 1000 + i,
      domainKey: r.keys.domainKey,
      manifestKey: r.keys.manifestKey,
    });
  }
  // What the device already knows about the head, which is what the dialog
  // counts against before its own first read answers.
  r.state.data.lastSeq = r.server.seq;
  r.host.list = r.host.stat = r.host.read = r.host.createWriter = async () => {
    assert.fail("browsing performed local I/O");
  };
}

/** A clock that advances one second per read, so the budget is exercisable. */
function ticking(step = 1000) {
  let now = 0;
  return { now: () => now, tick: () => { now += step; } };
}

const open = (r, order = {}) => new HistoryBrowser(r.context, new HistoryOperation(), order);

test("a filtered search reaches a note at record 480 in one action, newest first", async () => {
  const r = await rig();
  await journal(r);
  const view = open(r);
  assert.equal(view.newestFirst, true, "newest first is the default");

  const page = await view.next("the-deleted-note");

  assert.deepEqual(page.entries.map((entry) => entry.path), [TARGET]);
  assert.ok(page.checked >= RECORDS - AT, "it really walked down to the record");
  assert.ok(
    page.checked < RECORDS / 2,
    `newest first reaches a recent note without crossing the journal (${page.checked} of ${RECORDS})`,
  );
  assert.equal(page.about, r.server.seq, "and reports what it is counting against");
  assert.equal(view.done, false, "older records remain, and the walk can carry on");

  const start = r.host.logs.find((line) => line.startsWith("history decision=start"));
  assert.match(start, new RegExp(`order=newest_first filtered=true checked=0 about=\\d+ budget_ms=${HISTORY_SEARCH_MS} budget_records=${HISTORY_SCAN_RECORDS}`));
  const summary = r.host.logs.find((line) => line.startsWith("history decision=summary"));
  assert.match(summary, /matches=1 refused=0/);
  assert.match(summary, new RegExp(`scanned=${page.scanned} matches=1 refused=0 checked=${page.checked}`));
  assert.match(summary, /duration_ms=\d+/);
});

test("newest first shows the newest records first, and the windows meet without gaps", async () => {
  const r = await rig();
  await journal(r);
  const view = open(r);

  const first = await view.next();
  const second = await view.next();
  const paths = [...first.entries, ...second.entries].map((entry) => entry.path);

  assert.equal(first.entries[0].path, `Notes/note-${RECORDS}.md`, "the newest record is the first row");
  assert.ok(first.entries.length > 1 && first.entries.length <= HISTORY_SCAN_RECORDS, `one step's rows (${first.entries.length})`);
  const numbers = paths.map((path) => Number(/note-(\d+)\.md$/.exec(path)?.[1] ?? AT));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => b - a), "every row is older than the one before it");
  assert.equal(new Set(paths).size, paths.length, "no record is shown twice");
  assert.equal(
    numbers[0] - numbers[numbers.length - 1] + 1,
    numbers.length,
    "and the two windows meet: no record between them is skipped",
  );
});

test("oldest first is still available and starts at the other end", async () => {
  const r = await rig();
  await journal(r);
  const view = open(r, { newestFirst: false });

  const page = await view.next();

  assert.equal(view.newestFirst, false);
  assert.equal(page.entries[0].path, "Notes/note-1.md", "the oldest record is the first row");
  assert.match(r.host.logs.find((line) => line.startsWith("history decision=start")), /order=oldest_first/);
});

test("an unfiltered step stays one step; only a filter runs the steps together", async () => {
  const r = await rig();
  await journal(r);
  const view = open(r);

  const page = await view.next();

  assert.ok(page.scanned <= HISTORY_SCAN_RECORDS + 1, `one window plus its terminating request (${page.scanned})`);
  assert.match(r.host.logs.find((line) => line.startsWith("history decision=start")), /filtered=false checked=0 about=\d+ budget_ms=0/);
});

test("a filtered search that finds nothing stops at its budget and resumes where it stopped", async () => {
  const r = await rig();
  await journal(r);
  const clock = ticking(HISTORY_SEARCH_MS / 4);
  const original = r.transport.historyChanges.bind(r.transport);
  r.transport.historyChanges = async (...args) => { clock.tick(); return original(...args); };
  const view = open(r, { now: clock.now });

  const first = await view.next("no-such-note-anywhere");
  assert.deepEqual(first.entries, []);
  assert.ok(first.checked > 0, "it did walk");
  assert.ok(first.checked < RECORDS, `and it stopped at the budget rather than at the end (${first.checked})`);
  assert.equal(view.done, false);
  const summary = r.host.logs.find((line) => line.startsWith("history decision=summary"));
  assert.match(summary, new RegExp(`matches=0 refused=0 checked=${first.checked}`));

  // The next action picks up where the last one stopped: the cumulative count
  // keeps rising, and no record is read twice.
  const second = await view.next("the-deleted-note");
  assert.equal(second.checked > first.checked, true, "the running total carries over");
  assert.deepEqual(second.entries.map((entry) => entry.path), [TARGET]);
});

test("a cancel stops the automatic search inside one step", async () => {
  const r = await rig();
  await journal(r);
  const operation = new HistoryOperation();
  const view = new HistoryBrowser(r.context, operation, {});
  let reads = 0;
  const original = r.transport.historyChanges.bind(r.transport);
  r.transport.historyChanges = async (...args) => {
    if (++reads === 3) operation.cancel();
    return original(...args);
  };

  await assert.rejects(view.next("no-such-note-anywhere"), /cancelled/i);
  assert.ok(reads <= HISTORY_SCAN_RECORDS + 2, `it stopped inside the step it was in (${reads} reads)`);
});

test("the descending walk reaches the end of retained history and says so", async () => {
  const r = await rig();
  for (let i = 1; i <= 9; i++) {
    await r.server.publish({
      fileId: String(i).repeat(32).slice(0, 32), path: `Notes/small-${i}.md`, bytes: enc(`V${i}`),
      mtime: 1000 + i, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
    });
  }
  const view = open(r);

  const page = await view.next();

  assert.equal(view.done, true, "one window covers this whole journal");
  assert.equal(page.entries.length, 9, "and every record is shown exactly once");
  assert.equal((await view.next()).scanned, 0, "a completed walk issues no further request");
});
