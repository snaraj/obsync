/**
 * One notice channel (1.1.5; owner, 2026-09-29: notices "sharp, timely, human
 * readable", and "anything that has predeterministic options like this can
 * just be toggable configuration items").
 *
 * Every notice goes through `NoticeChannel` (`notices.ts`): a note by its
 * title and a device by its name, a repeat of the same event inside the toast
 * already up, a flood folded into one "N more", everything kept in Recent,
 * and two settings -- the level, and how combined edits are announced -- set
 * from Settings, the palette and Obsidian's CLI. No setting ever keeps a
 * question or a security notice off the screen (AGENTS.md requirement 4);
 * `fake.mjs` also runs the whole suite under the quietest settings and
 * refuses any control the channel did not show.
 *
 * WHAT IS EXERCISED. The compiled channel with a recording screen, on a
 * virtual clock; the compiled plugin, dialog and settings tab over the
 * sandbox's Obsidian stub. The real toast, the real command line and two
 * real devices typing are the rig's (docs/validation-runs/2026-09-29-notices.md).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { FakeHost, KEYS, memorySecrets, sandbox, statusItem } from "./fake.mjs";

const require = createRequire(import.meta.url);
const n = require("../build/notices.js");
const { State, parseData } = require("../build/state.js");

const COMBINED = "combined your edits to {notes} with {device}'s.";
const combine = (path, device = "MacBook") => ({ kind: "combined", text: COMBINED, paths: [path], device });

/** A channel on a clock the test moves, drawing into a list. */
function channel(settings = { level: "everything", merges: "once" }) {
  let now = 1_000_000;
  const toasts = [], logs = [], opened = [];
  const made = new n.NoticeChannel({
    draw: (text, ms, actions, open) => {
      const toast = { text, ms, actions, open, hidden: false, at: now };
      toasts.push(toast);
      return { update: (words) => { toast.text = words; }, hide: () => { toast.hidden = true; }, shown: () => !toast.hidden };
    },
    settings: () => settings,
    now: () => now,
    log: (line) => logs.push(line),
    showStatus: () => opened.push("status"),
  });
  return { channel: made, toasts, logs, opened, settings, advance: (ms) => { now += ms; }, now: () => now };
}

// --- words -----------------------------------------------------------------

test("a note is its title: no .md, an attachment keeps its extension, two notes with one title keep their folders", () => {
  assert.deepEqual(n.titles(["Deep/Folder/Both-mun1mwp3.md"]), ["Both-mun1mwp3"]);
  assert.deepEqual(n.titles(["Files/scan.pdf", "notes.md.bak"]), ["scan.pdf", "notes.md.bak"]);
  assert.deepEqual(n.titles(["Work/Plan.md", "Home/Plan.md", "Log.md"]), ["Work/Plan", "Home/Plan", "Log"]);
  assert.equal(n.named(["Plan.md"]), "\"Plan\"");
  assert.equal(n.named(["Plan.md", "Log.md"]), "2 notes (\"Plan\" and \"Log\")");
  assert.equal(n.named(["A.md", "B.md", "C.md", "A.md"]), "3 notes (\"A\", \"B\" and 1 more)", "one note twice is one note");
  assert.equal(n.named(["A.md", "scan.pdf"]), "2 files (\"A\" and \"scan.pdf\")");
  assert.equal(n.named([]), "a note");
});

test("a notice says the note's title and the device's name, never a path or an id, and says again how many times", () => {
  const text = n.sentence(combine("Deep/Folder/Both-mun1mwp3.md"));
  assert.equal(text, "combined your edits to \"Both-mun1mwp3\" with MacBook's.");
  assert.doesNotMatch(text, /Deep\/|\.md|[0-9a-f]{16}/);
  assert.equal(n.sentence({ ...combine("Both.md"), device: undefined }), "combined your edits to \"Both\" with another device's.");
  assert.equal(n.sentence(combine("Both.md"), ["Both.md"], 3), "combined your edits to \"Both\" with MacBook's (3 times).");
  assert.equal(n.sentence({ kind: "info", text: "{notes} holds {device}" , paths: ["{device}.md"], device: "X" }), "\"{device}\" holds X",
    "a title is never read as a slot");
  assert.equal(n.scrub(`File id ${"ab".repeat(16)} and ${KEYS.deviceId}, not 2026-09-29`), "File id … and …, not 2026-09-29");
});

