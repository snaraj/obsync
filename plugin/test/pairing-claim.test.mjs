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
/** A six-digit match code, wherever it appears. */
const SIX = /\b\d{3} \d{3}\b/;

const id = "12".repeat(16), token = "34".repeat(32), secret = new Uint8Array(16).fill(56);

/** What a claim held across a restart looks like; 1.1.5 never writes one, so anything not `null` is one. */
const heldClaims = (result) => result.held.filter((value) => value !== null);

/**
 * A claimant dialog over a scripted server. The creator behind the code holds
 * `creator`, whose key the code commits to; `response` answers each envelope
 * poll and is handed `waiting(key)`, the not-approved refusal carrying a
 * revealed creator key or none, `sealFor(kex)`, an envelope that key pair
 * sealed for this claimant's own key, with its `creator_pub`, and `sealed`,
 * the honest creator's. `code` is the code pasted, or a function of the honest
 * code; `prelude(modal)` runs before the claim starts.
 */
async function claimant(t, response, {
  onWait = () => {}, beforeKeySave = async () => {}, beforeClaim = async () => {},
  unknown = 0, answer = null, data = {}, root = null, revoke = () => ({ outcome: "ok", value: undefined }),
  code = null, waits = 3, onRestart = () => {}, field = null, prelude = () => {},
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
  // The creator behind the code, and a stranger holding a key of its own.
  const creator = await pairing.newPairingKeyExchange();
  const attacker = await pairing.newPairingKeyExchange();
  const honest = pairing.encodePairingCode(id, token, secret, await pairing.pairingCommitment(id, creator.publicKey));
  const calls = [], saves = [], logs = [], held = [], shown = [], claims = [], surveyed = [];
  const waiting = (key) => new ApiError(409, "not_approved", "approval pending", false, key === undefined ? {} : { creator_pub: key });
  const sealFor = async (by, ps = secret) =>
    ({ ...(await pairing.sealEnvelopeV2(by, claims[0].claimant_pub, ps, id, { vrk: KEYS.vrk })), creator_pub: by.publicKey });
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
    manifest: { version: "1.1.5" }, platformName: () => "ios",
    log: (line) => logs.push(line),
    notesUnknownTo: async (vrk) => {
      assert.equal(vrk, KEYS.vrk, "the survey reads the vault with the key the envelope carried");
      calls.push("survey");
      // What the dialog says while the survey runs.
      surveyed.push(shown.at(-1));
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
        await beforeClaim(plugin, { shown });
        return { outcome: "ok", value: { device_id: KEYS.deviceId, device_secret: KEYS.deviceSecret } };
      },
      pairingStatus: async () => { calls.push("creator-status"); throw new Error("creator-only route"); },
      pairingEnvelope: async (pairingId) => {
        assert.equal(pairingId, id); calls.push("envelope");
        assert.equal(plugin.credential(state)?.id, KEYS.deviceId, "the claim signs its own collection");
        assert.equal(state.data.deviceSecret, data.deviceSecret ?? null, "no credential is kept before its key");
        const sealed = await sealFor(creator);
        return response({ ApiError, sealed, plugin, modal, pairing, claims, creator, attacker, waiting, sealFor,
          attempt: calls.filter((call) => call === "envelope").length });
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
  const pasted = typeof code === "function" ? code(honest, pairing) : code ?? honest;
  const modal = new PairClaimModal({ vault: { getName: () => "Pairing test vault", getMarkdownFiles: () => [1, 2] } }, plugin, pasted);
  modal.contentEl = { createEl: () => ({ setText: (text) => shown.push(text) }), empty: () => {} };
  modal.close = () => modal.onClose();
  // The Pairing code field `onOpen` draws, where a test asks about it.
  if (field !== null) modal.codeField = field;
  const previousWindow = globalThis.window;
  globalThis.window = {
    setTimeout: (resolve, delay) => {
      assert.equal(delay, 2000);
      assert.ok(++waited <= waits, "terminal outcomes must not poll indefinitely");
      onWait(modal, waited, plugin); resolve();
    },
    clearTimeout: () => undefined,
    // The disk watchdog of the nested-vault check's reads (#302, #307): armed, never run, since every read here answers.
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  t.after(() => { globalThis.window = previousWindow; });
  prelude(modal);
  await modal.claim();
  // A claim handed to the background finishes there.
  await plugin.waiting?.done;
  return { calls, saves, logs, notices, restarted, asked, held, shown, claims, surveyed, plugin, pairing, modal, creator, attacker,
    state: state.data, current: plugin.state.data };
}

/** The approval: the honest creator's envelope, at the first poll. */
const approved = ({ sealed }) => ({ outcome: "ok", value: sealed });

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
    `obsync: This folder is inside the synced vault "${nodePath.basename(outer)}". Syncing it too would copy that vault into ` +
      "itself. Open the outer vault instead, or use Selected folders there.",
  ]);
  assert.ok(result.logs.some((line) => /^pairing role=claimant decision=refused reason=nested_vault duration_ms=\d+$/.test(line)),
    result.logs.join(" | "));
});

