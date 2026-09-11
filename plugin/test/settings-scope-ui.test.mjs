import { strict as assert } from "node:assert";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sandbox } from "./fake.mjs";

for (const failure of [false, true]) test(`native scope Save ${failure ? "failure" : "success"} settles without assimilating the host button`, async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const obsidian = box.require("obsidian");
  const buttons = [];
  class Component {
    thenCalls = 0;
    then(callback) {
      this.thenCalls++;
      // Native BaseComponent.then resolves with itself. This bounded cutoff
      // is a test safety guard: a regression fails without starving Node.
      callback(this.thenCalls <= 3 ? this : undefined);
      return this;
    }
    setDisabled(value) { this.disabled = value; return this; }
    setButtonText(value) { this.text = value; return this; }
    setValue() { return this; }
    setPlaceholder() { return this; }
    addOption() { return this; }
    onChange() { return this; }
    onClick(fn) { this.click = fn; return this; }
  }
  Object.assign(obsidian.Setting.prototype, {
    setName() { return this; }, setDesc() { return this; }, setHeading() { return this; },
    addDropdown(fn) { fn(new Component()); return this; },
    addTextArea(fn) { fn(new Component()); return this; },
    addButton(fn) { const button = new Component(); buttons.push(button); fn(button); return this; },
  });
  let final;
  class ObservedPromise extends Promise {
    finally(callback) { final = super.finally(callback); return final; }
  }
  let saves = 0, displays = 0;
  const plugin = { state: { data: { syncFolders: ["Notes"] } }, saveSyncFolders: (folders) => {
    saves++;
    assert.deepEqual(folders, ["Notes"]);
    return failure ? ObservedPromise.reject(new Error("SAVE FAILURE SENTINEL")) : ObservedPromise.resolve();
  } };
  const { ObsyncSettingTab } = box.require(join(box.home, "build/ui/settings.js"));
  const tab = new ObsyncSettingTab({}, plugin);
  tab.display = () => { displays++; };
  tab.scope({});
  const button = buttons.find((b) => b.text === "Save on this device");
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(button.text, "Waiting for transfers…");
  assert.ok(final instanceof Promise);
  await final;
  await new Promise(setImmediate);
  assert.equal(button.thenCalls, 0, "a Promise continuation returned a native thenable component");
  assert.equal(button.disabled, false);
  assert.equal(button.text, "Save on this device");
  assert.equal(saves, 1);
  assert.equal(displays, failure ? 0 : 1);
  assert.deepEqual(obsidian.notices, [failure ? "SAVE FAILURE SENTINEL" : "obsync: folder selection saved on this device."]);
});