test("the two settings read back onto their defaults, and nothing unreadable ever becomes a value", () => {
  assert.deepEqual(n.noticeSettings(undefined), { level: "everything", merges: "once" });
  assert.deepEqual(n.noticeSettings({ level: "needs-me", merges: "off" }), { level: "needs-me", merges: "off" });
  for (const damaged of [null, "needs-me", [], { level: "silent", merges: 7 }, { level: "NEEDS-ME", merges: "Every" }]) {
    assert.deepEqual(n.noticeSettings(damaged), { level: "everything", merges: "once" }, JSON.stringify(damaged));
  }
  // A 1.1.4 data file has no `notices`: it loads as the defaults.
  assert.deepEqual(parseData({ recoveryPhrase: "confirmed" }, false).notices, { level: "everything", merges: "once" });
  assert.deepEqual(parseData({ notices: { level: "needs-me", merges: "every" } }, true).notices, { level: "needs-me", merges: "every" });
});

test("a 1.1.4 vault opens with the defaults, and what this build saves still loads in 1.1.4: storage version 1, one new field", async () => {
  let saved = null;
  const store = { loadData: async () => saved, saveData: async (value) => { saved = structuredClone(value); } };
  const secrets = memorySecrets();
  const state = await State.open(store, false, secrets);
  assert.deepEqual(state.data.notices, { level: "everything", merges: "once" });
  state.data.notices = { level: "needs-me", merges: "every" };
  await state.save();
  // 1.1.4 refuses any storage version but 1 and reads only the fields it knows (`state.ts`, `parseData`).
  assert.equal(saved.storageVersion, 1);
  assert.deepEqual(saved.notices, { level: "needs-me", merges: "every" });
  const again = await State.open(store, false, secrets);
  assert.deepEqual(again.data.notices, { level: "needs-me", merges: "every" }, "the choice survives a restart");
});

// --- requirement 4 ---------------------------------------------------------

test("NO SETTING SILENCES A CONTROL: a question and a security notice reach the screen under every setting, on every platform, however full it is", () => {
  const settings = [];
  for (const [level] of n.LEVELS) for (const [merges] of n.MERGES) settings.push({ level, merges });
  // And values no parse would ever produce: the channel reads what it is given.
  settings.push({ level: "silent", merges: "never" }, {});
  for (const isMobile of [false, true]) {
    for (const chosen of settings) {
      const host = new FakeHost({ isMobile });
      host.noticeSettings = chosen;
      // A screen already full of notices, and a folded one beyond it.
      for (let i = 0; i <= n.VISIBLE_MAX; i++) host.notify({ kind: "error", text: `ERROR ${i} SENTINEL.` });
      for (const kind of n.NON_MUTABLE) {
        const before = host.toasts.length;
        host.notify({ kind, text: `${kind} SENTINEL: do this now.`, key: kind });
        const drawn = host.toasts.slice(before);
        const said = kind === "security" ? "obsync security warning" : "obsync";
        assert.deepEqual(drawn.map((toast) => [toast.text, toast.ms, toast.hidden]), [[`${said}: ${kind} SENTINEL: do this now.`, 0, false]],
          `${kind} on ${isMobile ? "a phone" : "a desktop"} under ${JSON.stringify(chosen)}`);
      }
      // The held-deletions question, as the engine asks it (`HELD`).
      host.notify({ kind: "question", key: n.HELD, text: "3 deletions are still held back. Delete them there too?", actions: [{ kind: "delete_everywhere" }, { kind: "restore_here" }] });
      assert.equal(host.toasts.at(-1).ms, 0);
      assert.equal(host.toasts.at(-1).hidden, false);
    }
  }
  assert.deepEqual([...n.NON_MUTABLE].sort(), ["question", "security"]);
});

test("the quietest level still shows errors, conflict copies and the answer to the person's own click; info and combined edits go to Recent", () => {
  for (const isMobile of [false, true]) {
    for (const [level, shown] of [["everything", ["error", "conflict", "confirm", "info", "combined"]], ["needs-me", ["error", "conflict", "confirm"]]]) {
      const host = new FakeHost({ isMobile });
      host.noticeSettings = { level, merges: "every" };
      for (const kind of ["error", "conflict", "confirm", "info", "combined"]) {
        host.clock += 60_000;
        host.notify({ kind, text: `${kind} SENTINEL on {notes}.`, paths: [`${kind}.md`] });
      }
      assert.deepEqual(host.toasts.map((toast) => toast.text.match(/^obsync: (\w+) SENTINEL/)[1]), shown, `${level}, ${isMobile ? "phone" : "desktop"}`);
      assert.equal(host.channel.recent().length, 5, "Recent keeps every one");
    }
  }
});

// --- combined edits: the owner's two rigs typing into one note ----------------

/** Two devices typing into one note: a combine every two seconds for a minute, as the rig measured. */
function typing(c, path = "Both-mun1mwp3.md", seconds = 60) {
  for (let at = 0; at <= seconds; at += 2) {
    c.channel.show(combine(path));
    c.advance(2000);
  }
}

