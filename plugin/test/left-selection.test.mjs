/**
 * A NOTE THAT LEFT THE SELECTION, AND THE WIDENING THAT BRINGS IT BACK (issue
 * #239; owner ruling 2026-09-29: publish it as a move, one copy at the new name
 * on every device).
 *
 * A device that syncs a folder selection moves a note out of it (#91: nothing
 * is published, every other device keeps it at its old name), and later widens
 * its selection. Before 1.1.5 the widening published the moved note as a NEW
 * note and never brought the old one back: the other devices held two copies,
 * this one held one, and the status read synced. Here the device remembers
 * where the note went, publishes it as a move of the same file id once the
 * selection covers that name, and brings back what it holds nowhere.
 *
 * Two real engines over vaults that answer back (`fake.mjs`, `pair`): A is the
 * desktop with a selection, B syncs the whole vault. Every widening goes
 * through the plugin's real `saveSyncFolders`.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { KEYS, STEP_MS, pair, published, settled } from "./fake.mjs";

const require = createRequire(import.meta.url);
const { SyncEngine } = require("../build/sync/engine.js");

const NOTE = "LEFT SELECTION SENTINEL: the note that moves out\n";
const EDIT = "LEFT SELECTION SENTINEL: edited on the whole-vault device\n";
const ALTERED = NOTE.replace("moves out", "MOVES OUT");

/** A syncs `folders`, B the whole vault; `Sel/n.md` written on A and settled on both. */
async function rig(t, folders = ["Sel"]) {
  const r = await pair(t, "immediate", { isMobileB: false });
  const { server, timers, a, b } = r;
  a.state.data.syncFolders = folders;
  a.plugin.log = (line) => a.host.logs.push(line);
  // A new engine per start, as the plugin makes one (`main.ts`, `startEngine`).
  a.plugin.startEngine = async () => {
    const engine = new SyncEngine({ state: a.state, transport: a.transport, host: a.host, now: () => a.host.clock, timers });
    t.after(() => engine.stop());
    a.engine = a.plugin.engine = engine;
    await engine.start();
  };
  a.host.write("Sel/n.md", NOTE, 1000);
  await a.engine.start();
  await b.engine.start();
  await timers.run(STEP_MS, () => b.host.text("Sel/n.md") === NOTE && settled(b, "Sel/n.md") && settled(a, "Sel/n.md") &&
    a.state.data.lastSeq === server.seq && b.state.data.lastSeq === server.seq);
  r.id = a.state.fileByPath("Sel/n.md").fileId;
  return r;
}

/** Save a selection on A while a long poll is parked, as Settings does (`scope.test.mjs`, `save`). */
async function save(r, folders) {
  let done = false;
  const saving = r.a.plugin.saveSyncFolders(folders).finally(() => { done = true; });
  for (const deadline = Date.now() + 10000; !done; await new Promise((resolve) => setTimeout(resolve, 5))) {
    r.server.releaseFeed();
    if (Date.now() > deadline) throw new Error("the folder change never settled");
  }
  await saving;
}

/**
 * Both devices at the journal head, and nothing left to do on either: idle,
 * which a write still settling or posting is not, however busy the machine.
 */
async function quiet(r) {
  const { server, timers, a, b } = r;
  const done = () => a.state.data.lastSeq === server.seq && b.state.data.lastSeq === server.seq &&
    a.engine.current().kind === "idle" && b.engine.current().kind === "idle";
  await timers.run(STEP_MS, done);
  await timers.run(STEP_MS);
  await timers.run(STEP_MS, done);
}

const notes = (device) => [...device.host.files.keys()].filter((path) => path.endsWith(".md")).sort();
const story = (r) => [
  `a=${JSON.stringify(notes(r.a))} b=${JSON.stringify(notes(r.b))}`,
  `a_records=${JSON.stringify(Object.fromEntries(Object.entries(r.a.state.data.files).map(([p, x]) => [p, x.fileId.slice(0, 6)])))}`,
  `a_log=${JSON.stringify(r.a.host.logs.filter((line) => /^(pull|push|reconcile|feed|rename|scope)/.test(line)))}`,
].join(" ");
/** Every version of the note A posted since `from`, by what it carries. */
const posted = (r, from) => r.server.journal.slice(from).filter((frame) => frame.device_id === KEYS.deviceId && frame.sids.length > 0);
const paths = async (r, id) => (await published(r.server, id, r.keys.manifestKey)).map((manifest) => manifest.path);

