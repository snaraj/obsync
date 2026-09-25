/** Exercise the actual claimant dialog method with a non-rendering Obsidian stub. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { KEYS, sandbox } from "./fake.mjs";

/** A recording `Setting` button: what it says, how it is styled, whether it holds the focus. */
class Button {
  constructor() { this.buttonEl = { focus: () => { this.focused = true; } }; }
  setButtonText(value) { this.text = value; return this; }
  setCta() { this.cta = true; return this; }
  setDestructive() { this.destructive = true; return this; }
  onClick(handler) { this.click = handler; return this; }
}

async function claimant(t, response, onWait = () => {}, beforeKeySave = async () => {}, beforeClaim = async () => {},
  { unknown = 0, answer = null, data = {}, root = null } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  // Every question the claimant asks is a real `ConfirmModal`, drawn into a
  // recording element and answered by pressing the button a test names. A
  // test that names none expects no question at all.
  const obsidian = box.require("obsidian");
  const asked = [];
  obsidian.Setting.prototype.addButton = function (build) {
    const button = new Button();
    (this.el.buttons ??= []).push(button);
    build(button);
    return this;
  };
  obsidian.Modal.prototype.open = function () {
    const drawn = [];
    this.contentEl = { createEl: (tag, { text = "" } = {}) => { drawn.push(text); return {}; }, empty: () => {} };
    this.setTitle = (title) => { this.title = title; };
    this.close = () => this.onClose();
    this.onOpen();
    // What Obsidian does once `onOpen` returns: the focus goes to the first button.
    this.contentEl.buttons[0].buttonEl.focus();
    asked.push({ title: this.title, text: drawn.join("\n"), buttons: this.contentEl.buttons });
    if (answer === null) assert.fail(`no question was expected, and "${this.title}" was asked`);
    this.contentEl.buttons.find((button) => button.text === answer).click();
  };
  const { PairClaimModal } = box.require(join(box.home, "build/ui/modals.js"));
  const { ApiError } = box.require(join(box.home, "build/transport.js"));
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const notices = box.require("obsidian").notices;
  const id = "12".repeat(16), token = "34".repeat(32), secret = new Uint8Array(16).fill(56);
  const sealed = await pairing.sealEnvelope(secret, id, { vrk: KEYS.vrk });
  const calls = [], saves = [], logs = [];
  let restarted = 0, waits = 0;
  const state = { data: { vrk: null, deviceId: null, deviceSecret: null, serverUrl: "https://sync.example.invalid", ...data },
    // `State.paired`, over the same three fields.
    get paired() { return this.data.vrk !== null && this.data.deviceId !== null && this.data.deviceSecret !== null; },
    assertAvailable() {}, save: async () => {
      const snapshot = { ...state.data };
      if (snapshot.vrk !== null) await beforeKeySave({ saves, plugin, restartCalls: () => restarted });
      saves.push(snapshot);
    } };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const plugin = Object.assign(new Plugin(), {
    state,
    manifest: { version: "0.1.15" }, deviceName: () => "Tablet", platformName: () => "ios",
    log: (line) => logs.push(line),
    notesUnknownTo: async (vrk) => {
      assert.equal(vrk, KEYS.vrk, "the survey reads the vault with the key the envelope carried");
      calls.push("survey");
      return unknown;
    },
    leaveServer: async (choice) => {
      calls.push("leave");
      assert.deepEqual(choice, { discardUnpushed: true, localOnly: false });
      return { decision: "left", revoked: true };
    },
    restartEngine: async () => {
      restarted++;
      assert.equal(saves.at(-1)?.vrk, KEYS.vrk, "the approved key must already be persisted");
    },
    transport: {
      pairingClaim: async (pairingId, enrollToken, info) => {
        assert.deepEqual(await pairing.openPairingVault(secret, id, info.vault), { name: "Pairing test vault", notes: 2 });
        assert.ok(!JSON.stringify(info).includes("Pairing test vault"), "the server receives ciphertext only");
        assert.equal(pairingId, id); assert.equal(enrollToken, token);
        calls.push("claim");
        await beforeClaim(plugin);
        return { outcome: "ok", value: { device_id: KEYS.deviceId, device_secret: KEYS.deviceSecret } };
      },
      pairingStatus: async () => { calls.push("creator-status"); throw new Error("creator-only route"); },
      pairingEnvelope: async (pairingId) => {
        assert.equal(pairingId, id); calls.push("envelope");
        return response({ ApiError, sealed, plugin, modal, attempt: calls.filter((call) => call === "envelope").length });
      },
    },
  });
  // The real host: over no filesystem unless a test names the vault root on disk.
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  plugin.host = new ObsidianHost(plugin, root === null ? null : { fs: { promises: fsPromises }, path: nodePath, base: root });
  const modal = new PairClaimModal({ vault: { getName: () => "Pairing test vault", getMarkdownFiles: () => [1, 2] } }, plugin, pairing.encodePairingCode(id, token, secret));
  modal.contentEl = { createEl: () => ({}), empty: () => {} };
  modal.close = () => modal.onClose();
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (resolve, delay) => {
    assert.equal(delay, 2000);
    assert.ok(++waits <= 3, "terminal outcomes must not poll indefinitely");
    onWait(modal, waits, plugin); resolve();
  } };
  t.after(() => { globalThis.window = previousWindow; });
  await modal.claim();
  return { calls, saves, logs, notices, restarted, asked, state: state.data, current: plugin.state.data };
}

