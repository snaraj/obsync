/** Exercise the actual claimant dialog method with a non-rendering Obsidian stub. */
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { join } from "node:path";
import { createRequire } from "node:module";
import { KEYS, memorySecrets, sandbox } from "./fake.mjs";

/** A recording `Setting` button: what it says, how it is styled, whether it holds the focus. */
class Button {
  constructor() { this.buttonEl = { focus: () => { this.focused = true; } }; }
  setButtonText(value) { this.text = value; return this; }
  setCta() { this.cta = true; return this; }
  setDestructive() { this.destructive = true; return this; }
  onClick(handler) { this.click = handler; return this; }
}

/** No notice says a status, a server code or a cryptographic detail (issue #154). */
const RAW = /\b(401|403|404|409|410)\b|not_approved|not_claimant|pairing_expired|bad_signature|envelope_consumed|OperationError|decrypt|AES|GCM|byte/;

const id = "12".repeat(16), token = "34".repeat(32), secret = new Uint8Array(16).fill(56);

async function claimant(t, response, {
  onWait = () => {}, beforeKeySave = async () => {}, beforeClaim = async () => {},
  unknown = 0, answer = null, data = {}, root = null, revoke = () => ({ outcome: "ok", value: undefined }),
  code = null, waits = 3, onRestart = () => {}, field = null,
} = {}) {
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
  const sealed = await pairing.sealEnvelope(secret, id, { vrk: KEYS.vrk });
  const calls = [], saves = [], logs = [], held = [], shown = [], claims = [];
  let restarted = 0, waited = 0;
  const state = { data: { vrk: null, deviceId: null, deviceSecret: null, deviceName: null, deviceTag: "7KQ4", serverUrl: "https://sync.example.invalid", ...data },
    // `State.paired`, over the same three fields.
    get paired() { return this.data.vrk !== null && this.data.deviceId !== null && this.data.deviceSecret !== null; },
    assertAvailable() {}, save: async () => {
      const snapshot = { ...state.data };
      if (snapshot.vrk !== null && snapshot.vrk !== data.vrk) await beforeKeySave({ saves, plugin, restartCalls: () => restarted });
      saves.push(snapshot);
    },
    heldClaim: () => held.at(-1) ?? null,
    holdClaim: (value) => { held.push(value); return true; } };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const plugin = Object.assign(new Plugin(), {
    state,
    manifest: { version: "1.1.4" }, platformName: () => "ios",
    log: (line) => logs.push(line),
    notesUnknownTo: async (vrk) => {
      assert.equal(vrk, KEYS.vrk, "the survey reads the vault with the key the envelope carried");
      calls.push("survey");
      return unknown;
    },
    restartEngine: async () => {
      restarted++;
      assert.equal(saves.at(-1)?.vrk, KEYS.vrk, "the approved key must already be persisted");
      onRestart();
    },
    transport: {
      pairingClaim: async (pairingId, enrollToken, info) => {
        assert.deepEqual(await pairing.openPairingVault(secret, id, info.vault), { name: "Pairing test vault", notes: 2 });
        assert.ok(!JSON.stringify(info).includes("Pairing test vault"), "the server receives ciphertext only");
        assert.equal(pairingId, id); assert.equal(enrollToken, token);
        claims.push(info);
        calls.push("claim");
        await beforeClaim(plugin);
        return { outcome: "ok", value: { device_id: KEYS.deviceId, device_secret: KEYS.deviceSecret } };
      },
      pairingStatus: async () => { calls.push("creator-status"); throw new Error("creator-only route"); },
      pairingEnvelope: async (pairingId) => {
        assert.equal(pairingId, id); calls.push("envelope");
        assert.equal(plugin.credential(state)?.id, KEYS.deviceId, "the claim signs its own collection");
        assert.equal(state.data.deviceSecret, data.deviceSecret ?? null, "no credential is kept before its key");
        return response({ ApiError, sealed, plugin, modal, pairing, attempt: calls.filter((call) => call === "envelope").length });
      },
      revokeDevice: async (deviceId) => {
        calls.push(deviceId === KEYS.deviceId ? "revoke" : `revoke:${deviceId}`);
        return revoke({ ApiError, deviceId });
      },
    },
  });
  // The real host: over no filesystem unless a test names the vault root on disk.
  const { ObsidianHost } = box.require(join(box.home, "build/main.js"));
  plugin.host = new ObsidianHost(plugin, root === null ? null : { fs: { promises: fsPromises }, path: nodePath, base: root });
  const modal = new PairClaimModal({ vault: { getName: () => "Pairing test vault", getMarkdownFiles: () => [1, 2] } }, plugin,
    code ?? pairing.encodePairingCode(id, token, secret));
  modal.contentEl = { createEl: () => ({ setText: (text) => shown.push(text) }), empty: () => {} };
  modal.close = () => modal.onClose();
  // The Pairing code field `onOpen` draws, where a test asks about it.
  if (field !== null) modal.codeField = field;
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (resolve, delay) => {
    assert.equal(delay, 2000);
    assert.ok(++waited <= waits, "terminal outcomes must not poll indefinitely");
    onWait(modal, waited, plugin); resolve();
  } };
  t.after(() => { globalThis.window = previousWindow; });
  await modal.claim();
  // A claim handed to the background finishes there.
  await plugin.waiting?.done;
  return { calls, saves, logs, notices, restarted, asked, held, shown, claims, plugin, pairing, modal, state: state.data, current: plugin.state.data };
}