test("a claimant waits on its envelope, then keeps its credential and the key in one save before restarting sync (#153)", async (t) => {
  let during;
  const result = await claimant(t, ({ sealed, attempt, waiting }) => {
    if (attempt === 1) throw waiting();
    return { outcome: "ok", value: sealed };
  }, { onWait: (modal, waited, plugin) => {
    void modal.claim(); // Repeated taps do not claim twice.
    during ??= { saves: plugin.state.data.deviceId, held: plugin.state.heldClaim() };
  } });
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "survey"]);
  assert.deepEqual(result.asked, [], "a vault holding nothing new pairs without a question");
  // NOT KEPT, AND NOT HELD: while it waited, the credential was the claim's
  // alone, in memory, beside a private key that cannot be written down.
  assert.equal(during.saves, null, "no credential is stored before the key");
  assert.equal(during.held, null, "nothing of the claim is written down for a restart");
  assert.equal(result.saves.length, 1, "credential and key are one save");
  assert.equal(result.saves[0].deviceId, KEYS.deviceId);
  assert.equal(result.saves[0].deviceSecret, KEYS.deviceSecret);
  assert.equal(result.saves[0].vrk, KEYS.vrk);
  assert.deepEqual(heldClaims(result), []);
  assert.equal(result.plugin.waiting, null);
  assert.equal(result.restarted, 1);
  assert.ok(result.logs.includes("pairing role=claimant decision=waiting reason=not_approved"));
  assert.ok(result.logs.some((line) => /^pairing role=claimant decision=paired duration_ms=\d+$/.test(line)), result.logs.join(" | "));
  assert.ok(result.notices.some((notice) => notice.includes("this device is paired, and its first sync is running")));
});

test("the claim names this device by what it is and its own tag, never the bare platform (#152)", async (t) => {
  const result = await claimant(t, approved, { data: { deviceTag: null } });
  const [info] = result.claims;
  assert.equal(info.platform, "ios");
  assert.notEqual(info.name, "ios");
  assert.match(info.name, /^iPhone [2-9A-HJKMNP-TV-Z]{4}$/);
  // Kept BEFORE the claim, so a restart cannot give the device a second name.
  assert.equal(result.saves[0].deviceTag, info.name.slice("iPhone ".length));
  assert.equal(result.saves[0].deviceId, null, "that first save carries no credential");
  assert.equal(result.plugin.deviceName(), info.name, "the server is told the name this device shows");
});

test("the claimant shows the match code its own key and the creator's committed key make (#152)", async (t) => {
  const result = await claimant(t, ({ attempt, waiting, creator, sealed }) => {
    if (attempt === 1) throw waiting(creator.publicKey);
    return { outcome: "ok", value: sealed };
  });
  const code = await result.pairing.matchCodeV2(secret, id, result.claims[0].claimant_pub, result.creator.publicKey);
  assert.match(code, /^\d{3} \d{3}$/);
  assert.ok(result.shown.includes(`Waiting for approval on the other device. Its prompt shows the code ${code}: if it shows another, choose Reject there.`),
    result.shown.join(" | "));
  // Its own key went out with the claim: the creator computes the same code from it.
  assert.equal(typeof result.claims[0].claimant_pub, "string");
});