/** Recent after thirty-one combines in a row: one line that counts every one. */
const TYPED = ["combined your edits to \"Both-mun1mwp3\" with MacBook's (31 times)."];

test("Once per note: the first combine in a note is shown, the rest of the session is not, and Recent counts every one", () => {
  const c = channel({ level: "everything", merges: "once" });
  typing(c);
  assert.deepEqual(c.toasts.map((toast) => toast.text), ["obsync: combined your edits to \"Both-mun1mwp3\" with MacBook's."]);
  assert.deepEqual(c.channel.recent().map((entry) => entry.text), TYPED, "every combine is in Recent, counted");
  assert.ok(c.logs.some((line) => /^notice decision=quiet kind=combined reason=once_per_note since_ms=2000 budget_ms=300000$/.test(line)), c.logs.join(" | "));
  // Five minutes without one, and the next is news again.
  c.advance(n.ONCE_IDLE_MS);
  c.channel.show(combine("Both-mun1mwp3.md"));
  assert.equal(c.toasts.length, 2);
});

test("Once per note counts the quiet from the LATEST combine, so a slow session of edits stays one notice", () => {
  const c = channel({ level: "everything", merges: "once" });
  for (let i = 0; i < 4; i++) {
    c.channel.show(combine("Slow.md"));
    c.advance(4 * 60_000);
  }
  assert.equal(c.toasts.length, 1, "twelve minutes of combines four minutes apart are one session");
});

test("Once per note: another note combined while the first is up joins its toast, by title", () => {
  const c = channel({ level: "everything", merges: "once" });
  c.channel.show(combine("Plan.md"));
  c.advance(1000);
  c.channel.show(combine("Work/Log.md"));
  assert.equal(c.toasts.length, 1);
  assert.equal(c.toasts[0].text, "obsync: combined your edits to 2 notes (\"Plan\" and \"Log\") with MacBook's.");
  c.channel.show(combine("Log.md", "iPhone"));
  assert.equal(c.toasts.length, 2, "another device is another event");
});

test("Every time: each combine is shown, repeats counted on the toast that is up, a new toast once it has gone", () => {
  const c = channel({ level: "everything", merges: "every" });
  typing(c);
  // A toast lasts eight seconds: combines at 0, 2, 4 and 6 s are one toast, and so on to 60 s.
  assert.equal(c.toasts.length, 8, c.toasts.map((toast) => toast.text).join(" | "));
  assert.equal(c.toasts[0].text, "obsync: combined your edits to \"Both-mun1mwp3\" with MacBook's (4 times).");
  assert.ok(c.toasts.every((toast) => toast.ms === 8000));
  assert.deepEqual(c.channel.recent().map((entry) => entry.text), TYPED);
});

test("Recent only, and Only what needs me, keep every combine off the screen and in Recent", () => {
  for (const settings of [{ level: "everything", merges: "off" }, { level: "needs-me", merges: "once" }, { level: "needs-me", merges: "every" }]) {
    const c = channel(settings);
    typing(c);
    assert.deepEqual(c.toasts, [], JSON.stringify(settings));
    assert.deepEqual(c.channel.recent().map((entry) => entry.text), TYPED);
    assert.ok(c.logs.every((line) => line.startsWith("notice decision=quiet kind=combined reason=setting ")), c.logs[0]);
  }
});

// --- floods, questions, Recent ---------------------------------------------

test("the same notice again with nothing between is one Recent line that counts it, so sixty presses never push a warning out", () => {
  const c = channel();
  c.channel.show({ kind: "security", key: "w", text: "WARNING SENTINEL." });
  for (let i = 0; i < 60; i++) {
    c.advance(250);
    c.channel.show({ kind: "confirm", text: "NOTHING SENTINEL." });
  }
  const recent = c.channel.recent();
  assert.deepEqual(recent.map((entry) => [entry.kind, entry.text]), [["confirm", "NOTHING SENTINEL (60 times)."], ["security", "WARNING SENTINEL."]]);
  assert.equal(recent[0].at, c.now(), "the line keeps the latest time");
  // Another device, another note, or anything between is a line of its own.
  c.channel.show(combine("Plan.md"));
  c.channel.show(combine("Plan.md", "iPhone"));
  c.channel.show(combine("Log.md", "iPhone"));
  c.channel.show(combine("Log.md", "iPhone"));
  assert.deepEqual(c.channel.recent().slice(0, 3).map((entry) => entry.text), [
    "combined your edits to \"Log\" with iPhone's (2 times).",
    "combined your edits to \"Plan\" with iPhone's.",
    "combined your edits to \"Plan\" with MacBook's.",
  ]);
  // The same words about another note or device are another line too, whose Open and device are its own.
  c.channel.show({ kind: "info", text: "MOVED SENTINEL.", paths: ["One.md"] });
  c.channel.show({ kind: "info", text: "MOVED SENTINEL.", paths: ["Two.md"] });
  c.channel.show({ kind: "error", text: "KEY SENTINEL.", device: "Phone" });
  c.channel.show({ kind: "error", text: "KEY SENTINEL.", device: "Laptop" });
  assert.deepEqual(c.channel.recent().slice(0, 4).map((entry) => [entry.text, entry.paths, entry.device]), [
    ["KEY SENTINEL.", [], "Laptop"], ["KEY SENTINEL.", [], "Phone"], ["MOVED SENTINEL.", ["Two.md"], undefined], ["MOVED SENTINEL.", ["One.md"], undefined],
  ]);
});

