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
 * poll in turn, and every request is recorded.
 */
async function prompt(t, { statuses = [], approve = () => ({ outcome: "ok", value: undefined }), notes = 7 } = {}) {
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
  const plugin = {
    state: { data: { vrk: VRK } },
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
    },
  };
  const modal = new PairCreateModal({}, plugin);
  let closed = 0;
  modal.contentEl = { empty() {} };
  modal.close = () => { closed++; modal.onClose(); };
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (resolve) => resolve() };
  t.after(() => { globalThis.window = previousWindow; });
  const secret = pairing.newPairingSecret(), id = "ab".repeat(16), device = "cd".repeat(16);
  const claimant = { device_id: device, name: "iPhone 7KQ4", platform: "ios", app_version: "1.1.4",
    vault: await pairing.sealPairingVault(secret, id, { name: "Plans <2026>", notes }) };
  return {
    modal, secret, id, device, claimant, buttons, messages, calls, logs, notices, pairing, ApiError, closed: () => closed,
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
  await until(() => r.closed() === 1, "the dialog closed on collection");
  const approvals = r.calls.filter((call) => call.approve);
  assert.equal(approvals.length, 1, "the envelope is posted exactly once");
  assert.deepEqual(r.calls.filter((call) => !call.approve), ["status", "status", "status", "names"]);
  assert.ok(r.messages.includes("Approved. Waiting for the new device to collect the vault key…"));
  const paired = r.notices.filter((notice) => notice.includes("is paired"));
  assert.deepEqual(paired, ['The new device, "iPhone 7KQ4", is paired: it holds the vault key now.']);
  assert.equal(r.buttons.length, 0, "no answer is offered twice");
  assert.equal(r.closed(), 1);
  assert.ok(r.logs.includes("pairing role=creator decision=paired"));
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
    await until(() => r.messages.at(-1).includes(words), words);
    assert.ok(!r.notices.some((notice) => notice.includes("is paired")), r.notices.join(" | "));
    assert.ok(r.messages.at(-1).includes(words), r.messages.at(-1));
    assert.ok(!RAW.test(r.messages.at(-1)));
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
  assert.ok(r.notices.some((notice) => notice.includes("Rejected: that device was refused")));
  assert.equal(r.closed(), 1);
});

test("closing with a claim on screen refuses it; closing after approval says it finishes by itself (#153)", async t => {
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