test("a pasted pairing link pairs like the code it carries (#154)", async (t) => {
  const result = await claimant(t, approved, { code: (honest, pairing) => ` "${pairing.pairingLink(honest)}"\n` });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"]);
  assert.equal(result.restarted, 1);
});

test("sync stays stopped while the approved key save is pending", async (t) => {
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const saving = new Promise((resolve) => { entered = resolve; });
  const finished = claimant(t, approved, {
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
  const result = await claimant(t, approved, {
    beforeKeySave: async () => { throw new Error("fixture key save failed"); },
  });
  assert.equal(result.restarted, 0);
  assert.equal(result.saves.length, 0);
  assert.deepEqual(result.calls, ["claim", "envelope", "survey", "revoke"], "collection activated it, so it is revoked");
  assert.ok(result.notices.some((notice) => notice.includes("fixture key save failed")));
  assert.ok(!result.notices.some((notice) => notice.includes("this device is paired, and its first sync is running")));
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
      assert.deepEqual(heldClaims(result), [], "nothing was held");
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
  // The creator's own key, but sealed under another secret: what a code read
  // with one character wrong leaves this device holding.
  const result = await claimant(t, async ({ sealFor, creator }) => ({ outcome: "ok", value: await sealFor(creator, new Uint8Array(16).fill(57)) }));
  assert.deepEqual(result.calls, ["claim", "envelope", "revoke"]);
  assert.deepEqual(result.saves, [], "no credential and no key were kept");
  assert.equal(result.state.deviceId, null);
  assert.deepEqual(heldClaims(result), []);
  assert.equal(result.restarted, 0);
  assert.ok(result.notices.some((notice) => notice.includes("does not match the other device's")), result.notices.join(" | "));
  assert.ok(result.notices.every((notice) => notice.trim() !== "" && !RAW.test(notice)), result.notices.join(" | "));
  assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=unopened ")));
  assert.ok(result.logs.includes("pairing role=claimant decision=revoked reason=keyless"));
});

test("a device that cannot be taken back says where to revoke it (#153)", async (t) => {
  const result = await claimant(t, async ({ sealFor, creator }) => (
    { outcome: "ok", value: await sealFor(creator, new Uint8Array(16)) }
  ), { revoke: () => ({ outcome: "lost", reason: "network", attempts: 1 }) });
  assert.ok(result.notices.some((notice) => notice.includes("revoke it from the other device's Devices list")), result.notices.join(" | "));
});

test("a failure after the key is kept never takes the paired device back (#153)", async (t) => {
  const result = await claimant(t, approved, {
    onRestart: () => { throw new Error("fixture engine start failed"); },
  });
  assert.deepEqual(result.calls, ["claim", "envelope", "survey"], "nothing is revoked once the key is kept");
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.state.deviceId, KEYS.deviceId);
  assert.deepEqual(heldClaims(result), []);
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

/** The question a claim whose dialog closed raises with its code. */
const CODE_NOTICE = /pairing this device: the other device's prompt shows the code \d{3} \d{3}\. Approve there only if it shows this one/;

test("closing the dialog while waiting keeps waiting behind it, and still pairs (#153)", async (t) => {
  const result = await claimant(t, ({ sealed, attempt, waiting, creator }) => {
    if (attempt === 1) throw waiting(creator.publicKey);
    return { outcome: "ok", value: sealed };
  }, { onWait: (modal, waited) => { if (waited === 1) modal.onClose(); } });
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "survey"]);
  // Closed before the creator's key came: it says a code will come, and the
  // code comes as a notice, since the comparison is the point of it.
  const handed = result.notices.findIndex((notice) => notice.includes("still waiting in the background. When the other device asks you to approve this one, obsync shows the code to compare here"));
  const shown = result.notices.findIndex((notice) => CODE_NOTICE.test(notice));
  assert.ok(handed >= 0 && shown > handed, result.notices.join(" | "));
  assert.ok(result.notices.some((notice) => notice.includes("this device is paired, and its first sync is running")));
  assert.equal(result.restarted, 1);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
});

test("closing the dialog once its code shows raises the code at once, never the bare waiting words", async (t) => {
  const result = await claimant(t, ({ sealed, attempt, waiting, creator }) => {
    if (attempt === 1) throw waiting(creator.publicKey);
    return { outcome: "ok", value: sealed };
  }, { onWait: (modal, waited) => { if (waited === 2) modal.onClose(); } });
  assert.ok(result.notices.some((notice) => CODE_NOTICE.test(notice)), result.notices.join(" | "));
  assert.ok(!result.notices.some((notice) => notice.includes("still waiting in the background")), result.notices.join(" | "));
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  // The code is for comparing now, never for keeping: what outlives the
  // toast -- Recent, and every log line -- reads "•••" in its place.
  const kept = result.plugin.notices.recent().find((entry) => entry.text.startsWith("pairing this device:"));
  assert.ok(kept?.text.includes("the code •••."), JSON.stringify(kept));
  for (const line of [...result.logs, ...result.plugin.notices.recent().map((entry) => entry.text)]) {
    assert.ok(!/\b\d{3} \d{3}\b/.test(line), line);
  }
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
    // The newer session owns the state: this one neither revokes nor writes
    // anything down for it, and nothing of the claim was ever held.
    assert.ok(!result.calls.includes("revoke"));
    assert.deepEqual(result.held, []);
  });
}