test("a flood is three toasts and one 'N more' that opens Show sync status; an error folded in keeps it up; a question is never folded", () => {
  const c = channel();
  for (let i = 0; i < 5; i++) c.channel.show({ kind: "info", text: `INFO ${i}.` });
  assert.deepEqual(c.toasts.map((toast) => [toast.text, toast.ms]), [
    ["obsync: INFO 0.", 8000], ["obsync: INFO 1.", 8000], ["obsync: INFO 2.", 8000], ["obsync: 2 more — see Recent in Show sync status.", 8000],
  ]);
  c.toasts[3].open();
  assert.deepEqual(c.opened, ["status"]);
  c.channel.show({ kind: "error", text: "ERROR SENTINEL." });
  assert.equal(c.toasts[3].hidden, true, "the timed one is replaced");
  assert.deepEqual([c.toasts[4].text, c.toasts[4].ms], ["obsync: 3 more — see Recent in Show sync status.", 0], "and it stays until dismissed");
  c.channel.show({ kind: "info", text: "INFO 5." });
  assert.equal(c.toasts[4].text, "obsync: 4 more — see Recent in Show sync status.");
  c.channel.show({ kind: "question", text: "QUESTION?", key: "q", actions: [{ kind: "restore_here" }] });
  assert.deepEqual([c.toasts.at(-1).text, c.toasts.at(-1).ms], ["obsync: QUESTION?", 0]);
  // The first three go by, and the screen has room again.
  c.advance(8000);
  c.channel.show({ kind: "info", text: "INFO 6." });
  assert.equal(c.toasts.at(-1).text, "obsync: INFO 6.");
  assert.equal(c.channel.recent().length, 9, "every one of them is in Recent");
  assert.ok(c.logs.includes("notice decision=folded kind=info visible=3 budget=3 count=1"), c.logs.join(" | "));
});

test("a toast dismissed by a click no longer counts against the screen", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const main = box.require(join(box.home, "build", "main.js"));
  const { raised } = box.require("obsidian");
  const plugin = { state: { data: {} }, log: () => undefined, act: () => undefined, showStatus: () => undefined };
  plugin.notices = main.noticeChannel(plugin);
  const from = raised.length;
  for (let i = 0; i < n.VISIBLE_MAX; i++) plugin.notices.show({ kind: "info", text: `INFO ${i}.` });
  for (const notice of raised.slice(from)) notice.containerEl.dispatch("click");
  plugin.notices.show({ kind: "info", text: "AFTER." });
  assert.deepEqual(raised.slice(from).map((notice) => notice.message).at(-1), "obsync: AFTER.");
});

test("a notice with buttons is its own toast: joined, its button would act for the first note only", () => {
  const c = channel();
  for (const id of ["aa", "bb"]) c.channel.show({ kind: "info", text: "{notes} waits on the server.", paths: [`${id}.bin`], actions: [{ kind: "fetch", fileId: id.repeat(16) }] });
  assert.deepEqual(c.toasts.map((toast) => [toast.text, toast.actions[0].fileId]), [
    ["obsync: \"aa.bin\" waits on the server.", "aa".repeat(16)], ["obsync: \"bb.bin\" waits on the server.", "bb".repeat(16)],
  ]);
});

test("a question replaces the question of its key, and closing it takes it away; an offer to fetch is not a question", () => {
  const c = channel({ level: "everything", merges: "off" });
  c.channel.show({ kind: "question", text: "FIRST?", key: n.HELD, actions: [{ kind: "restore_here" }] });
  c.channel.show({ kind: "question", text: "SECOND?", key: n.HELD, actions: [{ kind: "restore_here" }] });
  assert.deepEqual(c.toasts.map((toast) => toast.hidden), [true, false]);
  c.channel.close(n.HELD);
  assert.deepEqual(c.toasts.map((toast) => toast.hidden), [true, true]);
  c.channel.show({ kind: "info", text: "{notes} waits on the server.", paths: ["big.bin"], actions: [{ kind: "fetch", fileId: "ab".repeat(16) }] });
  c.channel.show({ kind: "question", text: "HOLDING?", key: n.HELD, actions: [{ kind: "delete_everywhere" }, { kind: "restore_here" }] });
  assert.deepEqual(c.toasts.slice(2).map((toast) => [toast.text, toast.ms, toast.hidden]), [
    ["obsync: \"big.bin\" waits on the server.", 8000, false], ["obsync: HOLDING?", 0, false],
  ], "the offer goes by itself, and the held question never takes it away");
  c.channel.close(n.HELD);
  assert.equal(c.toasts[2].hidden, false);
});