test("a vault inside a vault that syncs with obsync refuses to pair before any request (#180)", async (t) => {
  // S96: the folder `Sub` of a synced vault, opened as a vault of its own and
  // paired with the same server, filled every device with `Sub/Sub/Sub/…`.
  const outer = mkdtempSync(join(tmpdir(), "obsync-outer-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  mkdirSync(join(outer, ".obsidian", "plugins", "obsync-private-sync"), { recursive: true });
  const root = join(outer, "Sub");
  mkdirSync(join(root, ".obsidian", "plugins", "obsync-private-sync"), { recursive: true });
  const result = await claimant(t, () => assert.fail("an envelope was asked for"), { root });
  assert.deepEqual(result.calls, [], "nothing reached the server: no claim, no envelope, no survey");
  assert.deepEqual(result.saves, [], "no credential was kept");
  assert.deepEqual(result.held, [], "no claim was held");
  assert.equal(result.restarted, 0);
  assert.deepEqual(result.notices, [
    `This folder is inside the synced vault "${nodePath.basename(outer)}". Syncing it too would copy that vault into ` +
      "itself. Open the outer vault instead, or use Selected folders there.",
  ]);
  assert.ok(result.logs.some((line) => /^pairing role=claimant decision=refused reason=nested_vault duration_ms=\d+$/.test(line)),
    result.logs.join(" | "));
});

test("a claimant waits on its envelope, then keeps its credential and the key in one save before restarting sync (#153)", async (t) => {
  let during;
  const result = await claimant(t, ({ ApiError, sealed, attempt }) => {
    if (attempt === 1) throw new ApiError(409, "not_approved", "approval pending");
    return { outcome: "ok", value: sealed };
  }, { onWait: (modal, waited, plugin) => {
    void modal.claim(); // Repeated taps do not claim twice.
    during ??= { saves: plugin.state.data.deviceId, held: plugin.state.heldClaim() };
  } });
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "survey"]);
  assert.deepEqual(result.asked, [], "a vault holding nothing new pairs without a question");
  // HELD, NOT KEPT: while it waited, the credential was the claim's alone.
  assert.equal(during.saves, null, "no credential is stored before the key");
  const claim = JSON.parse(during.held);
  assert.deepEqual(claim, { ...claim, pairingId: id, deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret,
    serverUrl: "https://sync.example.invalid", pairingSecret: Buffer.from(secret).toString("hex") });
  assert.equal(result.saves.length, 1, "credential and key are one save");
  assert.equal(result.saves[0].deviceId, KEYS.deviceId);
  assert.equal(result.saves[0].deviceSecret, KEYS.deviceSecret);
  assert.equal(result.saves[0].vrk, KEYS.vrk);
  assert.equal(result.held.at(-1), null, "the held claim is dropped once the key is kept");
  assert.equal(result.plugin.waiting, null);
  assert.equal(result.restarted, 1);
  assert.ok(result.logs.includes("pairing role=claimant decision=waiting reason=not_approved"));
  assert.ok(result.logs.some((line) => /^pairing role=claimant decision=paired duration_ms=\d+$/.test(line)), result.logs.join(" | "));
  assert.ok(result.notices.some((notice) => notice.includes("This device is paired")));
});