/** Move a note's bytes to `to` as a file manager does: Obsidian reports only the half it can see. */
function moveBehind(device, from, to) {
  device.host.files.set(to, device.host.files.get(from));
  device.host.files.delete(from);
}

/*
 * However the move is seen -- Obsidian's own rename, a file manager's delete
 * beside a create Obsidian cannot see out there, or a pass at the next start
 * after a move made while Obsidian was closed -- where the note went is
 * remembered, and the widening publishes it as the move.
 */
for (const how of ["in Obsidian", "in a file manager", "while Obsidian was closed"]) {
  test(`a note moved out of the selection ${how} is published as a move when the selection widens: one copy everywhere (#239)`, async (t) => {
    const r = await rig(t);
    // A note of its own that stays, and one it deleted: neither is brought back.
    r.a.host.write("Sel/keep.md", "KEPT SENTINEL\n", 1500);
    r.a.host.write("Sel/gone.md", "GONE SENTINEL\n", 1500);
    await quiet(r);
    const ids = [r.id, r.a.state.fileByPath("Sel/keep.md").fileId, r.a.state.fileByPath("Sel/gone.md").fileId].sort();
    r.a.host.remove("Sel/gone.md");
    await quiet(r);
    if (how === "in Obsidian") r.a.host.rename("Sel/n.md", "Out/n.md");
    else if (how === "in a file manager") {
      moveBehind(r.a, "Sel/n.md", "Out/n.md");
      r.a.host.emit("delete", r.a.host.entry("Sel/n.md"));
    } else {
      await r.a.engine.stopAndWait();
      moveBehind(r.a, "Sel/n.md", "Out/n.md");
      await r.a.plugin.startEngine();
    }
    await quiet(r);
    assert.deepEqual(r.a.state.data.departed?.[r.id], { path: "Out/n.md", versionId: r.b.state.fileByPath("Sel/n.md")?.versionId, size: NOTE.length }, story(r));
    assert.deepEqual(notes(r.b), ["Sel/keep.md", "Sel/n.md"], "the move out of the selection was published");

    await save(r, undefined);
    await quiet(r);
    for (const device of [r.a, r.b]) {
      assert.deepEqual(notes(device), ["Out/n.md", "Sel/keep.md"], story(r));
      assert.equal(device.host.text("Out/n.md"), NOTE);
      assert.equal(device.state.fileByPath("Out/n.md")?.fileId, r.id, `not the same note: ${story(r)}`);
    }
    assert.deepEqual(await paths(r, r.id), ["Sel/n.md", "Out/n.md"], "the other device's history does not show the move");
    assert.deepEqual((await r.server.noteFiles(r.keys.manifestKey)).sort(), ids, "the widening published a second note");
    assert.deepEqual(r.a.state.data.departed, {});
    assert.ok(r.a.host.logs.some((line) => line.startsWith(`reconcile path_class=file decision=published_move reason=left_selection file=${r.id} budget_ms=`)), story(r));
    assert.deepEqual(r.a.host.logs.filter((line) => line.includes("decision=downloaded_again")), [], `a note held or deleted here was fetched again: ${story(r)}`);
  });
}

/*
 * WHAT ANOTHER DEVICE DID MEANWHILE. The note is not applied here while it is
 * out of the selection (#91), so it meets this device's move only when the
 * move is published, by the rules for a rename meeting an edit or a deletion
 * (#151, #106): the edit is kept at the new name, the deletion is not obeyed
 * over the move.
 */
