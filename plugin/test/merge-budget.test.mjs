import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, EditorBusy } = require("../build/sync/pull.js");
const { pushFile, serialPublication } = require("../build/sync/push.js");
const NOTE = "Notes/Typing.md";

async function fork() {
  const r = await rig();
  r.host.seed(NOTE, "Desktop: START\nPhone: START", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "Desktop: STARTA\nPhone: START", 2000);
  await pushFile(r.context, NOTE);
  const incoming = await r.server.publish({ fileId: base.fileId, path: NOTE,
    bytes: new TextEncoder().encode("Desktop: START\nPhone: STARTa"), mtime: 3000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  return { ...r, base, incoming };
}

test("refused editor writes do not consume the merge budget or create copies", async () => {
  const r = await fork();
  const writer = r.host.writer.bind(r.host);
  let busy = true;
  r.host.writer = async path => {
    const pending = await writer(path);
    return { ...pending, commit: async mtime => {
      if (path === NOTE && busy) throw new EditorBusy();
      return pending.commit(mtime);
    } };
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    await assert.rejects(applyChange(r.context, r.incoming), error => error.reason === "active_editor");
    assert.deepEqual([...r.host.files.keys()].filter(path => path.includes("(conflict")), []);
    assert.equal(r.context.merges.get(r.base.fileId).count, 0);
  }
  busy = false;
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Desktop: STARTA\nPhone: STARTa");
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
  assert.equal(r.context.merges.get(r.base.fileId).count, 1);
  assert.ok(!r.host.logs.some(line => line.includes("reason=merge_storm")));
});

test("an ordinary failed write still consumes the merge budget", async () => {
  const r = await fork();
  r.host.writer = async () => { const error = new Error("synthetic I/O failure"); error.code = "EIO"; throw error; };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(applyChange(r.context, r.incoming), /synthetic I\/O failure/);
    assert.equal(r.context.merges.get(r.base.fileId).count, attempt);
  }
});

for (const mode of ["typing", "unsaved"]) test(`overlapping editor refusals cannot trip the breaker or create copies (${mode})`, async () => {
  const r = await fork();
  const writer = r.host.writer.bind(r.host);
  let busy = true;
  r.host.typing = () => busy && mode === "typing";
  r.host.editing = async () => busy && mode === "unsaved" ? "unsaved" : "saved";
  r.host.writer = async path => {
    const pending = await writer(path);
    return { ...pending, commit: async mtime => {
      if (path === NOTE && busy) throw new EditorBusy();
      return pending.commit(mtime);
    } };
  };
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => applyChange(r.context, r.incoming)));
  assert.ok(outcomes.every(outcome => outcome.status === "rejected" && outcome.reason.reason === "active_editor"));
  assert.deepEqual([...r.host.files.keys()].filter(path => path.includes("(conflict")), []);
  assert.equal(r.context.merges.get(r.base.fileId).count, 0, "all refused reservations were refunded");
  assert.ok(!r.host.logs.some(line => line.includes("reason=merge_storm")));
  // Eight original reservations meet the five-slot limit: exactly three
  // refuse before any publication retry. Preparing under the typing lane's
  // reservation now makes the queued retries overlap too; those two further
  // refusals are refunded as well, rather than counted as completed merges.
  const retry = r.host.logs.findIndex(line => line.includes("decision=retry reason=upload_completed"));
  const original = retry < 0 ? r.host.logs : r.host.logs.slice(0, retry);
  const limited = lines => lines.filter(line => line.includes("decision=waiting reason=active_editor phase=merge_limit")).length;
  assert.equal(limited(original), 3);
  assert.equal(limited(r.host.logs), mode === "typing" ? 5 : 3);
  busy = false;
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Desktop: STARTA\nPhone: STARTa");
  assert.equal(r.server.files.get(r.base.fileId).heads.length, 1);
});

for (const reset of [false, true]) test(`a late editor refusal preserves a concurrent resolution's budget (new edit: ${reset})`, async () => {
  const r = await fork();
  const writer = r.host.writer.bind(r.host);
  let enter, release, first = true;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  r.host.writer = async path => {
    if (first && path === NOTE) { first = false; enter(); await gate; throw new EditorBusy(); }
    return writer(path);
  };
  const refused = assert.rejects(applyChange(r.context, r.incoming), error => error.reason === "active_editor");
  await entered;
  try {
    // The new edit goes out before a merge takes it (#227).
    if (reset) { r.host.seed(NOTE, "Desktop: STARTAB\nPhone: START", 4000); await pushFile(r.context, NOTE); }
    assert.equal(await applyChange(r.context, r.incoming), "merged");
  } finally { release(); }
  await refused;
  assert.equal(r.context.merges.get(r.base.fileId).count, 1, "keep the completed resolution and discard only the refused attempt");
  assert.equal(r.host.text(NOTE), `Desktop: STARTA${reset ? "B" : ""}\nPhone: STARTa`);
});