// ---- review of PR #306: the order is the authentication --------------------

test("a claimant shows no code until the creator's key is in, then the code both keys make, and pairs", async (t) => {
  const result = await claimant(t, async ({ attempt, waiting, creator, sealed }) => {
    if (attempt === 1) throw waiting();
    if (attempt === 2) throw waiting(creator.publicKey);
    return { outcome: "ok", value: sealed };
  });
  const [info] = result.claims;
  assert.equal(typeof info.claimant_pub, "string", "the claim offered this device's key");
  const code = await result.pairing.matchCodeV2(secret, id, info.claimant_pub, result.creator.publicKey);
  const at = result.shown.findIndex((text) => text.includes(`Its prompt shows the code ${code}:`));
  assert.ok(at > 0, result.shown.join(" | "));
  assert.ok(result.shown.slice(0, at).every((text) => !SIX.test(text)), `no code before the creator's key: ${result.shown.join(" | ")}`);
  assert.ok(result.shown.slice(0, at).some((text) => text.includes("a code appears here: approve there only if both screens show the same code")),
    result.shown.join(" | "));
  assert.ok(result.logs.includes("pairing role=claimant decision=compare"));
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "envelope", "survey"]);
  assert.equal(result.saves.at(-1).vrk, KEYS.vrk);
  assert.equal(result.restarted, 1);
  assert.deepEqual(heldClaims(result), [], "its private key cannot be written down, so nothing of it is");
});

test("a revealed key the code did not commit to ends the claim, before any code is shown", async (t) => {
  const result = await claimant(t, ({ waiting, attacker }) => { throw waiting(attacker.publicKey); });
  assert.ok(result.shown.every((text) => !SIX.test(text)), result.shown.join(" | "));
  assert.ok(!result.logs.includes("pairing role=claimant decision=compare"));
  assert.ok(result.notices.some((notice) => notice.includes("The other device's key does not match the code")), result.notices.join(" | "));
  assert.ok(result.notices.every((notice) => !RAW.test(notice)), result.notices.join(" | "));
  assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=unverified ")), result.logs.join(" | "));
  assert.deepEqual(result.calls, ["claim", "envelope"], "nothing collected, so nothing to take back");
  assert.deepEqual(result.saves.filter((save) => save.vrk !== null), []);
  assert.equal(result.restarted, 0);
});