test("a vault inside a vault that syncs with obsync refuses to pair before any request (#180)", async (t) => {
  // S96: the folder `Sub` of a synced vault, opened as a vault of its own and
  // paired with the same server, filled every device with `Sub/Sub/Sub/…`.
  const outer = mkdtempSync(join(tmpdir(), "obsync-outer-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  mkdirSync(join(outer, ".obsidian", "plugins", "obsync-private-sync"), { recursive: true });
  const root = join(outer, "Sub");
  mkdirSync(join(root, ".obsidian", "plugins", "obsync-private-sync"), { recursive: true });
  const result = await claimant(t, () => assert.fail("an envelope was asked for"), undefined, undefined, undefined, { root });
  assert.deepEqual(result.calls, [], "nothing reached the server: no claim, no envelope, no survey");
  assert.deepEqual(result.saves, [], "no credential was kept");
  assert.equal(result.restarted, 0);
  assert.deepEqual(result.notices, [
    `This folder is inside the synced vault "${nodePath.basename(outer)}". Syncing it too would copy that vault into ` +
      "itself. Open the outer vault instead, or use Selected folders there.",
  ]);
  assert.ok(result.logs.some((line) => /^pairing role=claimant decision=refused reason=nested_vault duration_ms=\d+$/.test(line)),
    result.logs.join(" | "));
});

test("a claimant waits on its envelope, then saves the approved key before restarting sync", async (t) => {
  const result = await claimant(t, ({ ApiError, sealed, attempt }) => {
    if (attempt === 1) throw new ApiError(409, "not_approved", "approval pending");
    return { outcome: "ok", value: sealed };
  }, (modal) => { void modal.claim(); }); // Repeated taps do not claim twice.
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "survey"]);
  assert.deepEqual(result.asked, [], "a vault holding nothing new pairs without a question");
  assert.equal(result.saves.length, 2);
  assert.equal(result.saves[0].vrk, null);
  assert.equal(result.saves[1].vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
  assert.ok(result.logs.includes("pairing role=claimant decision=waiting reason=not_approved"));
  assert.ok(result.logs.includes("pairing role=claimant decision=paired"));
  assert.ok(result.notices.some((notice) => notice.includes("This device is paired")));
});

test("sync stays stopped while the approved key save is pending", async (t) => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const saving = new Promise((resolve) => { entered = resolve; });
  const finished = claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), undefined,
    async (observation) => { entered(observation); await held; });
  let before;
  try {
    const observation = await Promise.race([saving, finished.then(() => {
      throw new Error("claim finished before entering the key save");
    })]);
    before = observation.restartCalls();
    assert.equal(observation.saves.length, 1, "only the device credential is persisted while the key write is held");
    assert.equal(observation.saves[0].vrk, null);
  } finally {
    release();
  }
  const result = await finished;
  assert.equal(before, 0);
  assert.equal(result.restarted, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
});

test("a rejected approved-key save never starts sync", async (t) => {
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), undefined,
    async () => { throw new Error("fixture key save failed"); });
  assert.equal(result.restarted, 0);
  assert.equal(result.saves.length, 1);
  assert.equal(result.saves[0].vrk, null);
  assert.ok(result.notices.some((notice) => notice.includes("fixture key save failed")));
  assert.ok(!result.notices.some((notice) => notice.includes("This device is paired")));
});

test("only the explicit pending-approval refusal permits another envelope request", async (t) => {
  for (const [status, code] of [[403, "not_approved"], [409, "not_claimant"], [410, "pairing_expired"]]) {
    await t.test(`${status} ${code}`, async (subtest) => {
      const result = await claimant(subtest, ({ ApiError }) => { throw new ApiError(status, code, "terminal refusal"); });
      assert.deepEqual(result.calls, ["claim", "envelope"]);
      assert.equal(result.state.vrk, null);
      assert.equal(result.restarted, 0);
      assert.ok(result.notices.some((notice) => notice.includes(code)));
      assert.ok(result.logs.includes(`pairing role=claimant decision=failed reason=${code}`));
    });
  }
});

test("a lost envelope response is surfaced once and never fetched again", async (t) => {
  const result = await claimant(t, () => ({ outcome: "lost", reason: "network", status: 0 }));
  assert.deepEqual(result.calls, ["claim", "envelope"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("collecting the sealed vault key")));
  assert.ok(result.logs.includes("pairing role=claimant decision=failed reason=local_or_lost"));
});