test("a toast stays long enough to read it, and one about the vault's safety says so first", () => {
  const c = channel();
  const words = (count) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
  c.channel.show({ kind: "confirm", text: "done." });
  c.channel.show({ kind: "confirm", text: `${words(40)}.` });
  c.channel.show({ kind: "info", text: `${words(200)}.` });
  // Four seconds for the answer to a click, a quarter second a word past that, twenty at most.
  assert.deepEqual(c.toasts.map((toast) => toast.ms), [4000, 1000 + 41 * 250, 20000]);
  assert.equal(n.stays("error", words(300)), 0, "what waits for the person waits");
  c.channel.show({ kind: "security", key: "k", text: "ANOTHER KEY SENTINEL." });
  assert.equal(c.toasts.at(-1).text, "obsync security warning: ANOTHER KEY SENTINEL.");
  assert.equal(c.channel.recent()[0].text, "ANOTHER KEY SENTINEL.");
});

test("a pairing code is on its toast and nowhere else: Recent, the command line and the log read •••", () => {
  const c = channel();
  c.channel.show({ kind: "question", key: "pairing", text: "its prompt shows the code {code}: if it shows another, choose Reject there.", code: "482 913" });
  assert.equal(c.toasts[0].text, "obsync: its prompt shows the code 482 913: if it shows another, choose Reject there.");
  assert.equal(c.channel.recent()[0].text, "its prompt shows the code •••: if it shows another, choose Reject there.");
  assert.ok(!c.logs.join("\n").includes("482"), c.logs.join(" | "));
  assert.ok(!JSON.stringify(c.channel.recent()).includes("482"));
  // Many notes or one, the sentence reads right.
  assert.equal(n.sentence({ kind: "error", text: "paused {notes}: stop rewriting {it}.", paths: ["A.md"] }), 'paused "A": stop rewriting it.');
  assert.equal(n.sentence({ kind: "error", text: "paused {notes}: stop rewriting {it}.", paths: ["A.md", "B.md"] }), 'paused 2 notes ("A" and "B"): stop rewriting them.');
});

test("a click on a toast opens what its notice names, a question's too", () => {
  const c = channel();
  const opened = [];
  c.channel.show({ kind: "info", text: "AN UPDATE SENTINEL.", open: () => opened.push("manager") });
  c.channel.show({ kind: "question", text: "CONFIRM THE WORDS SENTINEL.", open: () => opened.push("settings") });
  for (const toast of c.toasts) toast.open();
  assert.deepEqual(opened, ["manager", "settings"]);
});

test("Recent keeps the newest fifty, newest first, quiet ones included", () => {
  const c = channel({ level: "needs-me", merges: "off" });
  for (let i = 0; i < 60; i++) {
    c.channel.show({ kind: i % 2 === 0 ? "info" : "confirm", text: `ENTRY ${i}.` });
    c.advance(1000);
  }
  const recent = c.channel.recent();
  assert.equal(recent.length, n.RECENT_MAX);
  assert.equal(recent[0].text, "ENTRY 59.");
  assert.equal(recent[1].text, "ENTRY 58.", "a quiet one is there too");
  assert.equal(recent.at(-1).text, "ENTRY 10.");
  assert.ok(recent[0].at > recent[1].at);
});

// --- the plugin: palette, CLI, Recent, Settings ----------------------------