test("once its code is shown, the claim holds to that key: another, waiting or with the envelope, ends it", async (t) => {
  for (const late of ["waiting", "envelope"]) {
    const result = await claimant(t, async ({ attempt, waiting, sealFor, creator, attacker }) => {
      if (attempt === 1) throw waiting(creator.publicKey);
      if (late === "waiting") throw waiting(attacker.publicKey);
      return { outcome: "ok", value: await sealFor(attacker) };
    });
    assert.ok(result.logs.includes("pairing role=claimant decision=compare"), late);
    assert.ok(result.notices.some((notice) => notice.includes("The other device's key does not match the code")), `${late}: ${result.notices.join(" | ")}`);
    assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=unverified ")), late);
    assert.deepEqual(result.saves.filter((save) => save.vrk !== null), [], late);
    assert.equal(result.restarted, 0, late);
    // Collected, the server may hold it active: it is taken back.
    assert.deepEqual(result.calls, late === "waiting" ? ["claim", "envelope", "envelope"] : ["claim", "envelope", "envelope", "revoke"], late);
  }
});

test("an envelope with no creator key is refused, never opened some weaker way", async (t) => {
  const result = await claimant(t, async ({ attempt, waiting, creator, sealed }) => {
    if (attempt === 1) throw waiting(creator.publicKey);
    const { creator_pub, ...bare } = sealed;
    assert.equal(creator_pub, creator.publicKey);
    return { outcome: "ok", value: bare };
  });
  assert.deepEqual(result.saves.filter((save) => save.vrk !== null), [], "nothing was opened");
  assert.ok(result.logs.some((line) => line.startsWith("pairing role=claimant decision=failed reason=unverified ")), result.logs.join(" | "));
  assert.deepEqual(result.calls, ["claim", "envelope", "envelope", "revoke"]);
});

test("a code from before 1.1.5, or one cut short of its commitment, is refused before any request", async (t) => {
  const cases = [
    // id, token and secret alone: what an obsync before 1.1.5 makes.
    ["older", (honest, pairing) => pairing.encodePairingCode(id, token, secret, new Uint8Array(0)),
      "That code comes from a device running obsync older than 1.1.5"],
    // 68 bytes: past the secret, short of the commitment.
    ["cut", (honest) => honest.slice(0, 110), "That pairing code is incomplete."],
  ];
  for (const [label, code, words] of cases) {
    const result = await claimant(t, () => assert.fail("an envelope was asked for"), { code });
    assert.deepEqual(result.calls, [], `${label}: nothing reached the server`);
    assert.deepEqual(result.claims, [], label);
    assert.deepEqual(result.saves, [], `${label}: not even the device's name was kept`);
    assert.deepEqual(result.held, [], label);
    assert.ok(result.notices.some((notice) => notice.includes(words)), `${label}: ${result.notices.join(" | ")}`);
    assert.ok(result.shown.at(-1).includes(words), `${label}: ${result.shown.join(" | ")}`);
    assert.ok(result.notices.every((notice) => !RAW.test(notice)), label);
  }
});

test("a new claim clears what the dialog showed before its request goes out", async (t) => {
  // A code an earlier claim showed belongs to a pairing this one ends: it
  // must not sit on screen while the new claim's request is held.
  const stale = "Waiting for approval on the other device. Its prompt shows the code 123 456: if it shows another, choose Reject there.";
  let during;
  await claimant(t, approved, {
    prelude: (modal) => { modal.show(stale); },
    beforeClaim: async (plugin, { shown }) => { during = [...shown]; },
  });
  assert.equal(during[0], stale, "the earlier text was on screen");
  assert.equal(during.at(-1), "Claiming the pairing…", during.join(" | "));
});

// ---- issue #141: a second vault is never merged in silently -----------------

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