for (const meanwhile of ["edited", "deleted"]) {
  test(`a note ${meanwhile} at its old name on another device while it was out ends as one note at the new name (#239)`, async (t) => {
    const r = await rig(t);
    r.a.host.rename("Sel/n.md", "Out/n.md");
    await quiet(r);
    if (meanwhile === "edited") r.b.host.write("Sel/n.md", EDIT, 2000);
    else r.b.host.remove("Sel/n.md");
    await quiet(r);
    assert.ok(r.a.host.logs.some((line) => line.startsWith(`pull path_class=file decision=skipped reason=left_selection file=${r.id} `)), story(r));
    assert.deepEqual(notes(r.a), ["Out/n.md"], `a note out of the selection came back at its old name: ${story(r)}`);

    await save(r, undefined);
    await quiet(r);
    const text = meanwhile === "edited" ? EDIT : NOTE;
    for (const device of [r.a, r.b]) {
      assert.deepEqual(notes(device), ["Out/n.md"], story(r));
      assert.equal(device.host.text("Out/n.md"), text, story(r));
      assert.equal(device.state.fileByPath("Out/n.md")?.fileId, r.id, story(r));
    }
    assert.deepEqual(await r.server.noteFiles(r.keys.manifestKey), [r.id], story(r));
  });
}

test("a widening to a selection that holds the note's new name and not its old one moves it (#239)", async (t) => {
  const r = await rig(t);
  r.a.host.rename("Sel/n.md", "Out/n.md");
  await quiet(r);
  await save(r, ["Out"]);
  await quiet(r);
  for (const device of [r.a, r.b]) assert.equal(device.state.fileByPath("Out/n.md")?.fileId, r.id, story(r));
  assert.deepEqual(notes(r.b), ["Out/n.md"], story(r));
  assert.deepEqual(await paths(r, r.id), ["Sel/n.md", "Out/n.md"]);
});

test("where the note went outlives a restart, and follows it when it moves again outside the selection (#239)", async (t) => {
  const r = await rig(t);
  r.a.host.rename("Sel/n.md", "Out/n.md");
  r.a.host.rename("Out/n.md", "Far/r.md");
  assert.equal(r.a.state.data.departed?.[r.id]?.path, "Far/r.md");
  await quiet(r);
  // Obsidian closed and opened again: a new engine over the state it saved.
  await r.a.engine.stopAndWait();
  const state = await r.a.reload();
  assert.equal(state.data.departed?.[r.id]?.path, "Far/r.md", "where the note went was not saved");
  r.a.state = r.a.plugin.state = state;
  await r.a.plugin.startEngine();

  await save(r, undefined);
  await quiet(r);
  for (const device of [r.a, r.b]) {
    assert.deepEqual(notes(device), ["Far/r.md"], story(r));
    assert.equal(device.state.fileByPath("Far/r.md")?.fileId, r.id, story(r));
  }
  assert.deepEqual(await paths(r, r.id), ["Sel/n.md", "Far/r.md"]);
});

test("a note moved back into a selected folder is published as a move, not as a new note (#239)", async (t) => {
  const r = await rig(t, ["Sel", "Back"]);
  r.a.host.rename("Sel/n.md", "Out/n.md");
  await quiet(r);
  r.a.host.rename("Out/n.md", "Back/n.md");
  await quiet(r);
  for (const device of [r.a, r.b]) {
    assert.deepEqual(notes(device), ["Back/n.md"], story(r));
    assert.equal(device.state.fileByPath("Back/n.md")?.fileId, r.id, story(r));
  }
  assert.ok(r.a.host.logs.includes(`rename path_class=file decision=published_move reason=moved_back file=${r.id}`), story(r));
});

/*
 * A NOTE THIS DEVICE HOLDS NOWHERE COMES BACK where every other device keeps
 * it (owner ruling: a record whose file is missing is never treated as held).
 * Its new name was deleted while it was out of the selection, or it went into
 * a hidden folder, which no selection covers and nothing publishes from.
 */
