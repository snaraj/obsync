/** The creator's side of pairing: what it asks, what it refuses, and when it says "paired". */
import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

const RAW = /\b(401|403|404|409|410)\b|unknown_pairing|pairing_expired|already_approved|OperationError|decrypt|AES|GCM|byte/;
const VRK = "00".repeat(32);

/**
 * A creator dialog over a scripted server: `statuses` answers each pairing
 * poll in turn, `rows(poll, row)` each device-list read after collection
 * (default: the new device kept the key), `server` the version the server
 * reports; every request is recorded.
 */
async function prompt(t, { statuses = [], approve = () => ({ outcome: "ok", value: undefined }), notes = 7, rows = (poll, row) => [row()], server = "1.1.5" } = {}) {
  const box = sandbox(); t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian"), buttons = [], messages = [], calls = [], logs = [];
  obsidian.Setting.prototype.addButton = function (build) {
    const button = { setButtonText(text) { this.text = text; return this; }, setCta() { return this; }, onClick(fn) { this.click = fn; return this; } };
    build(button); buttons.push(button); return this;
  };
  obsidian.Setting.prototype.settingEl = { remove() { buttons.length = 0; } };
  const { PairCreateModal } = box.require(join(box.home, "build/ui/modals.js"));
  const { ApiError } = box.require(join(box.home, "build/transport.js"));
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const notices = obsidian.notices;
  const secret = pairing.newPairingSecret(), id = "ab".repeat(16), device = "cd".repeat(16);
  // The new device's row: signed in at 1000 by its survey, seen at 2000 by
  // the heartbeat of the sync a kept key starts.
  const row = (fields = {}) => ({ device_id: device, name: "iPhone 7KQ4", platform: "ios", app_version: "1.1.5",
    state: "active", revoked: false, last_sign_in: 1000, last_seen: 2000, ...fields });
  let reads = 0;
  const plugin = {
    // The quietest notices a person can choose: every word of pairing is still said.
    state: { data: { vrk: VRK, notices: { level: "needs-me", merges: "off" } } },
    log: (line) => logs.push(line),
    refreshDeviceNames: async () => { calls.push("names"); },
    transport: {
      pairingApprove: async (id, envelope, nonce) => { calls.push({ approve: { envelope, nonce } }); return approve(); },
      pairingReject: async () => { calls.push("reject"); return { outcome: "ok", value: undefined }; },
      pairingStatus: async () => {
        calls.push("status");
        const next = statuses.shift();
        if (next === undefined) return { state: "approved", claimant: null };
        if (next instanceof Error) throw next;
        return { state: next, claimant: null };
      },
      devices: async () => {
        calls.push("devices");
        const answer = rows(++reads, row);
        if (answer instanceof Error) throw answer;
        return { devices: answer };
      },
      pluginManifest: async () => {
        calls.push("manifest");
        if (server instanceof Error) throw server;
        return { version: server };
      },
    },
  };
  // Every answer goes through the real notice channel onto the stub's toasts (`notices.ts`).
  plugin.notices = box.require(join(box.home, "build/main.js")).noticeChannel({ ...plugin, log: () => undefined });
  const modal = new PairCreateModal({}, plugin);
  let closed = 0;
  modal.contentEl = { empty() {} };
  modal.close = () => { closed++; modal.onClose(); };
  const previousWindow = globalThis.window;
  // Each two-second wait a turn of the event loop: a wait that never ended
  // would otherwise starve every timer, the test runner's own included.
  globalThis.window = { setTimeout: (resolve) => setImmediate(resolve) };
  // The watch behind a closed dialog ends with its test, whatever happened in it.
  t.after(() => { modal.collecting = false; });
  t.after(() => { globalThis.window = previousWindow; });
  const claimant = { device_id: device, name: "iPhone 7KQ4", platform: "ios", app_version: "1.1.4",
    vault: await pairing.sealPairingVault(secret, id, { name: "Plans <2026>", notes }) };
  return {
    modal, secret, id, device, claimant, buttons, messages, calls, logs, notices, obsidian, pairing, ApiError, row, closed: () => closed,
    status: { setText: (text) => messages.push(text) },
    press: async (label) => { await buttons.find((button) => button.text === label).click(); },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
/** A button's handler runs detached, as Obsidian runs it: wait for what it does. */
async function until(done, what) {
  for (let turn = 0; turn < 2000 && !done(); turn++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(done(), `never happened: ${what}`);
}

test("approval names the decrypted vault and note count before showing its controls (#141)", async t => {
  const r = await prompt(t);
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  assert.match(r.messages[0], /Plans <2026>.*7 notes/);
  assert.deepEqual(r.buttons.map(b => b.text), ["Approve", "Reject"]);
});

test("the prompt counts the vault's notes in words: 1 note, 7 notes (iPhone pass, 2026-09-26)", async t => {
  for (const [notes, said] of [[1, '(1 note)'], [7, '(7 notes)'], [0, '(0 notes)']]) {
    const r = await prompt(t, { notes });
    await r.modal.approve(r.id, r.secret, r.claimant, r.status);
    assert.ok(r.messages[0].endsWith(` It will sync vault "Plans <2026>" ${said} with this server's vault.`), r.messages[0]);
  }
});

test("the prompt shows the claimant's name, what it is, when it asked and the match code it shows (#152)", async t => {
  const r = await prompt(t);
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  const code = await r.pairing.matchCode(r.secret, r.id, r.device);
  const [line] = r.messages;
  assert.ok(line.startsWith('Approve "iPhone 7KQ4" (iPhone, obsync 1.1.4), asking since '), line);
  assert.match(line, /asking since \d{2}:\d{2}\?/);
  assert.ok(line.includes(`Approve only if the new device shows the code ${code}.`), line);
  // Another device racing the same code is another claim, and another code.
  const racer = await prompt(t);
  await racer.modal.approve(r.id, r.secret, { ...r.claimant, device_id: "ef".repeat(16) }, racer.status);
  assert.ok(!racer.messages[0].includes(code), "a racing claim cannot show the first claim's code");
});

test("a hostile platform word is shown as a device, never as a prototype member (#152)", async t => {
  for (const platform of ["__proto__", "constructor", "toString", "plan9"]) {
    const r = await prompt(t);
    await r.modal.approve(r.id, r.secret, { ...r.claimant, platform }, r.status);
    assert.ok(r.messages[0].includes("(device, obsync"), r.messages[0]);
  }
});

test("an old server's absent vault details keep the approval prompt, with its code (#141, #152)", async t => {
  const r = await prompt(t); delete r.claimant.vault;
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  assert.match(r.messages[0], /iPhone 7KQ4.*iPhone/);
  assert.match(r.messages[0], /the code \d{3} \d{3}\./);
  assert.ok(!r.messages[0].includes("vault"));
  assert.equal(r.buttons.length, 2);
});

test("a claimant holding another code's secret is refused before anyone is asked, in words (#153)", async t => {
  const r = await prompt(t); r.secret[0] ^= 1;
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  assert.equal(r.buttons.length, 0, "no approval is ever offered");
  assert.deepEqual(r.calls, ["reject"], "its pending device is destroyed at once");
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0], /does not match this one/);
  assert.ok(!RAW.test(r.messages[0]), r.messages[0]);
  assert.ok(r.logs.includes("pairing role=creator decision=refused reason=code_mismatch"));
});

test("closing while vault details decrypt cannot recreate approval controls, and refuses the claim (#141, #153)", async t => {
  const r = await prompt(t);
  const work = r.modal.approve(r.id, r.secret, r.claimant, r.status);
  r.modal.onClose(); await work; await settle();
  assert.equal(r.buttons.length, 0); assert.equal(r.messages.length, 0);
  assert.deepEqual(r.calls, ["reject"], "PS closed with the dialog, so nobody could ever approve it");
  assert.ok(r.notices.some((notice) => notice.includes("closing that dialog refused the device")));
});

test("the creator says paired only once the server reports the key collected (#153)", async t => {
  const r = await prompt(t, { statuses: ["approved", "approved", "consumed"] });
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  await r.press("Approve");
  await until(() => r.notices.some((notice) => notice.includes("is paired")), "the new device was said paired once it kept the key");
  const approvals = r.calls.filter((call) => call.approve);
  assert.equal(approvals.length, 1, "the envelope is posted exactly once");
  assert.deepEqual(r.calls.filter((call) => !call.approve), ["status", "status", "status", "devices", "names"]);
  // DONE ONCE THE APPROVAL LANDS (1.1.5): the dialog closed with the
  // approval, said so, and the rest was said in a notice behind it.
  assert.equal(r.notices[0], 'obsync: approved "iPhone 7KQ4": it finishes pairing by itself, and obsync tells you here when it has.');
  const paired = r.notices.filter((notice) => notice.includes("is paired"));
  assert.deepEqual(paired, ['obsync: "iPhone 7KQ4" is paired: it holds the vault key now.']);
  assert.equal(r.buttons.length, 0, "no answer is offered twice");
  assert.equal(r.closed(), 1);
  assert.ok(r.logs.includes("pairing role=creator decision=paired polls=1"));
  // The envelope opens under the code's secret, and carries the vault key only.
  const { envelope, nonce } = approvals[0].approve;
  assert.deepEqual(await r.pairing.openEnvelope(r.secret, r.id, envelope, nonce), { vrk: VRK });
});

test("a claim that is never collected is never announced as paired (#153)", async t => {
  for (const [ending, words] of [["expired", "did not collect the vault key"], [null, "ended before this device saw"]]) {
    const r = await prompt(t, { statuses: ["approved"] });
    r.modal.plugin.transport.pairingStatus = async () => {
      r.calls.push("status");
      if (r.calls.filter((call) => call === "status").length === 1) return { state: "approved", claimant: null };
      if (ending === null) throw new r.ApiError(404, "unknown_pairing", "no such pairing");
      return { state: ending, claimant: null };
    };
    await r.modal.approve(r.id, r.secret, r.claimant, r.status);
    await r.press("Approve");
    await until(() => r.notices.at(-1)?.includes(words), words);
    assert.ok(!r.notices.some((notice) => notice.includes("is paired")), r.notices.join(" | "));
    assert.equal(r.closed(), 1, "the dialog closed with the approval; the outcome is a notice");
    assert.ok(!RAW.test(r.notices.at(-1)));
  }
});

test("a server that reports the key collected before any approval is not believed (#153)", async t => {
  const r = await prompt(t);
  let polls = 0;
  r.modal.plugin.transport.pairingCreate = async () => ({ outcome: "ok", value: { pairing_id: r.id, enroll_token: "34".repeat(32), expires: 0 } });
  r.modal.plugin.transport.pairingStatus = async () => {
    polls++;
    if (polls === 1) return { state: "consumed", claimant: null };
    if (polls === 2) return { state: "approved", claimant: null };
    return { state: "expired", claimant: null };
  };
  r.modal.contentEl = { empty() {}, createEl: () => ({ remove() {}, setText: (text) => r.messages.push(text) }) };
  await r.modal.run();
  assert.equal(polls, 3);
  assert.ok(!r.notices.some((notice) => notice.includes("paired")), r.notices.join(" | "));
  assert.ok(!r.calls.some((call) => call.approve), "nothing was ever sealed");
  assert.match(r.messages.at(-1), /expired before a device used it/);
});

test("Reject refuses the claim, says so, and closes (#153)", async t => {
  const r = await prompt(t);
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  await r.press("Reject"); await settle();
  assert.deepEqual(r.calls, ["reject"], "refused once: closing afterwards refuses nothing more");
  assert.ok(r.notices.some((notice) => notice.includes("rejected: that device was refused")));
  assert.equal(r.closed(), 1);
});

test("closing with a claim on screen refuses it; an approval closes the dialog and says it finishes by itself (#153)", async t => {
  const asked = await prompt(t);
  await asked.modal.approve(asked.id, asked.secret, asked.claimant, asked.status);
  asked.modal.onClose(); await settle();
  assert.deepEqual(asked.calls, ["reject"]);
  assert.ok(asked.logs.includes("pairing role=creator decision=refused reason=closed"));

  const approved = await prompt(t);
  approved.modal.plugin.transport.pairingStatus = async () => {
    approved.modal.onClose();
    return { state: "approved", claimant: null };
  };
  await approved.modal.approve(approved.id, approved.secret, approved.claimant, approved.status);
  await approved.press("Approve");
  await until(() => approved.notices.some((notice) => notice.includes("finishes pairing by itself")), "the close was told");
  assert.ok(!approved.calls.includes("reject"), "an approved claim is never refused by a close");
  assert.ok(approved.notices.some((notice) => notice.includes("finishes pairing by itself")));
  assert.ok(!approved.notices.some((notice) => notice.includes("is paired")));
});

test("behind the closed dialog the wait ends by itself: with the code's ten minutes, or when the plugin unloads (1.1.5)", async t => {
  // A server that never settles the pairing: three hundred reads, two seconds
  // apart, are the code's ten minutes, and then one notice says so.
  const never = await prompt(t, { statuses: Array(400).fill("approved") });
  await never.modal.approve(never.id, never.secret, never.claimant, never.status);
  await never.press("Approve");
  await until(() => never.logs.includes("pairing role=creator decision=failed reason=not_collected"), "the wait ended");
  assert.equal(never.calls.filter((call) => call === "status").length, 300);
  assert.match(never.notices.at(-1), /^obsync: "iPhone 7KQ4" did not collect the vault key before the code expired/);
  // A plugin that unloads ends it at once, and says nothing more.
  const unloads = [];
  const gone = await prompt(t, { statuses: Array(400).fill("approved") });
  gone.modal.plugin.register = (callback) => { unloads.push(callback); };
  gone.modal.plugin.transport.pairingStatus = async () => {
    gone.calls.push("status");
    if (gone.calls.filter((call) => call === "status").length === 2) for (const unload of unloads) unload();
    return { state: "approved", claimant: null };
  };
  await gone.modal.approve(gone.id, gone.secret, gone.claimant, gone.status);
  await gone.press("Approve");
  await until(() => gone.calls.filter((call) => call === "status").length === 2, "the wait began");
  for (let turn = 0; turn < 20; turn++) await settle();
  assert.equal(unloads.length, 1, "the wait registered its end with the plugin");
  assert.equal(gone.calls.filter((call) => call === "status").length, 2);
  assert.ok(!gone.logs.some((line) => line.includes("reason=not_collected")), gone.logs.join(" | "));
  assert.ok(!gone.notices.some((notice) => notice.includes("did not collect")), gone.notices.join(" | "));
});

test("a refused approval is told in words, never as a server code (#154)", async t => {
  const r = await prompt(t);
  r.modal.plugin.transport.pairingApprove = async () => { throw new r.ApiError(410, "pairing_expired", "the pairing has expired"); };
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  await r.press("Approve");
  await until(() => r.logs.includes("pairing role=creator decision=failed reason=pairing_expired"), "the refusal was logged");
  assert.ok(r.notices.some((notice) => notice.includes("That code has expired")), r.notices.join(" | "));
  assert.ok(r.notices.every((notice) => !RAW.test(notice)), r.notices.join(" | "));
  assert.ok(r.logs.includes("pairing role=creator decision=failed reason=pairing_expired"));
});

// --- Owner ruling, 2026-09-29: "paired" only once the new device kept the key,
// and a server older than 1.1.5 refused before any code is made (lab leg B3).

/** The creator's last word on a kept key: its log line (the dialog closed with the approval). */
const paired = (r) => r.logs.some((line) => line.includes("decision=paired"));

/** Approve a claim that the server then reports collected, and wait for the creator's last word. */
async function collected(t, rows, done) {
  const r = await prompt(t, { statuses: ["consumed"], rows });
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  await r.press("Approve");
  await until(() => done(r), "the creator settled");
  return r;
}

test("collection is not pairing: paired waits for the new device's first sync, not its sign-in", async t => {
  const r = await collected(t, (poll, row) => [poll === 1 ? row({ last_seen: 1000 }) : row({ last_seen: 1500 })], paired);
  assert.equal(r.calls.filter((call) => call === "devices").length, 2, "signed in but not yet synced is still open");
  assert.deepEqual(r.notices.filter((notice) => notice.includes("is paired")), ['obsync: "iPhone 7KQ4" is paired: it holds the vault key now.']);
  assert.ok(r.logs.includes("pairing role=creator decision=paired polls=2"), r.logs.join(" | "));
});

test("a new device that did not keep the key is never announced as paired, and the outcome is said plainly", async t => {
  for (const [what, answer] of [
    ["revoked", (poll, row) => [row({ state: "revoked", revoked: true })]],
    ["state revoked", (poll, row) => [row({ state: "revoked" })]],
    ["gone", () => []],
  ]) {
    const r = await collected(t, answer, (r) => r.logs.some((line) => line.includes("reason=key_not_kept")));
    assert.ok(!r.notices.some((notice) => notice.includes("is paired")), `${what}: ${r.notices.join(" | ")}`);
    assert.match(r.notices.at(-1), /^obsync: "iPhone 7KQ4" did not keep the vault key and removed itself from the server/, what);
    assert.ok(!RAW.test(r.notices.at(-1)), what);
    assert.equal(r.obsidian.raised.at(-1).duration, 0, `${what}: the outcome stays on screen until dismissed`);
    assert.ok(r.logs.includes("pairing role=creator decision=failed reason=key_not_kept polls=1"), what);
  }
});

test("a new device that never confirms within ten minutes is told so, not called paired", async t => {
  const r = await collected(t, (poll, row) => [row({ last_seen: 1000 })], (r) => r.logs.some((line) => line.includes("reason=key_unconfirmed")));
  assert.equal(r.calls.filter((call) => call === "devices").length, 300);
  assert.ok(!r.notices.some((notice) => notice.includes("is paired")), r.notices.join(" | "));
  assert.match(r.notices.at(-1), /^obsync: "iPhone 7KQ4" collected the vault key but has not started syncing within ten minutes/);
  assert.ok(r.logs.includes("pairing role=creator decision=failed reason=key_unconfirmed polls=300"));
});

test("a new device whose sync starts in the second of its sign-in is paired, not left unconfirmed (#290)", async t => {
  // Seen live: the heartbeat shared the sign-in's second, `last_seen` never
  // passed `last_sign_in`, and a device syncing 7,700 notes read "not confirmed".
  const r = await collected(t, (poll, row) => [poll === 1 ? row({ last_seen: 1000, last_heartbeat: null }) : row({ last_seen: 1000, last_heartbeat: 1000 })], paired);
  assert.equal(r.calls.filter((call) => call === "devices").length, 2, "signed in, no heartbeat yet, is still open");
  assert.deepEqual(r.notices.filter((notice) => notice.includes("is paired")), ['obsync: "iPhone 7KQ4" is paired: it holds the vault key now.']);
  assert.ok(r.logs.includes("pairing role=creator decision=paired polls=2"), r.logs.join(" | "));
  assert.ok(!r.logs.some((line) => line.includes("key_unconfirmed")), r.logs.join(" | "));
});

test("a failed device-list read decides nothing: it is logged once and the wait goes on", async t => {
  const r = await collected(t, (poll, row) => (poll < 3 ? new Error("offline") : [row()]), paired);
  assert.equal(r.logs.filter((line) => line.includes("reason=devices_unread")).length, 1, r.logs.join(" | "));
  assert.ok(r.logs.includes("pairing role=creator decision=paired polls=3"));
});

/**
 * Open the creator's run() over a scripted server; returns what it wrote and
 * whether a pairing was made. A function `server` is a refusal, built from
 * this sandbox's own ApiError.
 */
async function opened(t, server, statuses = ["expired"]) {
  const r = await prompt(t, { server: typeof server === "function" ? null : server });
  if (typeof server === "function") r.modal.plugin.transport.pluginManifest = async () => { throw server(r.ApiError); };
  let created = 0;
  r.modal.plugin.transport.pairingCreate = async () => { created++; return { outcome: "ok", value: { pairing_id: r.id, enroll_token: "34".repeat(32), expires: 0 } }; };
  r.modal.plugin.transport.pairingStatus = async () => ({ state: statuses.shift() ?? "expired", claimant: null });
  const texts = [];
  r.modal.contentEl = { empty() {}, createEl: (tag, options) => { if (options?.text) texts.push(options.text); return { remove() {}, setText: (text) => texts.push(text) }; } };
  await r.modal.run();
  return { ...r, texts, created: () => created };
}

test("a server older than 1.1.5, or one that reports no version, is refused before any code is made", async t => {
  const unavailable = (ApiError) => new ApiError(404, "plugin_unavailable", "this server ships no plugin bundle");
  for (const server of ["1.1.4", "1.0.99", "0.9.9", "", "abc", "1.1", "1.1.5x", "v1.1.5", 5, null, unavailable]) {
    const o = await opened(t, server);
    assert.equal(o.created(), 0, `${String(server)}: no pairing was created`);
    assert.match(o.texts.at(-1), /^Your obsync server runs a version older than 1\.1\.5, or does not say which, so no code was made\. Update your obsync server to 1\.1\.5 or later, then pair again/, String(server));
    assert.ok(o.logs.some((line) => line.startsWith("pairing role=creator decision=refused reason=server_too_old server=")), String(server));
    assert.ok(!o.texts.some((text) => text.includes("TYPE this code")), `${String(server)}: no code is offered`);
  }
});

test("a 1.1.5 or later server gets a code", async t => {
  for (const server of ["1.1.5", "1.1.5-beta.1", "1.1.10", "1.2.0", "2.0.0"]) {
    const o = await opened(t, server);
    assert.equal(o.created(), 1, server);
    assert.ok(o.texts.some((text) => text.includes("TYPE this code")), server);
    assert.ok(!o.logs.some((line) => line.includes("server_too_old")), server);
  }
});

test("an unreachable server is told as unreachable, never as too old", async t => {
  const o = await opened(t, (ApiError) => new ApiError(0, "unreachable", "no answer within 15 s"));
  assert.equal(o.created(), 0);
  assert.ok(!o.texts.some((text) => text.includes("older than 1.1.5")), o.texts.join(" | "));
  assert.ok(o.logs.includes("pairing role=creator decision=failed reason=unreachable"), o.logs.join(" | "));
  assert.equal(o.notices.length, 1, "one refusal, in words");
});