/** The compiled plugin over the sandbox stub, its data file in memory. */
async function plugin(t, { data = null, cli, secrets = memorySecrets() } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  box.require(join(box.home, "build/sync/engine.js")).SyncEngine = class {
    constructor(options) { this.options = options; }
    async start() {}
    stop() {}
    async stopAndWait() {}
    wake() {}
    current() { return { kind: "idle" }; }
  };
  const instance = new Plugin();
  const saves = [], logs = [], files = new Map(), opened = [];
  let stored = data ?? { vrk: KEYS.vrk, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid", edgeHeaders: [] };
  const commands = [];
  instance.loadData = async () => structuredClone(stored);
  instance.saveData = async (value) => { saves.push(structuredClone(value)); stored = structuredClone(value); };
  instance.addCommand = (command) => commands.push(command);
  instance.addSettingTab = instance.registerObsidianProtocolHandler = instance.registerEvent = () => {};
  if (cli !== undefined) instance.registerCliHandler = cli;
  instance.addStatusBarItem = () => statusItem();
  instance.app = { secretStorage: secrets, vault: { adapter: {}, on: () => ({}), getFileByPath: (path) => files.get(path) ?? null },
    workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed(), getActiveViewOfType: () => null,
      getLeaf: (newLeaf) => ({ openFile: async (file) => { opened.push([newLeaf, file.path]); } }) } };
  instance.manifest = { id: "obsync-private-sync", version: "1.1.5" };
  instance.checkForUpdate = async () => {};
  instance.log = (line) => logs.push(line);
  t.after(() => instance.onunload());
  await instance.onload();
  await instance.firstStart;
  const run = (id) => commands.find((command) => command.id === id).callback();
  const cliRun = (command, params = {}) => instance.cli.get(`obsync-private-sync:${command}`).handler(params);
  return { box, obsidian, instance, commands, run, cliRun, saves, logs, files, opened, stored: () => stored, secrets };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };

test("each value is a command a hotkey can take, the palette's answer is said, and the choice is kept", async (t) => {
  const p = await plugin(t);
  const ids = p.commands.map((command) => command.id);
  for (const id of ["notices-everything", "notices-needs-me", "merges-once", "merges-every", "merges-off", "recent"]) assert.ok(ids.includes(id), id);
  assert.equal(p.commands.find((command) => command.id === "notices-needs-me").name, "Notifications: Only what needs me (obsync)");
  assert.equal(p.commands.find((command) => command.id === "merges-off").name, "Combined edits: Recent only (obsync)");
  const from = p.obsidian.notices.length;
  p.run("notices-needs-me");
  await settle();
  p.run("merges-every");
  await settle();
  assert.deepEqual(p.instance.state.data.notices, { level: "needs-me", merges: "every" });
  assert.deepEqual(p.stored().notices, { level: "needs-me", merges: "every" }, "saved to the data file");
  assert.deepEqual(p.obsidian.notices.slice(from), [
    "obsync: notifications: Only what needs me; combined edits: Once per note.",
    "obsync: notifications: Only what needs me; combined edits: Every time.",
  ], "the answer to the person's own command shows even at the quietest level");
  assert.ok(p.logs.some((line) => /^notices decision=changed level=needs-me merges=every source=palette duration_ms=\d+$/.test(line)), p.logs.join(" | "));
  // The next start reads it back.
  const again = await plugin(t, { data: p.stored(), secrets: p.secrets });
  assert.deepEqual(again.instance.state.data.notices, { level: "needs-me", merges: "every" });
});

test("the CLI shows the settings and sets them, in words by default and as a stable object with format=json", async (t) => {
  const p = await plugin(t);
  assert.deepEqual([...p.instance.cli.keys()], ["obsync-private-sync:notices", "obsync-private-sync:recent", "obsync-private-sync:status"]);
  const notices = p.instance.cli.get("obsync-private-sync:notices");
  assert.equal(notices.description, "Show or set obsync notifications");
  assert.deepEqual(Object.entries(notices.flags).map(([name, flag]) => `${name}=${flag.value}`), ["level=everything|needs-me", "merges=once|every|off", "format=text|json"]);
  for (const command of ["recent", "status"]) {
    assert.deepEqual(Object.keys(p.instance.cli.get(`obsync-private-sync:${command}`).flags), ["format"], command);
  }
  assert.equal(await p.cliRun("notices"), "Notifications: Everything useful (level=everything)\nCombined edits: Once per note (merges=once)");
  assert.equal(await p.cliRun("notices", { format: "text" }), "Notifications: Everything useful (level=everything)\nCombined edits: Once per note (merges=once)");
  // THE DOCUMENTED OBJECT (docs/architecture.md 6.4): exactly these keys, these values.
  assert.deepEqual(JSON.parse(await p.cliRun("notices", { format: "json" })), { level: "everything", merges: "once" });
  assert.deepEqual(JSON.parse(await p.cliRun("notices", { level: "needs-me", merges: "off", format: "json" })), { level: "needs-me", merges: "off" });
  assert.deepEqual(p.stored().notices, { level: "needs-me", merges: "off" }, "and it is kept");
  assert.equal(await p.cliRun("notices", { merges: "every" }), "Notifications: Only what needs me (level=needs-me)\nCombined edits: Every time (merges=every)");
  assert.ok(p.logs.some((line) => /^cli decision=answered command=notices format=json duration_ms=\d+$/.test(line)), p.logs.join(" | "));
});