const FATES = {
  deleted: { to: "Out/n.md", then: (r) => r.a.host.remove("Out/n.md"), remembered: true, reason: "destination_gone" },
  hidden: { to: ".stash/n.md", remembered: false },
  "hidden later": { to: "Out/n.md", then: (r) => r.a.host.rename("Out/n.md", ".stash/n.md"), remembered: false },
  "in a linked folder": { to: "Out/n.md", then: (r) => r.a.host.unsyncable.add("Out/n.md"), remembered: true, reason: "destination_unsyncable" },
};
for (const [fate, { to, then, remembered, reason }] of Object.entries(FATES)) {
  test(`a note whose new name is ${fate} is downloaded again at its old name, and nothing is published (#239)`, async (t) => {
    const r = await rig(t);
    r.a.host.rename("Sel/n.md", to);
    then?.(r);
    const version = r.b.state.fileByPath("Sel/n.md").versionId;
    assert.deepEqual(r.a.state.data.departed, remembered ? { [r.id]: { path: to, versionId: version, size: NOTE.length } } : {});
    await quiet(r);
    const frames = r.server.journal.length;

    await save(r, undefined);
    await quiet(r);
    assert.equal(r.a.host.text("Sel/n.md"), NOTE, story(r));
    assert.equal(r.a.state.fileByPath("Sel/n.md")?.fileId, r.id, story(r));
    assert.deepEqual(notes(r.b), ["Sel/n.md"], story(r));
    assert.deepEqual(posted(r, frames), [], `the widening published a note: ${story(r)}`);
    if (fate !== "deleted") assert.equal(r.a.host.text(fate === "in a linked folder" ? to : ".stash/n.md"), NOTE, "the note where it went was touched");
    if (reason !== undefined) assert.ok(r.a.host.logs.some((line) => line.startsWith(`reconcile path_class=file decision=forgotten reason=${reason} file=${r.id} `)), story(r));
    assert.ok(r.a.host.logs.some((line) => line.startsWith(`feed path_class=file decision=downloaded_again reason=not_held outcome=applied file=${r.id} `)), story(r));
  });
}

test("a folder moved out of the selection, and renamed out there, is published as a move of its notes (#239)", async (t) => {
  const r = await rig(t);
  r.a.host.write("Sel/Sub/f.md", "FOLDER NOTE SENTINEL\n", 1500);
  await quiet(r);
  const id = r.a.state.fileByPath("Sel/Sub/f.md").fileId;
  r.a.host.renameFolder("Sel/Sub", "Out/Sub");
  r.a.host.renameFolder("Out/Sub", "Out/Moved");
  assert.equal(r.a.state.data.departed?.[id]?.path, "Out/Moved/f.md", story(r));
  await quiet(r);
  await save(r, undefined);
  await quiet(r);
  for (const device of [r.a, r.b]) {
    assert.deepEqual(notes(device), ["Out/Moved/f.md", "Sel/n.md"], story(r));
    assert.equal(device.state.fileByPath("Out/Moved/f.md")?.fileId, id, story(r));
  }
});

/*
 * A NOTE OUT OF THE SELECTION TAKES NOTHING, large ones included: a version
 * the background lane would download is not fetched for a note this device
 * no longer syncs (#196, #239).
 */
test("a large note out of the selection is not downloaded when another device changes it (#239)", async (t) => {
  const r = await rig(t);
  const big = (fill) => new Uint8Array((32 << 20) + 1).fill(fill);
  // Only the newer, out-of-selection version is under test. Seed A with
  // B's acknowledged initial bytes/record instead of decrypting 32 MiB just
  // to arrange the move; keep the normal STEP_MS deadline for the behavior.
  const initial = big(1);
  await r.a.engine.stopAndWait();
  r.b.host.write("Sel/big.bin", initial, 2000);
  await r.timers.run(STEP_MS, () => settled(r.b, "Sel/big.bin"));
  const record = r.b.state.fileByPath("Sel/big.bin");
  r.a.host.seed("Sel/big.bin", initial.slice(), 2000);
  r.a.state.setFile("Sel/big.bin", { ...record });
  await r.a.plugin.startEngine();
  await r.timers.run(STEP_MS, () => settled(r.a, "Sel/big.bin") && r.a.state.data.lastSeq === r.server.seq);
  const id = record.fileId;
  r.a.host.rename("Sel/big.bin", "Out/big.bin");
  const lines = r.a.host.logs.length;
  const requests = r.server.requests.length;
  const was = r.b.state.fileByPath("Sel/big.bin").versionId;
  r.b.host.write("Sel/big.bin", big(2), 3000);
  await r.timers.run(STEP_MS, () => r.b.state.fileByPath("Sel/big.bin")?.versionId !== was && r.a.state.data.lastSeq === r.server.seq);
  await quiet(r);
  const said = r.a.host.logs.slice(lines);
  assert.deepEqual(said.filter((line) => line.includes(`decision=backgrounded reason=large`) && line.includes(`file=${id}`)), [], said.join(" | "));
  assert.ok(said.some((line) => line.startsWith(`pull path_class=file decision=skipped reason=left_selection file=${id} `)), said.join(" | "));
  assert.deepEqual(notes(r.a), ["Out/big.bin", "Sel/n.md"].filter((path) => path.endsWith(".md")), story(r));
  assert.equal(r.a.host.text("Sel/big.bin"), null);
  assert.deepEqual(r.a.host.files.get("Out/big.bin").bytes, initial);
  assert.deepEqual(r.server.requests.slice(requests).filter((request) =>
    request.target.startsWith("/v1/chunks/") && (request.method === "GET" || request.target === "/v1/chunks/get")), [],
  "the out-of-selection version fetched chunks");
});

