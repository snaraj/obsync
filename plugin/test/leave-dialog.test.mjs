/**
 * The "Leave this server" dialog, as a person meets it: the REAL modal class
 * from `build/ui/modals.js`, driven through its own methods with a recording
 * `contentEl` and the sandbox's non-rendering Obsidian stub.
 *
 * What is pinned here is the dialog's judgement, not its pixels: which button
 * exists, what it says, what choice it passes to `leaveServer`, and what the
 * user is told afterwards. The action itself is `leave.test.mjs`.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

const tick = () => new Promise(setImmediate);

class Component {
  setButtonText(value) { this.text = value; return this; }
  setCta() { this.cta = true; return this; }
  setDestructive() { this.destructive = true; return this; }
  setDisabled() { return this; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  setValue(value) { this.value = value; return this; }
  onChange(handler) { this.change = handler; return this; }
  onClick(handler) { this.click = handler; return this; }
}

/** A dialog whose drawing is recorded instead of rendered. */
function dialog(t, { mode = "leave", deviceId = "11".repeat(16), unpushed = [], answers = [] } = {}) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian");
  const made = [];
  const add = function (callback) { const component = new Component(); made.push(component); callback(component); return this; };
  Object.assign(obsidian.Setting.prototype, {
    setName(value) { this.name = value; return this; },
    setDesc() { return this; },
    addText: add, addButton: add,
  });
  const opened = [];
  const openedInstances = [];
  obsidian.Modal.prototype.open = function () { opened.push(this.constructor.name); openedInstances.push(this); };
  const { LeaveServerModal } = box.require(join(box.home, "build/ui/modals.js"));

  const drawn = [];
  const element = () => ({
    createEl: (tag, attributes = {}) => { drawn.push(`${tag}: ${attributes.text ?? ""}`); return element(); },
    empty: () => { drawn.length = 0; made.length = 0; },
    setText: (text) => drawn.push(`text: ${text}`),
    remove: () => {},
  });

  const choices = [];
  const plugin = {
    isMobile: false,
    state: { data: { deviceId } },
    unpushedEdits: async () => unpushed,
    leaveServer: async (choice) => {
      choices.push(choice);
      const answer = answers.shift();
      if (answer === undefined) assert.fail("the dialog asked to leave more often than the test expected");
      return typeof answer === "function" ? answer() : answer;
    },
    setServerUrl: async (value) => { choices.push(`setServerUrl:${value}`); },
  };
  let left = 0;
  const modal = new LeaveServerModal({}, plugin, mode, () => { left++; });
  modal.contentEl = element();
  modal.setTitle = (value) => { modal.title = value; };
  let closed = 0;
  modal.close = () => { closed++; modal.onClose(); };
  const button = (text) => {
    const found = made.find((component) => component.text === text);
    assert.ok(found, `button ${text} among ${made.map((c) => c.text).join(", ")}`);
    return found;
  };
  return { box, obsidian, modal, plugin, drawn, made, choices, opened, openedInstances, button,
    left: () => left, closed: () => closed, notices: obsidian.notices };
}

test("the dialog states what is kept and what is lost before it will leave", async (t) => {
  const d = dialog(t, { answers: [{ decision: "left", revoked: true }] });

  d.modal.onOpen();
  await tick();

  assert.equal(d.modal.title, "Leave this server");
  const text = d.drawn.join("\n");
  assert.match(text, /Every note in this vault stays exactly where it is/);
  assert.match(text, /the 24 words still open the SAME vault/);
  assert.match(text, /the server revokes its device id and credential/);
  assert.match(text, /No other device is touched/);
  assert.match(text, /Identical notes stay one note/);
  assert.match(text, /both versions are kept/);
  assert.equal(d.made[0].text, "Cancel", "Enter must not leave the server");
  assert.equal(d.button("Leave").destructive, true);
  d.button("Cancel");

  d.button("Leave").click();
  await tick();

  assert.deepEqual(d.choices, [{ discardUnpushed: false, localOnly: false }]);
  assert.ok(d.notices.some((notice) => notice.includes("left the server") && notice.includes("still in this vault")));
  assert.equal(d.left(), 1, "the settings tab is told to redraw");
  assert.equal(d.closed(), 1);
});

test("unpushed edits are named, counted, and only discarded on purpose", async (t) => {
  const unpushed = Array.from({ length: 12 }, (_, index) => `Notes/n${index}.md`);
  const d = dialog(t, { unpushed, answers: [{ decision: "left", revoked: true }] });

  d.modal.onOpen();
  await tick();

  const text = d.drawn.join("\n");
  assert.match(text, /12 file\(s\) on this device hold changes the server never received/);
  assert.equal(d.drawn.filter((line) => line.startsWith("li: Notes/")).length, 10, "ten paths, then a count");
  assert.match(text, /li: … and 2 more/);
  assert.equal(d.made.filter((component) => component.text === "Leave").length, 0, "no button that leaves quietly");

  d.button("Discard 12 and leave").click();
  await tick();

  assert.deepEqual(d.choices, [{ discardUnpushed: true, localOnly: false }]);
});