test("the CLI refuses what it does not take: one sentence in words, and a stable code with format=json; nothing changes", async (t) => {
  const p = await plugin(t);
  const saves = p.saves.length;
  const usage = "notices takes level=everything|needs-me, merges=once|every|off, format=text|json.";
  for (const [params, code, message] of [
    [{ level: "loud" }, "unknown_value", "level takes everything or needs-me."],
    [{ merges: "true" }, "unknown_value", "merges takes once, every or off."],
    [{ volume: "11" }, "unknown_flag", `That is not an option here: ${usage}`],
    [{ level: "everything", "--json": "true" }, "unknown_flag", `That is not an option here: ${usage}`],
    [{ format: "yaml" }, "unknown_value", usage],
  ]) {
    await assert.rejects(p.cliRun("notices", params), (error) => error.message === message, JSON.stringify(params));
    assert.deepEqual(JSON.parse(await p.cliRun("notices", { ...params, format: "json" })), code === "unknown_value" && params.format === "yaml"
      ? { level: "everything", merges: "once" } : { error: { code, message } }, JSON.stringify(params));
    assert.ok(p.logs.some((line) => line.startsWith(`cli decision=refused reason=${code} command=notices duration_ms=`)), JSON.stringify(params));
  }
  assert.equal(p.saves.length, saves, "a refused line changes nothing");
  assert.deepEqual(p.instance.state.data.notices, { level: "everything", merges: "once" });
  // A setting the device cannot keep is refused too, never reported as set.
  p.instance.state.save = async () => { throw new Error("SAVE SENTINEL"); };
  assert.deepEqual(JSON.parse(await p.cliRun("notices", { level: "needs-me", format: "json" })),
    { error: { code: "failed", message: "obsync could not do that; its log in Obsidian's developer console says why." } });
  assert.ok(p.logs.some((line) => /^notices decision=failed reason=save source=cli duration_ms=\d+$/.test(line)));
  assert.deepEqual(p.instance.state.data.notices, { level: "everything", merges: "once" }, "not kept is not in effect either");
});

test("the CLI shows Recent newest first and Show sync status, as words or documented objects, and never an id, key or code", async (t) => {
  const p = await plugin(t);
  assert.equal(await p.cliRun("recent"), "Nothing since obsync started.");
  assert.deepEqual(JSON.parse(await p.cliRun("recent", { format: "json" })), [], "an empty list, not an error");
  // An id that reached a notice's words by mistake is still never printed.
  p.instance.host.notify({ kind: "info", text: `ID SENTINEL ${"ab".repeat(16)}.` });
  p.instance.host.notify(combine("Notes/Both.md"));
  const lines = (await p.cliRun("recent")).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}combined your edits to "Both" with MacBook's\.$/);
  assert.match(lines[1], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}ID SENTINEL …\.$/);
  const recent = JSON.parse(await p.cliRun("recent", { format: "json" }));
  assert.deepEqual(recent.map((entry) => Object.keys(entry)), [["time", "kind", "note_title", "device", "text"], ["time", "kind", "note_title", "device", "text"]]);
  assert.deepEqual(recent.map(({ time, ...entry }) => entry), [
    { kind: "combined", note_title: "Both", device: "MacBook", text: "combined your edits to \"Both\" with MacBook's." },
    { kind: "info", note_title: null, device: null, text: "ID SENTINEL …." },
  ]);
  for (const { time } of recent) assert.match(time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "UTC RFC 3339");

  const status = await p.cliRun("status");
  assert.match(status, /^State: .+\nServer: https:\/\/sync\.example\.invalid\nThis device: .+\nVault key: present\nFiles tracked: 0\nRemote only: 0\nWaiting to be written: 0\nPaused: 0$/);
  const object = JSON.parse(await p.cliRun("status", { format: "json" }));
  assert.deepEqual(Object.keys(object), ["state", "text", "server", "device", "has_vault_key", "files_tracked", "remote_only", "waiting_to_be_written", "paused"]);
  assert.deepEqual({ ...object, device: typeof object.device }, { state: "idle", text: "idle", server: "https://sync.example.invalid", device: "string",
    has_vault_key: true, files_tracked: 0, remote_only: 0, waiting_to_be_written: 0, paused: 0 });
  const printed = [status, lines.join("\n"), JSON.stringify(recent), JSON.stringify(object)].join("\n");
  for (const secret of [KEYS.deviceId, KEYS.vrk, KEYS.deviceSecret]) assert.ok(!printed.includes(secret), "a secret or an id in CLI output");
  assert.doesNotMatch(printed, /[0-9a-f]{16}/);
});

test("a host without a command line still loads, and says so in its log", async (t) => {
  const p = await plugin(t, { cli: () => { throw new TypeError("no command line here"); } });
  assert.ok(p.commands.some((command) => command.id === "recent"), "the plugin loaded on");
  for (const command of ["notices", "recent", "status"]) assert.ok(p.logs.includes(`cli decision=refused reason=TypeError command=${command}`), command);
});