test("while the vault is compared after approval, the dialog says so, not that it waits for approval (#236)", async (t) => {
  // A phone with 6,069 files read "Waiting for approval on the other device"
  // for 62 s after the person had approved there.
  const result = await claimant(t, ({ attempt, waiting, creator, sealed }) => {
    if (attempt === 1) throw waiting(creator.publicKey);
    return { outcome: "ok", value: sealed };
  }, { unknown: 0, answer: null });
  assert.deepEqual(result.surveyed, [
    "Approved. Comparing the notes here with your server's vault before anything is sent. A large vault takes a minute.",
  ]);
  assert.ok(result.shown.some((line) => line.startsWith("Waiting for approval on the other device.")), "the wait before it is unchanged");
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

// ---- issue #153 after 1.1.5: a claim held from before the update is dropped -

/**
 * The plugin as a restart finds it: no dialog, and `held` in the claim's own
 * secret entry -- only an obsync before 1.1.5 ever wrote one there.
 */
function restartedWith(t, { data = {}, held = [] } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const notices = box.require("obsidian").notices;
  const logs = [];
  const state = { data: { vrk: null, deviceId: null, deviceSecret: null, deviceTag: "7KQ4", serverUrl: "https://sync.example.invalid", ...data },
    get paired() { return this.data.vrk !== null && this.data.deviceId !== null && this.data.deviceSecret !== null; },
    assertAvailable() {}, save: async () => assert.fail("dropping a held claim writes nothing else"),
    heldClaim: () => held.at(-1) ?? null, holdClaim: (value) => { held.push(value); return true; } };
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  // No route at all: whatever a drop does, it sends nothing.
  const plugin = Object.assign(new Plugin(), { state, app: {}, manifest: { version: "1.1.5" }, log: (line) => logs.push(line), transport: {} });
  plugin.resumePairing();
  return { logs, held, notices, plugin, state: state.data };
}

const OLD_CLAIM = JSON.stringify({ pairingId: id, pairingSecret: Buffer.from(secret).toString("hex"), deviceId: KEYS.deviceId,
  deviceSecret: KEYS.deviceSecret, serverUrl: "https://sync.example.invalid", claimedAt: Date.now() - 60_000 });

test("a claim an obsync before 1.1.5 held across the update is dropped, never finished, and the device is told to pair again", async (t) => {
  // Finishing it would open its key the way 1.1.5 no longer pairs.
  const result = restartedWith(t, { held: [OLD_CLAIM] });
  assert.equal(result.held.at(-1), null, "the entry is emptied");
  assert.equal(result.plugin.waiting, null, "nothing is collected");
  assert.equal(result.state.vrk, null);
  assert.equal(result.state.deviceId, null, "its credential is never adopted");
  assert.deepEqual(result.logs.filter((line) => line.startsWith("pairing ")), ["pairing role=claimant decision=dropped reason=held_before_update"]);
  assert.equal(result.notices.length, 1, result.notices.join(" | "));
  assert.ok(result.notices[0].includes("pairing this device stopped when obsync updated") && result.notices[0].includes("Pair a new device"),
    result.notices[0]);
  assert.ok(result.notices.every((notice) => !RAW.test(notice) && !/recovery phrase/i.test(notice)));
});

test("a paired device drops a leftover held claim without a word, and a device holding none drops nothing", async (t) => {
  const paired = restartedWith(t, { data: SYNCING, held: [OLD_CLAIM] });
  assert.equal(paired.held.at(-1), null);
  assert.deepEqual(paired.logs.filter((line) => line.startsWith("pairing ")), ["pairing role=claimant decision=dropped reason=held_before_update"]);
  assert.deepEqual(paired.notices, [], "a device that syncs is not told to pair again");
  assert.equal(paired.state.deviceId, SYNCING.deviceId, "its own credential is untouched");
  const none = restartedWith(t);
  assert.deepEqual(none.held, [], "nothing was written");
  assert.deepEqual(none.logs, []);
  assert.deepEqual(none.notices, []);
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
