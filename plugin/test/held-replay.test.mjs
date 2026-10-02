/**
 * PAIRED AGAIN OVER A VAULT IT HOLDS (issue #241).
 *
 * A device that left and is paired again -- a new device id, an empty state --
 * replays the feed from zero over the notes it kept. A note renamed before it
 * left arrives first at its OLD name, where nothing stands here any more:
 * written there, its move then met the kept note at the new name, which was
 * published again under a new id, and on a phone the copy at the old name
 * stayed beside it for good. A version the kept note descends from is history
 * (`pull.ts`, `behind_held`), and the newest is adopted where the note stands.
 *
 * The real engine and the plugin's real vault-event handlers over the `pair`
 * rig (`fake.mjs`), then a fresh device over the SAME vault the left device
 * used. The phone-like host binds no removal, which is the host that kept the
 * copy at the old name.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FakeHost, FakeServer, FakeTimers, KEYS, STEP_MS, fakeState, keys, pair, sandbox, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine } = require("../build/sync/engine.js");
const { Transport } = require("../build/transport.js");

const AGAIN = "dd".repeat(16);
const AGAIN_SECRET = "4d".repeat(32);
const OLD = "Kept/Folder";
const MID = "Kept/Folder middle";
const NEW = "Kept/Folder renamed";
const NAMES = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const text = (name) => `HELD REPLAY SENTINEL ${name}\n`;

/** A fresh device over an EXISTING vault: what Leave then Pair gives (`forgetPairing` empties state). */
async function pairedAgain(t, server, timers, host, isMobile) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { state } = await fakeState(isMobile);
  Object.assign(state.data, { deviceId: AGAIN, deviceSecret: AGAIN_SECRET });
  const transport = new Transport({
    request: server.request,
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: AGAIN, secret: Uint8Array.from(Buffer.from(AGAIN_SECRET, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const engine = new SyncEngine({ state, transport, host, now: () => host.clock, timers });
  // Obsidian dropped the old plugin session's handlers with it.
  host.listeners.clear();
  host.obsidian = box.require("obsidian");
  const plugin = new (box.require(join(box.home, "build/main.js")).default)();
  Object.assign(plugin, { app: { vault: host }, registerEvent: () => undefined, state, engine });
  plugin.registerVaultEvents();
  t.after(() => engine.stop());
  return { host, state, engine };
}

const under = (host, folder) => [...host.files.keys()].filter((path) => path.startsWith(`${folder}/`)).sort();

/**
 * Notes written on the desktop, the folder renamed on B along `chain`, B
 * leaves and is paired again over the vault it kept. `edited` edits one note
 * after the renames on B; `away` edits B's copy while it is unpaired.
 */
async function scenario(t, { isMobileB, count = 10, chain = [[OLD, NEW]], edited = false, away = false, ahead = false }) {
  const names = NAMES.slice(0, count);
  const { server, timers, a, b } = await pair(t, "immediate", { isMobileB });
  await a.engine.start();
  await b.engine.start();
  for (const folder of ["Kept", OLD]) {
    a.host.makeFolder(folder);
    await timers.run(STEP_MS, () => a.state.folderByPath(folder) !== undefined && b.host.hasFolder(folder));
  }
  for (const name of names) a.host.write(`${OLD}/${name}.md`, text(name), 1000);
  await timers.run(STEP_MS, () => names.every((name) => settled(a, `${OLD}/${name}.md`) && settled(b, `${OLD}/${name}.md`)));
  const ids = Object.fromEntries(names.map((name) => [name, a.state.fileByPath(`${OLD}/${name}.md`).fileId]));
  for (const [from, to] of chain) {
    b.host.renameFolder(from, to);
    await timers.run(STEP_MS, () => names.every((name) => settled(b, `${to}/${name}.md`) && settled(a, `${to}/${name}.md`)) &&
      under(a.host, from).length === 0);
  }
  const last = chain.at(-1)?.[1] ?? OLD;
  if (edited) {
    b.host.write(`${last}/Two.md`, "HELD REPLAY SENTINEL Two, edited after the rename\n", 5000);
    await timers.run(STEP_MS, () => a.host.text(`${last}/Two.md`)?.includes("edited"));
  }
  await timers.run(STEP_MS * 20);
  await b.engine.stopAndWait();
  server.devices.find((device) => device.device_id === b.state.data.deviceId).revoked = true;
  const seq = server.seq;
  if (away) b.host.seed(`${last}/Two.md`, "HELD REPLAY SENTINEL Two, edited while unpaired\n", 9000);
  if (ahead) {
    a.host.write(`${last}/Two.md`, "HELD REPLAY SENTINEL Two, edited on the other device meanwhile\n", 9000);
    await timers.run(STEP_MS, () => a.state.fileByPath(`${last}/Two.md`)?.size === 63 && a.state.data.lastSeq === server.seq);
  }
  b.host.logs.length = 0;

  server.addDevice(AGAIN, AGAIN_SECRET, "paired again", isMobileB ? "android" : "linux");
  const c = await pairedAgain(t, server, timers, b.host, isMobileB);
  await c.engine.start();
  await timers.run(STEP_MS, () => c.state.data.lastSeq >= seq && names.every((name) => settled(c, `${last}/${name}.md`)));
  await timers.run(STEP_MS * 40);
  // Idle, and at the head: whatever it was going to post has been posted.
  await timers.run(STEP_MS, () => c.engine.current().kind === "idle" && c.state.data.lastSeq === server.seq);
  const strays = chain.flatMap(([from]) => under(c.host, from));
  const posted = server.journal.filter((frame) => frame.device_id === AGAIN && (frame.sids.length > 0 || frame.deleted));
  const story = [
    `strays=${JSON.stringify(strays)} kept=${JSON.stringify(under(c.host, last))}`,
    `records=${JSON.stringify(Object.fromEntries(Object.entries(c.state.data.files).map(([p, r]) => [p, `${r.fileId.slice(0, 6)}${r.name ? ` beside=>${r.name}` : ""}`])))}`,
    `posted=${JSON.stringify(posted.map((frame) => frame.file_id.slice(0, 6)))}`,
    `log=${JSON.stringify(c.host.logs.filter((line) => /^(pull|push|reconcile)/.test(line)))}`,
  ].join("\n");
  return { c, names, ids, strays, posted, story, last, server };
}

for (const isMobileB of [false, true]) {
  const host = isMobileB ? "phone-like" : "desktop";
  test(`paired again after a folder rename, nothing is written at the old name and nothing is posted (#241, ${host})`, async (t) => {
    const r = await scenario(t, { isMobileB });
    assert.deepEqual(r.strays, [], `copies at the old name: ${r.strays.length}/${r.names.length}\n${r.story}`);
    assert.deepEqual(under(r.c.host, NEW), r.names.map((name) => `${NEW}/${name}.md`).sort(), r.story);
    for (const name of r.names) assert.equal(r.c.state.fileByPath(`${NEW}/${name}.md`)?.fileId, r.ids[name], `${name}\n${r.story}`);
    assert.deepEqual(r.posted, [], `posted again:\n${r.story}`);
    assert.ok(r.c.host.logs.some((line) => line.startsWith(`pull decision=skipped reason=behind_held file=${r.ids.One} seq=`)), r.story);
  });

  test(`paired again after a rename chain A -> B -> C, nothing is written at either old name (#241, ${host})`, async (t) => {
    const r = await scenario(t, { isMobileB, count: 3, chain: [[OLD, MID], [MID, NEW]] });
    assert.deepEqual(r.strays, [], r.story);
    assert.deepEqual(under(r.c.host, NEW), r.names.map((name) => `${NEW}/${name}.md`).sort(), r.story);
    assert.deepEqual(r.posted, [], r.story);
  });
}

test("paired again over a note renamed and then edited, it is adopted as its edit (#241)", async (t) => {
  const r = await scenario(t, { isMobileB: true, count: 3, edited: true });
  assert.deepEqual(r.strays, [], r.story);
  assert.equal(r.c.host.text(`${NEW}/Two.md`), "HELD REPLAY SENTINEL Two, edited after the rename\n", r.story);
  assert.equal(r.c.state.fileByPath(`${NEW}/Two.md`)?.fileId, r.ids.Two, r.story);
  assert.deepEqual(r.posted, [], r.story);
});

test("paired again over a note edited while unpaired, both texts survive and nothing lands at the old name (#241)", async (t) => {
  const r = await scenario(t, { isMobileB: true, count: 3, away: true });
  assert.deepEqual(r.strays, [], r.story);
  assert.equal(r.c.host.text(`${NEW}/Two.md`), "HELD REPLAY SENTINEL Two, edited while unpaired\n", r.story);
  // The server's copy is the one set beside it, under the note's own id.
  const copy = under(r.c.host, NEW).find((path) => path.startsWith(`${NEW}/Two (conflict `));
  assert.equal(copy === undefined ? null : r.c.host.text(copy), text("Two"), r.story);
  assert.equal(r.c.state.fileByPath(copy)?.fileId, r.ids.Two, r.story);
});

/*
 * AND AT THE NAME IT STANDS AT, an older version is compared as ever: the note
 * kept here is that version, so it is adopted, and the newer one updates it.
 * Skipped as history, the newer one met bytes it could not adopt, and the kept
 * note was posted again beside a conflict copy.
 */
test("paired again over an older version of a note, it is adopted and then updated, and nothing is posted (#241)", async (t) => {
  const r = await scenario(t, { isMobileB: true, count: 3, ahead: true });
  assert.deepEqual(under(r.c.host, NEW), r.names.map((name) => `${NEW}/${name}.md`).sort(), r.story);
  assert.equal(r.c.host.text(`${NEW}/Two.md`), "HELD REPLAY SENTINEL Two, edited on the other device meanwhile\n", r.story);
  assert.equal(r.c.state.fileByPath(`${NEW}/Two.md`)?.fileId, r.ids.Two, r.story);
  assert.deepEqual(r.posted, [], r.story);
});

/*
 * THE PRECISION CLAUSE. A rename posted AFTER the start's walk is not behind
 * the note the walk found, so it is applied: the note moves to its new name
 * here too, and the local note at the old name -- different bytes, edited
 * while unpaired -- is kept. A rule that skipped every version of a held note
 * at another name loses that rename.
 */
test("a rename posted after the start's walk still lands on a device paired again (#241)", async () => {
  const server = new FakeServer();
  const k = await keys();
  await server.seedDomainMap(k.map, KEYS.domainId);
  const F = "f7".repeat(16);
  const enc = (value) => new TextEncoder().encode(value);
  const v1 = await server.publish({ fileId: F, path: "Notes/a.md", bytes: enc("SERVER SENTINEL\n"), mtime: 1757100000000, domainKey: k.domainKey, manifestKey: k.manifestKey });
  const host = new FakeHost();
  host.seed("Notes/a.md", "LOCAL SENTINEL, edited while unpaired\n", 1757000000000);
  // The rename lands right after the walk's last read, from a cursor past zero.
  const request = server.request;
  let reads = 0;
  const { state } = await fakeState(false);
  const transport = new Transport({
    request: async (req) => {
      const answer = await request(req);
      if (req.method === "GET" && /\/v1\/changes\?since=[1-9]/.test(req.url) && ++reads === 1) {
        await server.publish({ fileId: F, path: "Notes/c.md", bytes: enc("SERVER SENTINEL\n"), mtime: 1757100000000, parents: [v1.version_id], domainKey: k.domainKey, manifestKey: k.manifestKey });
      }
      return answer;
    },
    serverUrl: () => state.data.serverUrl,
    device: () => ({ id: KEYS.deviceId, secret: Uint8Array.from(Buffer.from(KEYS.deviceSecret, "hex")) }),
    edgeHeaders: () => [],
    now: () => host.clock,
    sleep: async () => undefined,
    maxAttempts: 2,
    log: (line) => host.logs.push(line),
  });
  const timers = new FakeTimers();
  const engine = new SyncEngine({ state, transport, host, timers, now: () => timers.now });
  await engine.start();
  try {
    await timers.run(STEP_MS, () => state.data.lastSeq >= server.seq && state.fileByPath("Notes/a.md")?.versionId > "");
    await timers.run(STEP_MS * 20);
    const story = `files=${JSON.stringify([...host.files.keys()])} records=${JSON.stringify(state.data.files)} log=${JSON.stringify(host.logs.filter((line) => /^(pull|reconcile|push)/.test(line)))}`;
    assert.equal(host.text("Notes/c.md"), "SERVER SENTINEL\n", story);
    assert.equal(state.fileByPath("Notes/c.md")?.fileId, F, story);
    assert.equal(host.text("Notes/a.md"), "LOCAL SENTINEL, edited while unpaired\n", story);
  } finally {
    engine.stop();
    server.releaseFeed();
  }
});

/*
 * THE SECURITY LANE'S LIVE SEQUENCE (lab G, leg C; one kept occurrence under
 * load): the leaving device moves a note out of its folder to the vault's
 * root and edits another, the other device deletes a file, then Leave and
 * pair again. That run left a byte-identical "(conflict from …)" copy of the
 * moved note beside it on both devices: the move met the kept note after the
 * replay had written its first version at the old name.
 */
for (const isMobileB of [false, true]) {
  test(`paired again after moving a note to the root, with an edit and a deletion around it, no conflict copy is made (#241, ${isMobileB ? "phone-like" : "desktop"})`, async (t) => {
    const { server, timers, a, b } = await pair(t, "immediate", { isMobileB });
    await a.engine.start();
    await b.engine.start();
    a.host.makeFolder("Sentinel folder");
    await timers.run(STEP_MS, () => a.state.folderByPath("Sentinel folder") !== undefined && b.host.hasFolder("Sentinel folder"));
    const written = { "Sentinel folder/move me.md": "move-me body\n", "Sentinel.md": "sentinel body\n", "attachment.bin": "binary sentinel\n" };
    for (const [path, body] of Object.entries(written)) a.host.write(path, body, 1000);
    await timers.run(STEP_MS, () => Object.keys(written).every((path) => settled(a, path) && settled(b, path)));
    const id = a.state.fileByPath("Sentinel folder/move me.md").fileId;
    b.host.rename("Sentinel folder/move me.md", "Renamed.md");
    b.host.write("Sentinel.md", "sentinel body\nedited on B\n", 3000);
    await timers.run(STEP_MS, () => settled(a, "Renamed.md") && a.host.text("Sentinel.md") === "sentinel body\nedited on B\n");
    a.host.remove("attachment.bin");
    await timers.run(STEP_MS, () => !b.host.files.has("attachment.bin"));
    await timers.run(STEP_MS * 20);
    await b.engine.stopAndWait();
    server.devices.find((device) => device.device_id === b.state.data.deviceId).revoked = true;

    server.addDevice(AGAIN, AGAIN_SECRET, "paired again", isMobileB ? "android" : "linux");
    const c = await pairedAgain(t, server, timers, b.host, isMobileB);
    await c.engine.start();
    await timers.run(STEP_MS, () => c.state.data.lastSeq === server.seq && settled(c, "Renamed.md"));
    await timers.run(STEP_MS * 40);
    await timers.run(STEP_MS, () => c.engine.current().kind === "idle" && c.state.data.lastSeq === server.seq &&
      a.engine.current().kind === "idle" && a.state.data.lastSeq === server.seq);
    const notes = (host) => [...host.files.keys()].filter((path) => path.endsWith(".md")).sort();
    const posted = server.journal.filter((frame) => frame.device_id === AGAIN && (frame.sids.length > 0 || frame.deleted));
    const tale = `a=${JSON.stringify(notes(a.host))} b=${JSON.stringify(notes(c.host))} posted=${posted.length} ` +
      `log=${JSON.stringify(c.host.logs.filter((line) => /^(pull|push|reconcile)/.test(line)))}`;
    for (const host of [a.host, c.host]) assert.deepEqual(notes(host), ["Renamed.md", "Sentinel.md"], tale);
    assert.equal(c.state.fileByPath("Renamed.md")?.fileId, id, tale);
    assert.equal(c.host.files.has("attachment.bin"), false, tale);
    assert.deepEqual(posted, [], tale);
  });
}
