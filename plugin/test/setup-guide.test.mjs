/**
 * The setup guide is reachable from inside Obsidian, and it is only ever the
 * project's own page.
 *
 * A stranger installs the plugin before anything else works, so the guide has
 * to be one press away: a command, the first settings row, and the help link
 * Obsidian shows for the plugin. The address is a constant in the source, never
 * data from a server, and nothing is requested until the person asks.
 *
 * These drive the REAL plugin loaded from `build/main.js` inside the sandbox;
 * only `window.open` and the host registration calls are fakes.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { memorySecrets, sandbox } from "./fake.mjs";

const GUIDE = "https://snaraj.github.io/obsync/setup/";
const ROOT_MANIFEST = fileURLToPath(new URL("../../manifest.json", import.meta.url));

class Element {
  setText() {}
}

function load(t) {
  const box = sandbox();
  t.after(() => rmSync(box.home, { recursive: true }));
  const Plugin = box.require(join(box.home, "build/main.js")).default;
  const settings = box.require(join(box.home, "build/ui/settings.js"));
  const opened = [];
  const previous = globalThis.window;
  globalThis.window = { ...previous, open: (target, disposition) => opened.push(`${target} ${disposition}`) };
  t.after(() => { globalThis.window = previous; });
  return { Plugin, settings, opened };
}

test("the guide is the project's own page, over HTTPS", (t) => {
  const { settings } = load(t);
  assert.equal(settings.SETUP_GUIDE_URL, GUIDE);
});

test("opening the guide opens exactly that page in the browser and logs one decision", (t) => {
  const { Plugin, opened } = load(t);
  const logs = [];
  const instance = Object.create(Plugin.prototype);
  instance.log = (line) => logs.push(line);

  instance.openSetupGuide();

  assert.deepEqual(opened, [`${GUIDE} _blank`]);
  assert.deepEqual(logs, ["guide decision=opened"]);
});

test("the command palette offers the guide before the device is paired", async (t) => {
  const { Plugin, opened } = load(t);
  const plugin = new Plugin();
  const commands = [];
  plugin.loadData = async () => null;
  plugin.saveData = async () => {};
  plugin.addCommand = (command) => commands.push(command);
  plugin.addStatusBarItem = () => new Element();
  plugin.addSettingTab = () => {};
  plugin.registerEvent = () => {};
  plugin.registerObsidianProtocolHandler = () => {};
  plugin.log = () => {};
  plugin.app = { secretStorage: memorySecrets(), vault: { adapter: {}, on: () => ({}) }, workspace: { on: () => ({}), getLeavesOfType: () => [], onLayoutReady: (listed) => listed() } };
  plugin.manifest = { version: "1.1.1" };
  await plugin.onload();
  t.after(() => plugin.onunload());

  const command = commands.find((c) => c.id === "open-setup-guide");
  assert.equal(command?.name, "Open the setup guide");
  command.callback();
  assert.deepEqual(opened, [`${GUIDE} _blank`]);
});

test("Obsidian's help link for the plugin is the same guide", () => {
  assert.equal(JSON.parse(readFileSync(ROOT_MANIFEST, "utf8")).helpUrl, GUIDE);
});