test("Recent opens the note it names, and says so when that note is no longer there", async (t) => {
  const p = await plugin(t);
  p.files.set("Notes/Both.md", { path: "Notes/Both.md" });
  p.instance.openNote("Notes/Both.md");
  assert.deepEqual(p.opened, [[false, "Notes/Both.md"]]);
  const from = p.obsidian.notices.length;
  p.instance.openNote("Notes/Gone.md");
  assert.deepEqual(p.obsidian.notices.slice(from), ["obsync: \"Gone\" is no longer at that name: it was renamed, moved or deleted since."]);
  assert.ok(p.logs.includes("recent decision=refused reason=not_at_that_name"));
});

// --- Show sync status and Settings -----------------------------------------

class Widget {
  setButtonText(value) { this.text = value; return this; }
  setCta() { return this; }
  onClick(handler) { this.click = handler; return this; }
}

function statusDialog(t, entries) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const rows = [], buttons = [], calls = [], titles = [];
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { rows.push(["name", value]); return this; },
    setDesc(value) { rows.push(["desc", value]); return this; },
    addButton(make) { const button = new Widget(); buttons.push(button); make(button); return this; },
  });
  const { StatusModal, RecentModal } = box.require(join(box.home, "build/ui/modals.js"));
  const plugin = {
    state: { data: { serverUrl: "", deviceId: null, vrk: null, recoveryPhrase: "confirmed", parked: {}, paused: {}, files: {}, remoteOnly: {}, lastSeq: 0,
      policy: { perFileMaxBytes: 0, totalBudgetBytes: 0 } }, localBytes: () => 0 },
    statusText: () => "idle", currentStatus: () => ({ kind: "idle" }), nextRetryAt: () => null, onStatusChange: () => () => undefined,
    notices: { recent: () => entries }, openNote: (path) => calls.push(`open:${path}`), showRecent: () => calls.push("recent"),
  };
  const element = () => ({ createEl: (tag, attributes = {}) => { rows.push([tag, attributes.text]); return element(); }, empty: () => { rows.length = 0; buttons.length = 0; } });
  const open = (Modal) => {
    const modal = new Modal({}, plugin);
    modal.contentEl = element();
    modal.setTitle = (title) => titles.push(title);
    modal.close = () => calls.push("close");
    modal.onOpen();
    return modal;
  };
  return { rows, buttons, calls, titles, open, StatusModal, RecentModal };
}

const entry = (i, paths = []) => ({ at: new Date(2026, 8, 29, 14, 5, i).getTime(), kind: "combined", text: `ENTRY ${i}`, paths });

test("Show sync status lists Recent newest first, each note a button that opens it, and Show all past ten", (t) => {
  const d = statusDialog(t, [entry(3, ["Notes/Both.md"]), entry(2), entry(1, ["Work/Plan.md", "Home/Plan.md"])]);
  d.open(d.StatusModal);
  const at = d.rows.findIndex(([tag, text]) => tag === "h3" && text === "Recent");
  assert.ok(at > 0, JSON.stringify(d.rows));
  assert.deepEqual(d.rows.slice(at + 1).filter(([kind]) => kind === "name").map(([, text]) => text), ["ENTRY 3", "ENTRY 2", "ENTRY 1"]);
  assert.ok(d.rows.slice(at + 1).some(([kind, text]) => kind === "desc" && text === "14:05"), "with the time each came");
  assert.deepEqual(d.buttons.map((button) => button.text), ["Open", "Open Work/Plan", "Open Home/Plan"]);
  d.buttons[0].click();
  assert.deepEqual(d.calls, ["close", "open:Notes/Both.md"]);
  assert.ok(!d.buttons.some((button) => button.text === "Show all"));

  const full = statusDialog(t, Array.from({ length: 12 }, (_, i) => entry(12 - i)));
  full.open(full.StatusModal);
  assert.equal(full.rows.filter(([kind, text]) => kind === "name" && text.startsWith("ENTRY")).length, 10);
  const all = full.buttons.find((button) => button.text === "Show all");
  all.click();
  assert.deepEqual(full.calls, ["close", "recent"]);
  full.rows.length = 0;
  full.open(full.RecentModal);
  assert.equal(full.titles.at(-1), "Recent sync activity");
  assert.equal(full.rows.filter(([kind, text]) => kind === "name" && text.startsWith("ENTRY")).length, 12);

  const empty = statusDialog(t, []);
  empty.open(empty.StatusModal);
  assert.ok(empty.rows.some(([kind, text]) => kind === "desc" && text === "Nothing since obsync started."));
});