test("the claim names this device by what it is and its own tag, never the bare platform (#152)", async (t) => {
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), { data: { deviceTag: null } });
  const [info] = result.claims;
  assert.equal(info.platform, "ios");
  assert.notEqual(info.name, "ios");
  assert.match(info.name, /^iPhone [2-9A-HJKMNP-TV-Z]{4}$/);
  // Kept BEFORE the claim, so a restart cannot give the device a second name.
  assert.equal(result.saves[0].deviceTag, info.name.slice("iPhone ".length));
  assert.equal(result.saves[0].deviceId, null, "that first save carries no credential");
  assert.equal(result.plugin.deviceName(), info.name, "the server is told the name this device shows");
});

test("the claimant shows the match code only this claim's device and secret produce (#152)", async (t) => {
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }));
  const code = await result.pairing.matchCode(secret, id, KEYS.deviceId);
  assert.match(code, /^\d{3} \d{3}$/);
  assert.ok(result.shown.some((text) => text.includes(`the code ${code}`)), result.shown.join(" | "));
  // A second device racing the same leaked code holds another id, and so another code.
  assert.notEqual(await result.pairing.matchCode(secret, id, "ab".repeat(16)), code);
});

test("a pasted pairing link pairs like the code it carries (#154)", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const link = pairing.pairingLink(pairing.encodePairingCode(id, token, secret));
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), { code: ` "${link}"\n` });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
  assert.equal(result.restarted, 1);
});

test("sync stays stopped while the approved key save is pending", async (t) => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const saving = new Promise((resolve) => { entered = resolve; });
  const finished = claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), {
    beforeKeySave: async (observation) => { entered(observation); await held; },
  });
  let before;
  try {
    const observation = await Promise.race([saving, finished.then(() => {
      throw new Error("claim finished before entering the key save");
    })]);
    before = observation.restartCalls();
    assert.equal(observation.saves.length, 0, "nothing is persisted before the key and credential together");
  } finally {
    release();
  }
  const result = await finished;
  assert.equal(before, 0);
  assert.equal(result.restarted, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
});

test("a rejected approved-key save never starts sync, and takes the collected device back (#153)", async (t) => {
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), {
    beforeKeySave: async () => { throw new Error("fixture key save failed"); },
  });
  assert.equal(result.restarted, 0);
  assert.equal(result.saves.length, 0);
  assert.deepEqual(result.calls, ["claim", "envelope", "survey", "revoke"], "collection activated it, so it is revoked");
  assert.ok(result.notices.some((notice) => notice.includes("fixture key save failed")));
  assert.ok(!result.notices.some((notice) => notice.includes("This device is paired")));
});

test("every refusal that ends a claim ends it in words, and only not_approved polls again (#153, #154)", async (t) => {
  const cases = [
    [403, "not_approved", null, []],
    [409, "not_claimant", null, []],
    [410, "pairing_expired", "expired", []],
    [401, "bad_signature", "refused", []],
    [410, "envelope_consumed", "consumed", ["revoke"]],
  ];
  for (const [status, code, reason, taken] of cases) {
    await t.test(`${status} ${code}`, async (subtest) => {
      const result = await claimant(subtest, ({ ApiError }) => { throw new ApiError(status, code, "terminal refusal"); });
      assert.deepEqual(result.calls, ["claim", "envelope", ...taken]);
      assert.equal(result.state.vrk, null);
      assert.equal(result.state.deviceId, null, "no credential remains");
      assert.equal(result.held.at(-1), null, "the held claim is dropped");
      assert.equal(result.restarted, 0);
      assert.ok(result.notices.length > 0 && result.notices.every((notice) => notice.trim() !== "" && !RAW.test(notice)),
        result.notices.join(" | "));
      assert.ok(result.logs.some((line) => line.startsWith(`pairing role=claimant decision=failed reason=${reason ?? code} duration_ms=`)),
        result.logs.join(" | "));
    });
  }
});