/*
 * A note that left the selection, held here again under another name by the
 * time its name comes back into it -- a data file rolled back or copied can
 * say so -- is never recorded twice: where it went is forgotten, and the file
 * there is published as a note of its own.
 */
test("a note held here under another name is not moved again when its old destination comes back (#239)", async (t) => {
  const r = await rig(t);
  r.a.host.rename("Sel/n.md", "Out/n.md");
  await quiet(r);
  const version = r.a.state.data.departed[r.id].versionId;
  r.a.host.seed("Sel/back.md", NOTE, 5000);
  r.a.state.setFile("Sel/back.md", { fileId: r.id, versionId: version, mtime: 5000, size: NOTE.length, sha256: r.b.state.fileByPath("Sel/n.md").sha256 });
  await save(r, undefined);
  await quiet(r);
  assert.ok(r.a.host.logs.some((line) => line.startsWith(`reconcile path_class=file decision=forgotten reason=held_elsewhere file=${r.id} `)), story(r));
  assert.equal(r.a.state.pathByFileId(r.id), "Sel/back.md", story(r));
  assert.notEqual(r.a.state.fileByPath("Out/n.md")?.fileId, r.id, story(r));
  assert.deepEqual(r.a.state.data.departed, {});
});

/*
 * A MOVE NOTHING REMEMBERED: made before 1.1.5 (its state carries no
 * `departed`), or by a move no pass saw. The note at the new name IS this
 * device's own newest version of it, chunk for chunk, and its old name holds
 * nothing here: it is that note, moved. A file that is not byte for byte that
 * version is a new note, and the old one comes back: two copies, nothing lost.
 */
for (const copy of ["identical", "edited"]) {
  test(`a move made before 1.1.5, its file ${copy}, is ${copy === "identical" ? "published as that move" : "kept beside the note brought back"} (#239)`, async (t) => {
    const r = await rig(t);
    r.a.host.rename("Sel/n.md", "Out/n.md");
    r.a.state.data.departed = {};
    // The same size, so only its bytes tell it from the note.
    if (copy === "edited") r.a.host.seed("Out/n.md", ALTERED, 3000);
    await quiet(r);

    await save(r, undefined);
    await quiet(r);
    if (copy === "identical") {
      for (const device of [r.a, r.b]) {
        assert.deepEqual(notes(device), ["Out/n.md"], story(r));
        assert.equal(device.state.fileByPath("Out/n.md")?.fileId, r.id, story(r));
      }
      assert.ok(r.a.host.logs.some((line) => line.startsWith(`reconcile path_class=file decision=published_move reason=identical file=${r.id} `)), story(r));
      return;
    }
    for (const device of [r.a, r.b]) {
      assert.deepEqual(notes(device), ["Out/n.md", "Sel/n.md"], story(r));
      assert.equal(device.host.text("Sel/n.md"), NOTE);
      assert.equal(device.host.text("Out/n.md"), ALTERED);
      assert.equal(device.state.fileByPath("Sel/n.md")?.fileId, r.id, story(r));
    }
  });
}