/**
 * A PUSH SENT LATE IS WAITED FOR, NOT TAKEN FOR A LOOP (issue #278, live). A
 * starved machine sent a typist's save forty seconds after it landed, and the
 * other devices' versions were resolved again and again meanwhile, each one
 * left for that push. Counted as resolutions that changed nothing, they tripped
 * the breaker, which settled the pairs by rule: both typists' last words went
 * into copies. The wait is not counted; the push's own merge is.
 */
test("resolutions left for this device's own push do not trip the breaker (#278)", async () => {
  const r = await fork();
  r.host.seed(NOTE, "Desktop: STARTAB\nPhone: START", 4000);
  for (let attempt = 0; attempt < 8; attempt++) assert.equal(await applyChange(r.context, r.incoming), "skipped");
  assert.equal(r.host.logs.filter(line => /^pull decision=merge_budget_refund reason=own_push .* count=0$/.test(line)).length, 8);
  await pushFile(r.context, NOTE);
  assert.equal(await applyChange(r.context, r.incoming), "merged");
  assert.equal(r.host.text(NOTE), "Desktop: STARTAB\nPhone: STARTa");
  assert.deepEqual([...r.host.files.keys()].filter(path => path.includes("(conflict")), []);
  assert.ok(!r.host.logs.some(line => line.includes("reason=merge_storm")));
});

test("a late wait for the push preserves a concurrent resolution's budget (#278)", async () => {
  const r = await fork();
  r.host.seed(NOTE, "Desktop: STARTAB\nPhone: START", 4000);
  const save = r.context.state.save.bind(r.context.state);
  let enter, release, armed = true;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  r.context.state.save = async () => {
    if (armed) { armed = false; enter(); await gate; }
    return save();
  };
  const waiting = applyChange(r.context, r.incoming);
  await entered;
  try {
    r.host.seed(NOTE, "Desktop: STARTABC\nPhone: START", 5000);
    await pushFile(r.context, NOTE);
    assert.equal(await applyChange(r.context, r.incoming), "merged");
  } finally { release(); }
  assert.equal(await waiting, "skipped");
  assert.equal(r.context.merges.get(r.base.fileId).count, 1, "keep the completed resolution and refund only the wait");
});

test("a move left for the push before any resolution does not refund the merge that settles it (#278)", async () => {
  const r = await rig();
  r.host.seed(NOTE, "Desktop: START\nPhone: START", 1000);
  const base = await pushFile(r.context, NOTE);
  r.host.seed(NOTE, "Desktop: STARTA\nPhone: START", 2000);
  const moved = await r.server.publish({ fileId: base.fileId, path: "Notes/Moved.md",
    bytes: new TextEncoder().encode("Desktop: START\nPhone: STARTa"), mtime: 3000,
    parents: [base.versionId], domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
  assert.equal(await applyChange(r.context, moved), "skipped");
  await pushFile(r.context, NOTE);
  assert.equal(await applyChange(r.context, moved), "merged");
  assert.equal(r.context.merges.get(base.fileId).count, 1, r.host.logs.join(" | "));
});

test("a resolution that waits for this device's upload and starts over is counted once (#278)", async () => {
  const r = await fork();
  let release;
  const upload = serialPublication(r.context, NOTE, () => new Promise(resolve => { release = resolve; }));
  const waiting = applyChange(r.context, r.incoming);
  while (!r.host.logs.some(line => line.includes("decision=waiting reason=upload_receipt"))) await new Promise(setImmediate);
  release();
  await upload;
  assert.equal(await waiting, "merged");
  assert.equal(r.context.merges.get(r.base.fileId).count, 1, r.host.logs.join(" | "));
  assert.ok(r.host.logs.some(line => /^pull decision=merge_budget_refund reason=started_over .* count=1$/.test(line)));
});

for (const site of ["upload_completed", "merge_parent_advanced"]) test(`a merge that meets this device's publication midway starts over and is counted once (${site}, #278)`, async () => {
  const r = await fork();
  const writer = r.host.writer.bind(r.host);
  let first = true;
  r.host.writer = async (path, size) => {
    if (first && path === NOTE) {
      first = false;
      if (site === "upload_completed") {
        let release;
        serialPublication(r.context, NOTE, () => new Promise(resolve => { release = resolve; }));
        setImmediate(() => release());
      } else {
        // This device's upload of the note as it stands landed meanwhile.
        const landed = await r.server.publish({ fileId: r.base.fileId, path: NOTE, bytes: new TextEncoder().encode(r.host.text(NOTE)),
          mtime: 3500, parents: [r.state.fileByPath(NOTE).versionId], deviceId: r.context.deviceId,
          domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey });
        r.state.setFile(NOTE, { ...r.state.fileByPath(NOTE), versionId: landed.version_id });
      }
    }
    return writer(path, size);
  };
  assert.equal(await applyChange(r.context, r.incoming), "merged", r.host.logs.join(" | "));
  assert.ok(r.host.logs.some(line => line.includes(`decision=retry reason=${site}`)));
  assert.equal(r.context.merges.get(r.base.fileId).count, 1, r.host.logs.join(" | "));
});