test("a rejected claim says the other device did not approve it, and pair again (#153)", async (t) => {
  const result = await claimant(t, ({ ApiError }) => { throw new ApiError(401, "bad_signature", "request signature does not verify"); });
  assert.ok(result.notices.some((notice) => notice.includes("did not approve this device") && notice.includes("Pair a new device")),
    result.notices.join(" | "));
});

test("a lost envelope response ends the claim, takes the device back and is never fetched again", async (t) => {
  const result = await claimant(t, () => ({ outcome: "lost", reason: "network", attempts: 1 }));
  assert.deepEqual(result.calls, ["claim", "envelope", "revoke"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("collecting the sealed vault key") && notice.includes("Pair a new device")));
  assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=local_or_lost ")));
});

test("an unclassified local error cannot masquerade as pending approval", async (t) => {
  const result = await claimant(t, () => { throw Object.assign(new Error("local failure"), { status: 409, code: "not_approved" }); });
  assert.deepEqual(result.calls, ["claim", "envelope"]);
  assert.equal(result.state.vrk, null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("local failure")));
});

test("a mistyped pairing secret ends the claim in words, takes the device back and keeps nothing (#153)", async (t) => {
  const result = await claimant(t, async ({ pairing }) => {
    const other = new Uint8Array(16).fill(57);
    return { outcome: "ok", value: await pairing.sealEnvelope(other, id, { vrk: KEYS.vrk }) };
  });
  assert.deepEqual(result.calls, ["claim", "envelope", "revoke"]);
  assert.deepEqual(result.saves, [], "no credential and no key were kept");
  assert.equal(result.state.deviceId, null);
  assert.equal(result.held.at(-1), null);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("does not match the other device's")), result.notices.join(" | "));
  assert.ok(result.notices.every((notice) => notice.trim() !== "" && !RAW.test(notice)), result.notices.join(" | "));
  assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=unopened ")));
  assert.ok(result.logs.includes("pairing role=claimant decision=revoked reason=keyless"));
});

test("a device that cannot be taken back says where to revoke it (#153)", async (t) => {
  const result = await claimant(t, async ({ pairing }) => (
    { outcome: "ok", value: await pairing.sealEnvelope(new Uint8Array(16), id, { vrk: KEYS.vrk }) }
  ), { revoke: () => ({ outcome: "lost", reason: "network", attempts: 1 }) });
  assert.ok(result.notices.some((notice) => notice.includes("revoke it from the other device's Devices list")), result.notices.join(" | "));
});

test("a failure after the key is kept never takes the paired device back (#153)", async (t) => {
  const result = await claimant(t, ({ sealed }) => ({ outcome: "ok", value: sealed }), {
    onRestart: () => { throw new Error("fixture engine start failed"); },
  });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"], "nothing is revoked once the key is kept");
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.state.deviceId, KEYS.deviceId);
  assert.equal(result.held.at(-1), null);
  assert.ok(result.notices.some((notice) => notice.includes("fixture engine start failed")));
  assert.ok(!result.notices.some((notice) => notice.includes("Pair a new device")), "a paired device is not told to pair again");
});