test("a copy of a note still out of the selection is not taken for its move (#239)", async (t) => {
  const r = await rig(t, ["Sel"]);
  r.a.host.rename("Sel/n.md", "Out/n.md");
  await quiet(r);
  // A second file, byte for byte the note, in the folder the widening adds.
  r.a.host.seed("Other/copy.md", NOTE, 4000);
  await save(r, ["Sel", "Other"]);
  await quiet(r);
  assert.deepEqual(r.a.state.data.departed?.[r.id]?.path, "Out/n.md", story(r));
  assert.notEqual(r.a.state.fileByPath("Other/copy.md")?.fileId, r.id, `the copy was taken for the note: ${story(r)}`);
  assert.deepEqual(notes(r.b), ["Other/copy.md", "Sel/n.md"], story(r));
  // Nor is the note brought back to the name it left, or even asked for: it is still out.
  assert.deepEqual(notes(r.a), ["Other/copy.md", "Out/n.md"], story(r));
  assert.ok(!r.a.host.logs.some((line) => line.includes("decision=downloaded_again")), story(r));
});

/*
 * AND A MOVE NOTHING REMEMBERED IS NOT GUESSED on less than the proof: the
 * version is this device's own, its name is in the selection and holds
 * nothing here, and exactly one file -- one no other note stands at, and one
 * that is no other lost note -- is it. Short of that, the file is a note of
 * its own and the note comes back where it was: two copies, nothing lost.
 */
const UNPROVED = {
  "another device wrote the note last": async (r) => {
    r.b.host.write("Sel/n.md", EDIT, 2000);
    await quiet(r);
    r.a.host.rename("Sel/n.md", "Out/n.md");
    return { a: ["Out/n.md", "Sel/n.md"], b: ["Out/n.md", "Sel/n.md"], at: "Sel/n.md" };
  },
  "two files are the note": async (r) => {
    r.a.host.rename("Sel/n.md", "Out/n.md");
    r.a.host.seed("Out/copy.md", NOTE, 1000);
    return { a: ["Out/copy.md", "Out/n.md", "Sel/n.md"], b: ["Out/copy.md", "Out/n.md", "Sel/n.md"], at: "Sel/n.md" };
  },
  "the file is two notes": async (r) => {
    r.a.host.write("Sel/twin.md", NOTE, 1000);
    await quiet(r);
    r.a.host.rename("Sel/n.md", "Out/n.md");
    r.a.host.rename("Sel/twin.md", "Out/twin.md");
    r.a.host.remove("Out/twin.md");
    return { a: ["Out/n.md", "Sel/n.md", "Sel/twin.md"], b: ["Out/n.md", "Sel/n.md", "Sel/twin.md"], at: "Sel/n.md" };
  },
  "another note stands at that name": async (r) => {
    r.a.host.rename("Sel/n.md", "Out/n.md");
    r.b.host.write("Out/n.md", NOTE, 1000);
    await quiet(r);
    return { a: ["Out/n.md", "Sel/n.md"], b: ["Out/n.md", "Sel/n.md"], at: "Sel/n.md" };
  },
  "its old name still stands here": async (r) => {
    r.a.host.seed("Out/n.md", NOTE, 1000);
    // Its record lost, the moment before the widening: a pass between would publish the file.
    const late = () => { delete r.a.state.data.files["Sel/n.md"]; };
    return { a: ["Out/n.md", "Sel/n.md"], b: ["Out/n.md", "Sel/n.md"], at: "Sel/n.md", late };
  },
};
for (const [why, arrange] of Object.entries(UNPROVED)) {
  test(`a move made before 1.1.5 is not guessed when ${why} (#239)`, async (t) => {
    const r = await rig(t);
    const expected = await arrange(r);
    r.a.state.data.departed = {};
    await quiet(r);
    expected.late?.();
    await save(r, undefined);
    await quiet(r);
    assert.deepEqual(notes(r.a), expected.a, story(r));
    assert.deepEqual(notes(r.b), expected.b, story(r));
    assert.equal(r.a.state.fileByPath(expected.at)?.fileId, r.id, story(r));
    assert.equal(r.b.state.fileByPath(expected.at)?.fileId, r.id, story(r));
    assert.ok(!r.a.host.logs.some((line) => line.includes("decision=published_move")), story(r));
  });
}

