import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { rig } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { applyChange } = require("../build/sync/pull.js");
const NOTE = "Notes/Typing.md";
const FILE = "63".repeat(16);
const bytes = text => new TextEncoder().encode(text);

/** The real file endpoint returns its newest ten versions PLUS every head. */
function boundedFileView(r) {
  const getFile = r.transport.getFile.bind(r.transport);
  r.transport.getFile = async id => {
    const file = await getFile(id);
    return { ...file, versions: file.versions.filter((version, index) =>
      index < 10 || file.heads.includes(version.version_id)) };
  };
}

async function history(r) {
  const post = async (text, parents) => r.server.publish({
    fileId: FILE, path: NOTE, bytes: bytes(text), parents,
    mtime: 1000 + r.server.journal.length,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  let last = await post("desktop 0\nseparator\nphone 0\n", []);
  const frames = [last];
  for (let n = 1; n <= 12; n++) {
    const left = await post(`desktop ${n}\nseparator\nphone ${n - 1}\n`, [last.version_id]);
    const right = await post(`desktop ${n - 1}\nseparator\nphone ${n}\n`, [last.version_id]);
    last = await post(`desktop ${n}\nseparator\nphone ${n}\n`, [left.version_id, right.version_id]);
    frames.push(left, right, last);
  }
  return { frames, last };
}

for (const isMobile of [false, true]) {
  test(`fresh ${isMobile ? "mobile" : "desktop"} catch-up does not recreate historical typing conflicts outside the file view`, async () => {
    const r = await rig({ isMobile });
    const { frames, last } = await history(r);
    boundedFileView(r);
    const view = await r.transport.getFile(FILE);
    assert.equal(view.versions.length, 10);
    assert.deepEqual(view.heads, [last.version_id]);
    assert.equal(view.versions.some(v => v.version_id === frames[2].version_id), false);
    const before = r.server.journal.length;

    for (const frame of frames) await applyChange(r.context, frame);

    assert.equal(r.host.text(NOTE), "desktop 12\nseparator\nphone 12\n");
    assert.deepEqual([...r.host.files.keys()].filter(path => path.includes("(conflict from")), [],
      "a fresh device recreated a fork already resolved before it paired");
    assert.equal(r.state.fileByPath(NOTE).versionId, last.version_id);
    assert.equal(r.server.journal.length, before, "history replay published another resolution");
    assert.equal(r.host.logs.some(line => line.includes("reason=merge_storm")), false);
  });
}

test("an old live head outside the newest ten versions is still a real conflict", async () => {
  const r = await rig();
  const post = (text, parents) => r.server.publish({
    fileId: FILE, path: NOTE, bytes: bytes(text), parents, mtime: 1000 + r.server.journal.length,
    domainKey: r.keys.domainKey, manifestKey: r.keys.manifestKey,
  });
  const base = await post("base\n", []);
  const oldHead = await post("older live branch\n", [base.version_id]);
  let other = base;
  for (let n = 0; n < 12; n++) other = await post(`other branch ${n}\n`, [other.version_id]);
  boundedFileView(r);
  const view = await r.transport.getFile(FILE);
  assert.equal(view.versions.length, 11, "the head outside the window must remain visible");
  assert.equal(view.heads.includes(oldHead.version_id), true);
  await applyChange(r.context, oldHead);
  await applyChange(r.context, other);

  const kept = [...r.host.files.keys()].filter(path => path === NOTE || path.includes("(conflict from"));
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map(path => r.host.text(path)).sort(), ["older live branch\n", "other branch 11\n"].sort());
  assert.equal(r.server.files.get(FILE).heads.length, 1, "the actual fork must settle");
});

for (const mode of ["empty", "missing"]) {
  test(`an ${mode} head view is not proof that a competing version is obsolete`, async () => {
    const r = await rig();
    const { frames } = await history(r);
    boundedFileView(r);
    const getFile = r.transport.getFile.bind(r.transport);
    r.transport.getFile = async id => ({ ...await getFile(id), heads: mode === "empty" ? [] : ["ae".repeat(32)] });
    await applyChange(r.context, frames[0]);
    await applyChange(r.context, frames[1]);
    await applyChange(r.context, frames[2]);

    assert.equal(r.host.text(NOTE), "desktop 1\nseparator\nphone 0\n");
    const kept = [...r.host.files.keys()].filter(path => path.includes("(conflict from"));
    assert.equal(kept.length, 1);
    assert.equal(r.host.text(kept[0]), "desktop 0\nseparator\nphone 1\n");
    assert.equal(r.host.logs.some(line => line.includes("reason=superseded_head")), false);
  });
}