test("a hostile refusal code is a word, never a prototype member (#154)", async (t) => {
  const result = await claimant(t, ({ ApiError }) => { throw new ApiError(418, "constructor", "sentinel"); });
  assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=constructor duration_ms=")),
    result.logs.join(" | "));
  assert.ok(result.notices.some((notice) => notice.includes("The server refused this step") && notice.includes("Pair a new device")),
    result.notices.join(" | "));
  assert.ok(result.notices.every((notice) => !notice.includes("sentinel") && !notice.includes("function")));
});

test("a never-approved claim is not revoked: the server destroys it at the end of the window", async (t) => {
  const result = await claimant(t, ({ ApiError }) => { throw new ApiError(410, "pairing_expired", "the pairing has expired"); });
  assert.ok(!result.calls.includes("revoke"), "nothing the server may hold as active");
});

test("closing the dialog while waiting keeps waiting behind it, and still pairs (#153)", async (t) => {
  const result = await claimant(t, ({ ApiError, sealed, attempt }) => {
    if (attempt === 1) throw new ApiError(409, "not_approved", "approval pending");
    return { outcome: "ok", value: sealed };
  }, { onWait: (modal, waited) => { if (waited === 1) modal.onClose(); } });
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "survey"]);
  assert.ok(result.notices.some((notice) => notice.includes("still waiting for approval in the background")), result.notices.join(" | "));
  assert.ok(result.notices.some((notice) => notice.includes("This device is paired")));
  assert.equal(result.restarted, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
});

test("closing during an already-dispatched envelope still keeps its key and pairs", async (t) => {
  const result = await claimant(t, ({ sealed, modal }) => {
    modal.onClose();
    return { outcome: "ok", value: sealed };
  });
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
  // The survey reads before the key is kept; nothing else is fetched.
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
});

for (const stage of ["claim", "envelope", "key save"]) {
  test(`a superseded ${stage} completion cannot adopt credentials or restart the replacement session`, async (t) => {
    const replacement = { data: { vrk: "replacement sentinel", serverUrl: "https://new.example.invalid" }, save: () => assert.fail("replacement state must not be written") };
    const replace = (plugin) => { plugin.state = replacement; plugin.lifecycle = {}; };
    const result = await claimant(t, ({ sealed, plugin }) => {
      if (stage === "envelope") replace(plugin);
      return { outcome: "ok", value: sealed };
    }, {
      beforeKeySave: async ({ plugin }) => { if (stage === "key save") replace(plugin); },
      beforeClaim: async (plugin) => { if (stage === "claim") replace(plugin); },
    });
    assert.deepEqual(result.current, replacement.data);
    assert.equal(result.restarted, 0);
    assert.equal(result.saves.length, stage === "key save" ? 1 : 0);
    assert.ok(result.notices.some((notice) => notice.includes("previous plugin session is inactive")));
    // The newer session resumes a held claim; this one neither drops nor revokes it.
    assert.ok(!result.calls.includes("revoke"));
    if (stage !== "claim") assert.notEqual(result.held.at(-1), null);
  });
}

// ---- issue #141: a second vault is never merged in silently -----------------

const approved = ({ sealed }) => ({ outcome: "ok", value: sealed });

test("a vault holding notes the server's vault does not know is asked before its first sync, and Cancel takes the device back", async (t) => {
  const result = await claimant(t, approved, { unknown: 3, answer: "Cancel" });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey", "revoke"], "the new credential is given back");
  assert.equal(result.asked.length, 1);
  const [question] = result.asked;
  assert.ok(question.text.includes("This vault has 3 notes the server's vault does not. Pairing uploads them to every device that " +
    "syncs with this server. One server holds one vault: a different vault needs a server of its own."), question.text);
  assert.doesNotMatch(question.text, /https?:|note\(s\)/, "no address mid-sentence, and no note(s)");
  // Cancel is the default: it holds the focus, and the upload is not the call to action.
  const [cancel, upload] = question.buttons;
  assert.equal(upload.text, "Pair and upload");
  assert.equal(upload.destructive, true);
  assert.equal(upload.cta, undefined);
  assert.equal(upload.focused, undefined);
  assert.equal(cancel.text, "Cancel");
  assert.equal(cancel.focused, true);
  assert.equal(result.restarted, 0, "no sync started, so nothing was uploaded");
  assert.deepEqual(result.saves, [], "the other vault's key and its credential were never kept");
  assert.ok(result.logs.includes("pairing role=claimant decision=declined unknown=3"));
  assert.ok(result.notices.some((notice) => notice.includes("nothing was uploaded")));
});