test("a move made before 1.1.5 is not guessed when the note's old name is outside the selection (#239)", async (t) => {
  const r = await rig(t, ["Sel", "Other"]);
  r.a.host.write("Other/x.md", NOTE, 1000);
  await quiet(r);
  const id = r.a.state.fileByPath("Other/x.md").fileId;
  await save(r, ["Sel"]);
  await quiet(r);
  // Its record lost, and a copy of it where the widening will look.
  delete r.a.state.data.files["Other/x.md"];
  r.a.host.seed("New/x.md", NOTE, 1000);
  await save(r, ["Sel", "New"]);
  await quiet(r);
  assert.equal(r.b.state.fileByPath("Other/x.md")?.fileId, id, `the note was moved from a name this device does not sync: ${story(r)}`);
  assert.notEqual(r.b.state.fileByPath("New/x.md")?.fileId, id, story(r));
  assert.equal(r.a.host.text("Other/x.md"), NOTE);
});

test("a post in flight when its note leaves the selection is the version the move is published on (#239)", async (t) => {
  const r = await rig(t);
  const post = r.a.transport.postVersion.bind(r.a.transport);
  r.a.transport.postVersion = async (...args) => {
    if (args[1].sids.length === 0) return post(...args);
    r.a.transport.postVersion = post;
    r.a.host.rename("Sel/n.md", "Out/n.md");
    return post(...args);
  };
  r.a.host.write("Sel/n.md", EDIT, 2000);
  await quiet(r);
  const edit = r.b.state.fileByPath("Sel/n.md")?.versionId;
  assert.equal(r.b.host.text("Sel/n.md"), EDIT, story(r));
  assert.equal(r.a.state.data.departed?.[r.id]?.versionId, edit, `the move waits on the version before the edit: ${story(r)}`);

  await save(r, undefined);
  await quiet(r);
  assert.equal(r.server.files.get(r.id).heads.length, 1, `the move forked the note: ${story(r)}`);
  for (const device of [r.a, r.b]) assert.equal(device.host.text("Out/n.md"), EDIT, story(r));
});

// As a rename does (`rename.test.mjs`, #151): a version recorded meanwhile by
// anything but this post is not replaced by it.
test("a post in flight when its note leaves does not replace a version recorded for it meanwhile (#239)", async (t) => {
  const r = await rig(t);
  const meanwhile = "e".repeat(64);
  const post = r.a.transport.postVersion.bind(r.a.transport);
  r.a.transport.postVersion = async (...args) => {
    if (args[1].sids.length === 0) return post(...args);
    r.a.transport.postVersion = post;
    r.a.host.rename("Sel/n.md", "Out/n.md");
    r.a.state.data.departed[r.id].versionId = meanwhile;
    return post(...args);
  };
  r.a.host.write("Sel/n.md", EDIT, 2000);
  await quiet(r);
  assert.equal(r.a.state.data.departed[r.id]?.versionId, meanwhile, story(r));
  assert.ok(r.a.host.logs.includes(`push path_class=file decision=not_recorded reason=path_gone parent=kept file=${r.id}`), story(r));
});

/*
 * A WIDENING THAT DID NOT CATCH UP (issue #281): Obsidian quit part way
 * through its replay, another folder change was saved before it caught up,
 * or the bring-back itself was cut short. What the replay had noted rides the
 * saves it already made, and the next start carries on from there: the note
 * this device holds nowhere still comes back at its old name, and nothing is
 * published.
 */

/** Obsidian closed and opened again: a new engine over the state it saved. */
async function reopen(r) {
  await r.a.engine.stopAndWait();
  r.a.state = r.a.plugin.state = await r.a.reload();
  await r.a.plugin.startEngine();
}

/** The last feed entry of a file. */
const lastOf = (r, id) => Math.max(...r.server.journal.filter((frame) => frame.file_id === id).map((frame) => frame.seq));