test("a last-device refusal offers leaving locally, and says what that leaves behind", async (t) => {
  const d = dialog(t, {
    answers: [
      { decision: "refused", reason: "last_device", detail: "the only active device cannot be revoked; pair another first" },
      { decision: "left", revoked: false },
    ],
  });

  d.modal.onOpen();
  await tick();
  d.button("Leave").click();
  await tick();

  const text = d.drawn.join("\n");
  assert.match(text, /The server refused to revoke this device: the only active device cannot be revoked; pair another first\./);
  assert.match(text, /no registered vault recovery yet/);
  assert.match(text, /setup token and 24-word recovery phrase/);
  assert.equal(d.button("Leave locally anyway").destructive, true);

  d.button("Leave locally anyway").click();
  await tick();

  assert.deepEqual(d.choices, [
    { discardUnpushed: false, localOnly: false },
    { discardUnpushed: false, localOnly: true },
  ]);
  assert.ok(d.notices.some((notice) => notice.includes("which still holds this device")));
});

test("a count that grew while the dialog waited is redrawn, not overridden", async (t) => {
  const d = dialog(t, {
    answers: [
      { decision: "refused", reason: "unpushed_edits", unpushed: ["Notes/typed-since.md"] },
    ],
  });

  d.modal.onOpen();
  await tick();
  d.button("Leave").click();
  await tick();

  assert.match(d.drawn.join("\n"), /li: Notes\/typed-since.md/);
  assert.ok(d.notices.some((notice) => notice.includes("Leaving was not done")));
  d.button("Discard 1 and leave");
  assert.equal(d.closed(), 0, "the dialog stays open on a refusal");
});

test("switch mode takes the new address and opens pairing against it", async (t) => {
  const d = dialog(t, { mode: "switch", answers: [{ decision: "left", revoked: true }] });

  d.modal.onOpen();
  await tick();
  assert.equal(d.modal.title, "Switch server");
  d.button("Leave and switch").click();
  await tick();

  assert.match(d.drawn.join("\n"), /Enter the new server's address/);
  assert.equal(d.closed(), 0, "leaving is half of switching");
  d.button("Pair with existing vault").click();
  await tick();
  assert.ok(d.notices.some((notice) => notice.includes("Enter the new server's address first")));
  assert.deepEqual(d.choices, [{ discardUnpushed: false, localOnly: false }], "an empty address saves nothing");

  d.made.find((component) => component.change !== undefined).change("other.example.invalid");
  d.button("Pair with existing vault").click();
  await tick();

  assert.deepEqual(d.choices.at(-1), "setServerUrl:other.example.invalid");
  assert.deepEqual(d.opened, ["PairClaimModal"]);
  assert.equal(d.closed(), 1);
  const beforeClose = d.left();
  d.openedInstances[0].contentEl = { empty() {} };
  d.openedInstances[0].onClose();
  assert.equal(d.left(), beforeClose + 1, "settings redraw after pairing returns with the replacement identity");
});

test("a leave that finished while the dialog was closed is still reported", async (t) => {
  const d = dialog(t, {
    answers: [() => { d.modal.close(); return { decision: "left", revoked: true }; }],
  });

  d.modal.onOpen();
  await tick();
  d.button("Leave").click();
  await tick();

  assert.ok(d.notices.some((notice) => notice.includes("left the server")), "a done action is never silent");
  assert.equal(d.left(), 1);
});

test("an unpaired device is told there is nothing to leave, and nothing is asked", async (t) => {
  const d = dialog(t, { deviceId: null });

  d.modal.onOpen();
  await tick();

  assert.match(d.drawn.join("\n"), /not paired with a server, so there is nothing to leave/);
  d.button("Close");
  assert.deepEqual(d.choices, []);
  assert.equal(d.made.length, 1, "no button that could leave anything");
});

test("a server that does not recognise this device is named as such before the local leave (#143)", async (t) => {
  const d = dialog(t, {
    answers: [
      { decision: "refused", reason: "bad_signature", detail: "request signature does not verify" },
      { decision: "left", revoked: false },
    ],
  });

  d.modal.onOpen();
  await tick();
  d.button("Leave").click();
  await tick();

  const text = d.drawn.join("\n");
  assert.match(text, /This server does not recognise this device: it was rebuilt or restored from a backup/);
  assert.doesNotMatch(text, /can never sync again/, "not the last-device warning");
  d.button("Leave locally anyway").click();
  await tick();

  assert.deepEqual(d.choices.at(-1), { discardUnpushed: false, localOnly: true });
  assert.ok(d.notices.some((notice) => notice.includes("which did not recognise it")));
});


test("switching offers setup for an empty server without forcing a pairing code", async (t) => {
  const d = dialog(t, { mode: "switch", answers: [{ decision: "left", revoked: true }] });
  d.modal.onOpen();
  await tick();
  d.button("Leave and switch").click();
  await tick();
  d.made.find((component) => component.placeholder === "sync.example.org").change("new.example.org");
  d.button("Set up or recover").click();
  await tick();
  assert.ok(d.choices.includes("setServerUrl:new.example.org"));
  assert.deepEqual(d.opened, ["AccountSetupModal"]);
});


test("a last-device refusal focuses Cancel before the local-only leave action", async (t) => {
  const d = dialog(t, { answers: [{ decision: "refused", reason: "last_device", detail: "last active device" }] });
  d.modal.onOpen(); await tick();
  d.button("Leave").click(); await tick();
  assert.equal(d.made[0].text, "Cancel");
  d.button("Leave locally anyway");
});