test("one note the server's vault does not have is one note, and it is uploaded (iPhone pass, 2026-09-26)", async (t) => {
  const result = await claimant(t, approved, { unknown: 1, answer: "Cancel" });
  assert.ok(result.asked[0].text.includes("This vault has 1 note the server's vault does not. Pairing uploads it to every device"),
    result.asked[0].text);
});

test("the pasted code leaves its field once the server holds the claim, and stays for a correction until then", async (t) => {
  const set = [];
  const field = { setValue(value) { set.push(value); return this; } };
  const claimed = await claimant(t, approved, { field });
  assert.deepEqual(set, [""], "the one-time code stayed on screen under Waiting for approval");
  assert.equal(claimed.modal.code, "", "the dialog kept the code, and a later press would send it again");
  const refused = [];
  await claimant(t, approved, { code: "not-a-pairing-code", field: { setValue(value) { refused.push(value); return this; } } });
  assert.deepEqual(refused, [], "a code this device could not read was taken away before it could be corrected");
});

test("answering Pair and upload keeps the key and starts the first sync", async (t) => {
  const result = await claimant(t, approved, { unknown: 3, answer: "Pair and upload" });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
  assert.equal(result.asked.length, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
});

// ---- issue #143: a device that syncs is never re-paired in place ------------

const SYNCING = { vrk: "11".repeat(32), deviceId: "22".repeat(16), deviceSecret: "33".repeat(32) };

test("a device that already syncs refuses a pairing code, even its own, and claims nothing", async (t) => {
  const result = await claimant(t, () => assert.fail("nothing may be collected"), { data: SYNCING });
  assert.deepEqual(result.calls, [], "no claim was sent");
  assert.deepEqual(result.saves, []);
  assert.equal(result.state.deviceId, SYNCING.deviceId, "the identity is unchanged");
  assert.equal(result.state.deviceSecret, SYNCING.deviceSecret);
  assert.equal(result.state.vrk, SYNCING.vrk);
  assert.equal(result.restarted, 0);
  assert.ok(result.logs.includes("pairing role=claimant decision=refused reason=already_paired"));
  assert.ok(result.notices.some((notice) =>
    notice.includes('already syncs with https://sync.example.invalid as "iPhone 7KQ4"') && notice.includes("Leave this server")));
});

test("an enrolled device whose key never arrived pairs again, and its stranded credential is revoked", async (t) => {
  // S33: the dialog closed before approval, so an older version kept a
  // credential and no key. It syncs nothing, and pairing again is its way back.
  const stranded = { ...SYNCING, vrk: null };
  const result = await claimant(t, approved, { data: stranded });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey", `revoke:${SYNCING.deviceId}`]);
  assert.equal(result.current.deviceId, KEYS.deviceId, "the new credential replaced the stranded one");
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
  assert.ok(result.logs.includes("pairing role=claimant decision=revoked reason=stranded_enrolment"));
});

test("a key from another vault is a phrase this device has not confirmed; the same key keeps its confirmation (#170)", async (t) => {
  // A phrase restored for one vault, then a pairing into another: the words
  // this device confirmed are not the new vault's.
  const other = await claimant(t, approved, { data: { vrk: "99".repeat(32), recoveryPhrase: "confirmed" } });
  assert.equal(other.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(other.saves.at(-1).recoveryPhrase, "unconfirmed");
  const same = await claimant(t, approved, { data: { vrk: KEYS.vrk, recoveryPhrase: "confirmed" } });
  assert.equal(same.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(same.saves.at(-1).recoveryPhrase, "confirmed");
});

// ---- issue #153: a restart resumes a held claim inside its window ----------

/** The plugin as a restart finds it: no dialog, a claim held in its own entry. */
async function resumed(t, claimedAt, response, before = () => {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const { ApiError } = box.require(join(box.home, "build/transport.js"));
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const notices = box.require("obsidian").notices;
  const sealed = await pairing.sealEnvelope(secret, id, { vrk: KEYS.vrk });
  const claim = { pairingId: id, pairingSecret: Buffer.from(secret).toString("hex"), deviceId: KEYS.deviceId,
    deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid", claimedAt };
  const calls = [], logs = [], held = [JSON.stringify(claim)];
  let restarted = 0;
  const state = { data: { vrk: null, deviceId: null, deviceSecret: null, deviceTag: "7KQ4", serverUrl: claim.serverUrl },
    get paired() { return this.data.vrk !== null && this.data.deviceId !== null; },
    assertAvailable() {}, save: async () => {},
    heldClaim: () => held.at(-1), holdClaim: (value) => { held.push(value); return true; } };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const plugin = Object.assign(new Plugin(), {
    state, app: {}, manifest: { version: "1.1.4" }, log: (line) => logs.push(line),
    notesUnknownTo: async () => 0, restartEngine: async () => { restarted++; },
    transport: {
      pairingEnvelope: async () => { calls.push("envelope"); return response({ ApiError, sealed }); },
      revokeDevice: async () => { calls.push("revoke"); return { outcome: "ok" }; },
    },
  });
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (resolve) => resolve() };
  t.after(() => { globalThis.window = previousWindow; });
  before(plugin);
  plugin.resumePairing();
  await plugin.waiting?.done;
  return { calls, logs, held, notices, restarted, state: state.data, pairing };
}

test("a restarted device resumes collecting its held claim inside the window and pairs", async (t) => {
  const result = await resumed(t, Date.now() - 60_000, ({ sealed }) => ({ outcome: "ok", value: sealed }));
  assert.deepEqual(result.calls, ["envelope"]);
  assert.equal(result.restarted, 1);
  assert.equal(result.state.vrk, KEYS.vrk);
  assert.equal(result.state.deviceId, KEYS.deviceId);
  assert.equal(result.held.at(-1), null);
  const code = await result.pairing.matchCode(secret, id, KEYS.deviceId);
  assert.ok(result.notices.some((notice) => notice.includes("still pairing this device") && notice.includes(code)), result.notices.join(" | "));
  assert.ok(result.logs.some((line) => /^pairing role=claimant decision=resumed age_ms=\d+ window_ms=600000$/.test(line)));
});

test("a claim an older session was still collecting is resumed, not dropped, by a reload", async (t) => {
  const result = await resumed(t, Date.now() - 60_000, ({ sealed }) => ({ outcome: "ok", value: sealed }),
    (plugin) => { plugin.waiting = { claim: { deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret }, stop: false, done: Promise.resolve(false) }; });
  assert.deepEqual(result.calls, ["envelope"]);
  assert.equal(result.restarted, 1);
  assert.equal(result.state.vrk, KEYS.vrk);
  assert.ok(!result.logs.includes("pairing role=claimant decision=dropped reason=stale_claim"));
});

test("a restarted device past the window says pair again, not the recovery phrase, and takes itself back", async (t) => {
  const result = await resumed(t, Date.now() - 11 * 60_000, () => assert.fail("an expired claim collects nothing"));
  assert.deepEqual(result.calls, ["revoke"], "it may have collected before the restart");
  assert.equal(result.held.at(-1), null);
  assert.equal(result.state.deviceId, null);
  assert.ok(result.notices.some((notice) => notice.includes("expired") && notice.includes("Pair a new device")), result.notices.join(" | "));
  assert.ok(result.notices.every((notice) => !/recovery phrase/i.test(notice)));
});

test("a restarted device that collected but never kept the key takes itself back and says so", async (t) => {
  const result = await resumed(t, Date.now() - 60_000, ({ ApiError }) => { throw new ApiError(410, "envelope_consumed", "taken"); });
  assert.deepEqual(result.calls, ["envelope", "revoke"]);
  assert.ok(result.notices.some((notice) => notice.includes("stopped before keeping it")), result.notices.join(" | "));
});

test("a held claim is dropped, unread, once the device is paired or on another server", async (t) => {
  for (const data of [{ vrk: "11".repeat(32), deviceId: "22".repeat(16), deviceSecret: "33".repeat(32) }, { serverUrl: "https://other.example.invalid" }]) {
    const box = sandbox();
    t.after(() => rmSync(box.home, { recursive: true, force: true }));
    const held = [JSON.stringify({ pairingId: id, pairingSecret: "00".repeat(16), deviceId: KEYS.deviceId,
      deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid", claimedAt: Date.now() })];
    const Plugin = box.require(join(box.home, "build/main.js")).default;
    const state = { data: { vrk: null, deviceId: null, deviceSecret: null, serverUrl: "https://sync.example.invalid", ...data },
      get paired() { return this.data.vrk !== null && this.data.deviceId !== null; },
      heldClaim: () => held.at(-1), holdClaim: (value) => { held.push(value); return true; } };
    const logs = [];
    const plugin = Object.assign(new Plugin(), { state, log: (line) => logs.push(line), transport: {} });
    plugin.resumePairing();
    assert.equal(plugin.waiting, null);
    assert.equal(held.at(-1), null);
    assert.ok(logs.includes("pairing role=claimant decision=dropped reason=stale_claim"));
  }
});

test("a held claim lives in its own secret entry beside the credential, never in it (#153)", async () => {
  const { State } = createRequire(import.meta.url)("../build/state.js");
  const secrets = memorySecrets(), written = new Map();
  const spy = { getSecret: secrets.getSecret, setSecret: (key, value) => { written.set(key, value); secrets.setSecret(key, value); } };
  let stored = null;
  const store = { loadData: async () => stored, saveData: async (value) => { stored = structuredClone(value); } };
  const lease = { holder: null, writing: Promise.resolve() };
  const state = await State.open(store, false, spy, () => {}, () => true, lease);
  const credential = `obsync-private-sync-v1-${stored.installationId}`;
  const before = secrets.getSecret(credential);
  assert.equal(state.heldClaim(), null);
  assert.equal(state.holdClaim('{"sentinel":1}'), true);
  assert.equal(state.heldClaim(), '{"sentinel":1}');
  assert.equal(secrets.getSecret(`${credential}-claim`), '{"sentinel":1}');
  assert.equal(secrets.getSecret(credential), before, "the credential envelope is untouched");
  assert.ok(!JSON.stringify(stored).includes("sentinel"), "nothing of it reaches plugin data");
  assert.equal(state.holdClaim(null), true);
  assert.equal(state.heldClaim(), null, "dropped: SecretStorage has no delete, so it is emptied");
  assert.deepEqual([...written.keys()].sort(), [credential, `${credential}-claim`]);
  // A newer session owns the entry: an older one writes nothing.
  const newer = await State.open(store, false, spy, () => {}, () => true, lease);
  assert.equal(state.holdClaim('{"stale":1}'), false);
  assert.equal(newer.heldClaim(), null);
  assert.equal(newer.holdClaim('{"current":1}'), true);
  assert.equal(newer.heldClaim(), '{"current":1}');
});

test("only a waiting claim signs as itself; otherwise the stored credential does", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const plugin = new Plugin();
  const state = { data: { deviceId: "22".repeat(16), deviceSecret: "33".repeat(32) } };
  assert.equal(plugin.credential(state).id, "22".repeat(16));
  plugin.waiting = { claim: { deviceId: KEYS.deviceId, deviceSecret: KEYS.deviceSecret } };
  assert.equal(plugin.credential(state).id, KEYS.deviceId);
  assert.equal(Buffer.from(plugin.credential(state).secret).toString("hex"), KEYS.deviceSecret);
  plugin.waiting = null;
  assert.equal(plugin.credential({ data: { deviceId: null, deviceSecret: null } }), null);
});