/** A replay read one entry a page, and stopped at its first read once it has passed `seq`. */
function stopAfter(r, seq) {
  const changes = r.a.transport.changes.bind(r.a.transport);
  const hook = { stopped: false, restore: () => { r.a.transport.changes = changes; } };
  r.a.transport.changes = async (since, wait, limit, patience) => {
    const cursor = r.a.state.data.lastSeq;
    if (!hook.stopped && cursor >= seq && cursor < r.server.seq) {
      hook.stopped = true;
      r.a.engine.stop();
    }
    return changes(since, wait, hook.stopped ? limit : 1, patience);
  };
  return hook;
}

test("a widening stopped before it caught up brings the note back at the next start, and publishes nothing (#281)", async (t) => {
  const r = await rig(t);
  r.a.host.rename("Sel/n.md", ".stash/n.md");
  // Something after the note, so its replay is not over when it stops.
  r.b.host.write("Sel/later.md", EDIT, 3000);
  await quiet(r);
  const frames = r.server.journal.length;
  const hook = stopAfter(r, lastOf(r, r.id));
  await save(r, undefined);
  await r.timers.run(STEP_MS, () => hook.stopped && !r.a.engine.started);
  hook.restore();

  await reopen(r);
  await quiet(r);
  assert.equal(r.a.host.text("Sel/n.md"), NOTE, story(r));
  assert.equal(r.a.state.fileByPath("Sel/n.md")?.fileId, r.id, story(r));
  assert.equal(r.a.host.text(".stash/n.md"), NOTE);
  assert.deepEqual(posted(r, frames), [], `the replay published a note: ${story(r)}`);
  assert.ok(r.a.host.logs.some((line) => line.startsWith("feed decision=resumed reason=replay_unfinished noted=1 ")), story(r));
  assert.equal(r.a.state.data.replaying, null, story(r));
});

test("a widening saved again before the first caught up keeps what the first had read, and brings the note back (#281)", async (t) => {
  const r = await rig(t);
  r.a.host.rename("Sel/n.md", ".stash/n.md");
  await quiet(r);
  const frames = r.server.journal.length;
  // Stopped after the first entry: long before the note's own version.
  const hook = stopAfter(r, 1);
  await save(r, ["Sel", "Other"]);
  await r.timers.run(STEP_MS, () => hook.stopped && !r.a.engine.started);
  hook.restore();
  assert.ok((r.a.state.data.feedMark?.seq ?? 0) < lastOf(r, r.id), story(r));

  await save(r, undefined);
  await quiet(r);
  assert.equal(r.a.host.text("Sel/n.md"), NOTE, story(r));
  assert.equal(r.a.state.fileByPath("Sel/n.md")?.fileId, r.id, story(r));
  assert.deepEqual(posted(r, frames), [], `the replay published a note: ${story(r)}`);
});

test("a bring-back a stop cut short goes on at the next start (#281)", async (t) => {
  const r = await rig(t);
  r.a.host.write("Sel/m.md", EDIT, 2000);
  await r.timers.run(STEP_MS, () => settled(r.a, "Sel/m.md") && settled(r.b, "Sel/m.md"));
  const second = r.a.state.fileByPath("Sel/m.md").fileId;
  r.a.host.rename("Sel/n.md", ".stash/n.md");
  r.a.host.rename("Sel/m.md", ".stash/m.md");
  await quiet(r);
  const frames = r.server.journal.length;
  // Obsidian quits while the first of the two is being read: that read fails.
  const getFile = r.a.transport.getFile.bind(r.a.transport);
  let cut = false;
  r.a.transport.getFile = async (id, ...rest) => {
    if (!cut && (id === r.id || id === second)) {
      cut = true;
      r.a.engine.stop();
      throw new Error("the request was cancelled by the stop");
    }
    return getFile(id, ...rest);
  };
  await save(r, undefined);
  await r.timers.run(STEP_MS, () => cut && !r.a.engine.started);
  r.a.transport.getFile = getFile;

  await reopen(r);
  await quiet(r);
  assert.equal(r.a.host.text("Sel/n.md"), NOTE, story(r));
  assert.equal(r.a.host.text("Sel/m.md"), EDIT, story(r));
  assert.deepEqual(posted(r, frames), [], `the replay published a note: ${story(r)}`);
});
