import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

async function prompt(t) {
  const box = sandbox(); t.after(() => rmSync(box.home, { recursive: true, force: true }));
  const obsidian = box.require("obsidian"), buttons = [], messages = [];
  obsidian.Setting.prototype.addButton = function (build) {
    const button = { setButtonText(text) { this.text = text; return this; }, setCta() { return this; }, onClick(fn) { this.click = fn; return this; } };
    build(button); buttons.push(button); return this;
  };
  const { PairCreateModal } = box.require(join(box.home, "build/ui/modals.js"));
  const pairing = box.require(join(box.home, "build/pairing.js"));
  const modal = new PairCreateModal({}, {});
  modal.contentEl = { empty() {} };
  const secret = pairing.newPairingSecret(), id = "ab".repeat(16);
  const claimant = { name: "Phone", platform: "ios", app_version: "1.1.3",
    vault: await pairing.sealPairingVault(secret, id, { name: "Plans <2026>", notes: 7 }) };
  return { modal, secret, id, claimant, buttons, messages, status: { setText: text => messages.push(text) } };
}

test("approval names the decrypted vault and note count before showing its controls (#141)", async t => {
  const r = await prompt(t);
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  assert.match(r.messages[0], /Plans <2026>.*7 notes/);
  assert.deepEqual(r.buttons.map(b => b.text), ["Approve", "Reject"]);
});

test("an old server's absent vault details keep the legacy approval prompt (#141)", async t => {
  const r = await prompt(t); delete r.claimant.vault;
  await r.modal.approve(r.id, r.secret, r.claimant, r.status);
  assert.match(r.messages[0], /Phone.*ios/);
  assert.ok(!r.messages[0].includes("vault"));
  assert.equal(r.buttons.length, 2);
});

test("unauthentic vault details never offer an approval button (#141)", async t => {
  const r = await prompt(t); r.secret[0] ^= 1;
  await assert.rejects(() => r.modal.approve(r.id, r.secret, r.claimant, r.status));
  assert.equal(r.buttons.length, 0); assert.equal(r.messages.length, 0);
});

test("closing while vault details decrypt cannot recreate approval controls (#141)", async t => {
  const r = await prompt(t);
  const work = r.modal.approve(r.id, r.secret, r.claimant, r.status);
  r.modal.onClose(); await work;
  assert.equal(r.buttons.length, 0); assert.equal(r.messages.length, 0);
});