test("an unclassified local error cannot masquerade as pending approval", async (t) => {
  const result = await claimant(t, () => { throw Object.assign(new Error("local failure"), { status: 409, code: "not_approved" }); });
  assert.deepEqual(result.calls, ["claim", "envelope"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("local failure")));
});

test("closing while waiting leaves the one-time envelope unconsumed", async (t) => {
  const result = await claimant(t, () => assert.fail("a closed dialog must not fetch"), (modal) => modal.onClose());
  assert.deepEqual(result.calls, ["claim"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
});

for (const stage of ["claim", "envelope", "key save"]) {
  test(`a superseded ${stage} completion cannot adopt credentials or restart the replacement session`, async (t) => {
    const replacement = { data: { vrk: "replacement sentinel", serverUrl: "https://new.example.invalid" }, save: () => assert.fail("replacement state must not be written") };
    const replace = (plugin) => { plugin.state = replacement; plugin.lifecycle = {}; };
    const result = await claimant(t, ({ sealed, plugin }) => {
      if (stage === "envelope") replace(plugin);
      return { outcome: "ok", value: sealed };
    }, undefined, async ({ plugin }) => { if (stage === "key save") replace(plugin); },
    async (plugin) => { if (stage === "claim") replace(plugin); });
    assert.deepEqual(result.current, replacement.data);
    assert.equal(result.restarted, 0);
    assert.equal(result.saves.length, stage === "claim" ? 0 : stage === "envelope" ? 1 : 2);
    assert.ok(result.notices.some((notice) => notice.includes("previous plugin session is inactive")));
  });
}

test("closing during an already-dispatched envelope preserves its key without starting another session", async (t) => {
  const result = await claimant(t, ({ sealed, modal }) => {
    modal.onClose();
    return { outcome: "ok", value: sealed };
  });
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 0);
  // The survey reads before the key is kept; nothing else is fetched.
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
});

// ---- issue #141: a second vault is never merged in silently -----------------

const approved = ({ sealed }) => ({ outcome: "ok", value: sealed });

test("a vault holding notes the server's vault does not know is asked before its first sync, and Cancel leaves", async (t) => {
  const result = await claimant(t, approved, undefined, undefined, undefined, { unknown: 3, answer: "Cancel" });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey", "leave"], "the new credential is given back");
  assert.equal(result.asked.length, 1);
  const [question] = result.asked;
  assert.match(question.text, /This vault holds 3 note\(s\) that are not in the vault https:\/\/sync\.example\.invalid holds/);
  assert.match(question.text, /uploads them to every device syncing that vault/);
  assert.match(question.text, /One server holds one vault/);
  // Cancel is the default: it holds the focus, and the upload is not the call to action.
  const [cancel, upload] = question.buttons;
  assert.equal(upload.text, "Pair and upload");
  assert.equal(upload.destructive, true);
  assert.equal(upload.cta, undefined);
  assert.equal(upload.focused, undefined);
  assert.equal(cancel.text, "Cancel");
  assert.equal(cancel.focused, true);
  assert.equal(result.restarted, 0, "no sync started, so nothing was uploaded");
  assert.ok(result.saves.every((saved) => saved.vrk === null), "the other vault's key was never kept");
  assert.ok(result.logs.includes("pairing role=claimant decision=declined unknown=3"));
  assert.ok(result.notices.some((notice) => notice.includes("nothing was uploaded")));
});

test("answering Pair and upload keeps the key and starts the first sync", async (t) => {
  const result = await claimant(t, approved, undefined, undefined, undefined, { unknown: 3, answer: "Pair and upload" });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
  assert.equal(result.asked.length, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
});

// ---- issue #143: a device that syncs is never re-paired in place ------------

const SYNCING = { vrk: "11".repeat(32), deviceId: "22".repeat(16), deviceSecret: "33".repeat(32) };

test("a device that already syncs refuses a pairing code, even its own, and claims nothing", async (t) => {
  const result = await claimant(t, () => assert.fail("nothing may be collected"), undefined, undefined, undefined, { data: SYNCING });
  assert.deepEqual(result.calls, [], "no claim was sent");
  assert.deepEqual(result.saves, []);
  assert.equal(result.state.deviceId, SYNCING.deviceId, "the identity is unchanged");
  assert.equal(result.state.deviceSecret, SYNCING.deviceSecret);
  assert.equal(result.state.vrk, SYNCING.vrk);
  assert.equal(result.restarted, 0);
  assert.ok(result.logs.includes("pairing role=claimant decision=refused reason=already_paired"));
  assert.ok(result.notices.some((notice) =>
    notice.includes('already syncs with https://sync.example.invalid as "Tablet"') && notice.includes("Leave this server")));
});

test("an enrolled device whose key never arrived may pair again", async (t) => {
  // S33: the dialog closed before approval, so the device holds a credential
  // and no key. It syncs nothing, and pairing again is its way back.
  const result = await claimant(t, approved, undefined, undefined, undefined, { data: { ...SYNCING, vrk: null } });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
  assert.equal(result.current.deviceId, KEYS.deviceId, "the new credential replaced the stranded one");
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
});
