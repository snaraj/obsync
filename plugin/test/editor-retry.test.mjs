import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { FakeTimers, rig, STEP_MS } from "./fake.mjs";
const require = createRequire(import.meta.url);
const { SyncEngine, EDITOR_PUBLISH_MS } = require("../build/sync/engine.js");
const { EditorBusy, unwritableText } = require("../build/sync/pull.js");
const { ApiError } = require("../build/transport.js");
const { pushFile } = require("../build/sync/push.js");
const NOTE = "Notes/Typing.md";
const enc = (s) => new TextEncoder().encode(s);

async function setup(t) {
  const r = await rig();
  r.host.seed(NOTE, "BASE", 1000);
  const base = await pushFile(r.context, NOTE);
  const timers = new FakeTimers();
  const statuses = [];
  let busy = true;
  let attempts = 0;
  r.host.typing = (path) => path === NOTE && busy;
  const writer = r.host.writer.bind(r.host);
  r.host.writer = async (path) => {
    const pending = await writer(path);
    return { ...pending, commit: async (mtime) => {
      if (path === NOTE) {
        attempts++;
        if (busy) throw new EditorBusy();
      }
      return pending.commit(mtime);
    } };
  };
  const engine = new SyncEngine({ state: r.state, transport: r.context.transport, host: r.host,
    timers, now: () => r.host.clock, onStatus: (value) => statuses.push(value) });
  t.after(() => engine.stop());
  await engine.start();
  const incoming = await r.server.publish({ fileId: base.fileId, path: NOTE, bytes: enc("BASE remote"), mtime: 3000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await timers.run(STEP_MS, () => attempts > 0);
  return { ...r, engine, timers, base, incoming, statuses, attempts: () => attempts, release: () => { busy = false; } };
}

test("an active editor stays pending, other notes arrive, and its latest head retries without another save", async (t) => {
  const r = await setup(t);
  const other = await r.server.publish({ fileId: "ab".repeat(16), path: "Notes/Other.md", bytes: enc("OTHER"), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  // The page is counted down as it lands (#158): wait for its last record, not its first write -- the cursor past
  // it, where the count said as that record began cannot stand in for the one after it (#296).
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= other.seq && r.statuses.at(-1).pending === 1);
  assert.equal(r.host.text("Notes/Other.md"), "OTHER");
  assert.deepEqual(r.engine.current(), { kind: "syncing", pending: 1, held: NOTE }, "the note waiting on typing is its own work");
  assert.equal(r.host.text(NOTE), "BASE");
  assert.equal(r.statuses.at(-1).kind, "syncing", "a saved but active editor is not idle");
  assert.equal(r.statuses.at(-1).pending, 1);
  await r.server.publish({ fileId: r.base.fileId, path: NOTE, bytes: enc("BASE remote latest"), mtime: 5000,
    parents: [r.incoming.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= r.server.journal.at(-1).seq);
  const attempts = r.attempts();
  assert.ok(r.host.logs.some((line) => line.includes("reason=active_editor") && line.includes("retry_ms=1000")));
  await r.timers.run(1000);
  assert.equal(r.attempts(), attempts, "waiting typing does not keep downloading or writing the note");
  assert.deepEqual(r.host.notices, [], "typing is pending work, not a failure notice");
  r.release();
  await r.timers.run(STEP_MS, () => r.host.text(NOTE) === "BASE remote latest");
  await r.timers.run(STEP_MS, () => r.statuses.at(-1).kind === "idle");
  assert.ok(r.attempts() > attempts, "the retry runs without a watcher save or Sync now");
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.equal((await r.reload()).data.parked[r.base.fileId], undefined, "a completed retry persists the cleared wait");
  assert.deepEqual([...r.host.files.keys()].filter((path) => path.includes("(conflict")), []);
});

test("stopping clears an active-editor retry before it can write", async (t) => {
  const r = await setup(t);
  const handle = r.engine.editorHandle;
  assert.notEqual(handle, null);
  await r.engine.stopAndWait();
  assert.ok(!r.timers.entries.some((entry) => entry.handle === handle), "the owned retry timer is cancelled");
  const attempts = r.attempts();
  r.release();
  await r.timers.run(1000);
  assert.equal(r.attempts(), attempts);
  assert.equal(r.host.text(NOTE), "BASE");
  assert.equal(r.state.data.parked[r.base.fileId].reason, "active_editor", "the wait survives a stopped engine");
  assert.equal(r.engine.editorHandle, null);
});

test("a backlog retries each parked file only after its last page record, without blocking other files", async (t) => {
  const r = await setup(t);
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= r.incoming.seq);
  await r.engine.stopAndWait();
  for (let i = 1; i <= 6; i++) {
    r.host.seed(NOTE, `BASE local ${i}`, 4000 + i);
    await pushFile(r.context, NOTE);
    if (i === 3) await r.server.publish({ fileId: "ab".repeat(16), path: "Notes/Other.md", bytes: enc("OTHER"),
      mtime: 4000, domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  }
  const engine = new SyncEngine({ state: r.state, transport: r.context.transport, host: r.host,
    timers: r.timers, now: () => r.host.clock });
  t.after(() => engine.stop());
  // Observe real page applications and retries, not a substitute result.
  const pages = [], applyPage = engine.applyPage.bind(engine), retryOne = engine.retryOne.bind(engine);
  let active = null;
  engine.applyPage = async (context, page) => {
    const entry = { changes: page.changes.length, retries: [], lastSeq: page.seq }; pages.push(entry); active = entry;
    try { return await applyPage(context, page); } finally { active = null; }
  };
  engine.retryOne = async (...args) => { if (active) active.retries.push(r.state.data.lastSeq); return retryOne(...args); };
  await engine.start();
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= r.server.journal.at(-1).seq);
  assert.equal(r.host.text("Notes/Other.md"), "OTHER");
  assert.equal(r.host.text(NOTE), "BASE local 6", "an unsaved editor remains protected");
  assert.equal((await r.reload()).data.parked[r.base.fileId].reason, "active_editor");
  const batch = pages.find((page) => page.changes >= 7);
  assert.ok(batch, "the fixture exercises one multi-record backlog");
  assert.deepEqual(batch.retries, [batch.lastSeq - 1], "retry once at the last echo, before advancing its cursor");
  assert.ok(r.host.logs.some((line) => line.includes("decision=retry_coalesced") && line.includes("retries_saved=5")));
  r.release();
  await r.timers.run(STEP_MS, () => r.host.text(NOTE).includes("remote") && r.host.text(NOTE).includes("local 6"));
  await r.timers.run(STEP_MS, () => r.state.data.parked[r.base.fileId] === undefined);
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.deepEqual([...r.host.files.keys()].filter((path) => path.includes("(conflict")), []);
});

test("a confirmed save retries immediately, independently of recent-input attribution", async (t) => {
  const r = await setup(t);
  r.release();
  r.host.typing = () => true;
  r.host.editorReady = async () => true;
  const previous = r.engine.editorHandle;
  r.engine.editorSaved(NOTE);
  assert.notEqual(r.engine.editorHandle, previous);
  assert.ok(!r.timers.entries.some((entry) => entry.handle === previous));
  await r.timers.run(0, () => r.host.text(NOTE) === "BASE remote");
  assert.equal(r.host.text(NOTE), "BASE remote");
});

test("a newly refused page record keeps its timer instead of immediately retrying the same refusal", async (t) => {
  const r = await setup(t);
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= r.incoming.seq);
  const applyPage = r.engine.applyPage.bind(r.engine), retryOne = r.engine.retryOne.bind(r.engine);
  let inPage = false, retries = 0;
  r.engine.applyPage = async (...args) => {
    inPage = true;
    try { return await applyPage(...args); } finally { inPage = false; }
  };
  r.engine.retryOne = async (...args) => { if (inPage) retries++; return retryOne(...args); };
  const latest = await r.server.publish({ fileId: r.base.fileId, path: NOTE, bytes: enc("BASE latest"), mtime: 5000,
    parents: [r.incoming.version_id], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= latest.seq);
  assert.equal(retries, 0);
  assert.equal(r.host.text(NOTE), "BASE");
  assert.equal((await r.reload()).data.parked[r.base.fileId].reason, "active_editor");
  r.release();
  await r.timers.run(STEP_MS, () => r.host.text(NOTE) === "BASE latest");
});

test("an active-editor wait resumes after restarting with an advanced feed cursor", async (t) => {
  const r = await setup(t);
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= r.server.journal.at(-1).seq);
  const cursor = r.state.data.lastSeq;
  await r.engine.stopAndWait();
  const persisted = await r.reload();
  assert.equal(persisted.data.lastSeq, cursor);
  assert.equal(persisted.data.parked[r.base.fileId].reason, "active_editor");
  const next = new SyncEngine({ state: persisted, transport: r.context.transport, host: r.host,
    timers: r.timers, now: () => r.host.clock });
  t.after(() => next.stop());
  r.release();
  await next.start();
  await r.timers.run(STEP_MS, () => r.host.text(NOTE) === "BASE remote");
  await r.timers.run(STEP_MS, () => persisted.data.parked[r.base.fileId] === undefined);
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
});

test("a failed editor retry keeps its durable wait and recovers automatically", async (t) => {
  const r = await setup(t);
  const getFile = r.transport.getFile.bind(r.transport);
  let offline = true;
  r.transport.getFile = async (...args) => {
    if (offline) throw new ApiError(0, "unreachable", "synthetic offline");
    return getFile(...args);
  };
  r.release();
  await r.timers.run(STEP_MS, () => r.statuses.at(-1).kind === "offline");
  assert.equal(r.state.data.parked[r.base.fileId].reason, "active_editor");
  assert.ok(r.host.logs.some((line) => line.includes("decision=editor_retry_failed")));
  offline = false;
  await r.timers.run(STEP_MS, () => r.host.text(NOTE) === "BASE remote");
  await r.timers.run(STEP_MS, () => r.statuses.at(-1).kind === "idle");
  assert.equal(r.state.data.parked[r.base.fileId], undefined);
});

test("a push reconciliation retains an active-editor wait without an error notice", async (t) => {
  const r = await setup(t);
  r.host.seed(NOTE, "BASE local", 5000);
  // A save receipt permits staging; the final writer still refuses if the
  // editor becomes busy before commit.
  r.host.editorReady = async () => true;
  const before = r.attempts();
  await r.engine.pushOne(NOTE);
  assert.ok(r.attempts() > before, "the push enters native merge publication and hits the editor refusal");
  assert.equal(r.state.data.parked[r.base.fileId].reason, "active_editor");
  // The push receipt may wake the feed while reconciliation is still in
  // flight. Count the held note after that page has finished too.
  await r.timers.run(STEP_MS, () => r.state.data.lastSeq >= r.server.journal.at(-1).seq && r.engine.current().pending === 1);
  // The status names the note it waits on (issue #252: "syncing 1" alone said nothing).
  assert.deepEqual(r.statuses.at(-1), { kind: "syncing", pending: 1, held: NOTE });
  assert.ok(!r.statuses.some((status) => status.kind === "error"));
  assert.ok(!r.host.notices.some((notice) => notice.includes("Cannot write")));
  assert.equal(unwritableText(NOTE, "active_editor"), `Waiting for unsaved changes in ${NOTE} to be saved; its newer version follows`);
});

test("an unsaved editor keeps waiting even after recent-input tracking ends", async (t) => {
  const r = await setup(t);
  r.release();
  r.host.editors.set(NOTE, "BASE unsaved");
  const attempts = r.attempts();
  await r.timers.run(1000);
  assert.equal(r.attempts(), attempts);
  assert.equal(r.host.text(NOTE), "BASE");
  assert.equal(r.state.data.parked[r.base.fileId].reason, "active_editor");
  r.host.editors.set(NOTE, "BASE"); // Undo unsaved input; no disk event follows.
  await r.timers.run(STEP_MS, () => r.host.text(NOTE) === "BASE remote");
});

test("a fast editor retry leaves a locked file on its normal backoff and visible error", async (t) => {
  const r = await setup(t);
  const writer = r.host.writer.bind(r.host);
  let lockedAttempts = 0;
  r.host.writer = async (path) => {
    if (path === "Notes/Locked.md") {
      lockedAttempts++;
      const error = new Error("synthetic locked file"); error.code = "EPERM"; throw error;
    }
    return writer(path);
  };
  const locked = "cd".repeat(16);
  await r.server.publish({ fileId: locked, path: "Notes/Locked.md", bytes: enc("LOCKED"), mtime: 4000,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  await r.timers.run(STEP_MS, () => r.state.data.parked[locked] !== undefined);
  const count = lockedAttempts;
  await r.timers.run(1000);
  assert.equal(lockedAttempts, count, "the fast timer does not retry a filesystem failure");
  assert.equal(r.statuses.at(-1).kind, "error");
  assert.match(r.statuses.at(-1).message, /Locked.md/);
  r.release();
  await r.timers.run(STEP_MS, () => r.host.text(NOTE) === "BASE remote");
  assert.equal(r.state.data.parked[locked].reason, "EPERM");
});


test("confirmed save publication has a first-save deadline that continued input cannot extend", async (t) => {
  const r = await setup(t); r.release();
  const path = "Notes/Batched.md";
  r.host.seed(path, "BATCHED", 1000);
  const settled = [], original = r.engine.settle.bind(r.engine);
  r.engine.settle = async (...args) => { settled.push(args[0]); return original(...args); };
  r.engine.editorSaved(path);
  const first = r.engine.pending.get(path).handle;
  for (let i = 0; i < 4; i++) {
    // run(nonzero) also advances while draining asynchronous work. Step
    // exactly here: crossing the deadline would correctly start a new batch.
    r.timers.now += EDITOR_PUBLISH_MS / 5;
    await r.timers.run(0);
    r.engine.editorSaved(path); r.engine.changed(path);
    assert.equal(r.engine.pending.get(path)?.handle, first, "new input must not debounce forever");
  }
  assert.deepEqual(settled.filter((name) => name === path), []);
  r.timers.now += EDITOR_PUBLISH_MS / 5;
  await r.timers.run(0);
  assert.equal(settled.filter((name) => name === path).length, 1);
});

test("stopping cancels a pending editor publication batch", async (t) => {
  const r = await setup(t);
  r.engine.editorSaved(NOTE);
  const handle = r.engine.pending.get(NOTE).handle;
  await r.engine.stopAndWait();
  assert.ok(!r.timers.entries.some((entry) => entry.handle === handle));
  await r.timers.run(EDITOR_PUBLISH_MS);
  assert.equal(r.engine.pending.size, 0);
});
