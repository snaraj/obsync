import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange, EditorBusy } = require("../build/sync/pull.js");
const { pushFile } = require("../build/sync/push.js");
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
    if (reset) r.host.seed(NOTE, "Desktop: STARTAB\nPhone: START", 4000);
    assert.equal(await applyChange(r.context, r.incoming), "merged");
  } finally { release(); }
  await refused;
  assert.equal(r.context.merges.get(r.base.fileId).count, 1, "keep the completed resolution and discard only the refused attempt");
  assert.equal(r.host.text(NOTE), `Desktop: STARTA${reset ? "B" : ""}\nPhone: STARTa`);
});
