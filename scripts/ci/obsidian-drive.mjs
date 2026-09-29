// obsidian-drive -- two REAL Obsidian desktop instances, driven over the Chrome
// DevTools Protocol, doing what a person does on day one: set up the first
// device, pair the second, and watch notes, a rename and folders cross.
//
// WHY. Every other end-to-end run drives the server with `api_flow.py`, a
// synthetic device. Nothing had run the PLUGIN inside the application it ships
// for, on anything but the owner's own macOS and iPhone: not Electron's network
// stack, not its certificate store, not its secret storage, not its file
// watcher. This does, on whatever operating system the harness launched it on
// (scripts/ci/obsidian-e2e.sh on Linux; the macOS and Windows legs of
// .github/workflows/generic-paths.yml).
//
// HOW IT DRIVES. Each instance starts with its own `--user-data-dir` and a
// `--remote-debugging-port`; this file speaks the DevTools protocol to it over
// Node's own WebSocket, with no package installed. Setup and pairing go
// through the plugin's SETTINGS AND DIALOGS, by the labels a person reads, so a
// renamed button fails here the way it would confuse a reader. Obsidian 1.13
// opens Settings -- and dialogs raised from it -- in windows of their own, so a
// control is looked for in every window the instance has open. Notes are made
// and renamed through Obsidian's own vault API, which is what the editor
// calls; what arrives is read off the OTHER instance's disk.
//
// SECRETS. The setup token is read from a file and the file deleted at once.
// The pairing code travels from one renderer to the other through this
// process's memory. The recovery phrase never leaves the renderer that shows
// it: the confirmation is typed back inside that window. None of the three is
// printed, and every line printed on failure is scrubbed of the first two.
//
// usage: node scripts/ci/obsidian-drive.mjs  (configuration in the environment)
//   OBSIDIAN_BIN           the Obsidian executable
//   OBSYNC_E2E_WORK        a scratch directory this run owns
//   OBSYNC_E2E_PLUGIN      the built plugin directory (main.js, manifest.json, styles.css)
//   OBSYNC_E2E_URL         the server URL devices are given, https://name:port
//   OBSYNC_E2E_TOKEN_FILE  a file holding the setup token; deleted once read
//   OBSYNC_E2E_ARGS        optional JSON array of extra Chromium switches
//   OBSYNC_E2E_HOMES       "1" to give each instance its own HOME (Linux: its own NSS store)
//   OBSYNC_E2E_NTFS        "1" to add the Windows filesystem journeys
//   OBSYNC_E2E_SECRET_STORE  "gnome-keyring" or "none" (Linux): what holds the keys; both
//                          instances are restarted after the journeys and must sync again
//   OBSYNC_E2E_LAUNCHER    optional command each instance is started through, the
//                          Obsidian executable as its first argument
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PLUGIN_ID = "obsync-private-sync";
const STEP_BUDGET_MS = 90_000;
const SYNC_BUDGET_MS = 120_000;
const started = Date.now();
let stepAt = started;
let proven = 0;
const secrets = [];

class Denied extends Error {}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Denied(`${name} is not set`);
  return value;
}

function scrub(text) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join("<redacted>");
  return out;
}

function prove(message) {
  const now = Date.now();
  proven += 1;
  console.log(`obsidian-drive: (${proven}) ${scrub(message)} [${((now - stepAt) / 1000).toFixed(1)}s]`);
  stepAt = now;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, probe, budget = STEP_BUDGET_MS) {
  const deadline = Date.now() + budget;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Denied(`${what} within ${budget / 1000}s${last ? `: ${last.message}` : ""}`);
}

/** One DevTools session with one window, its plugin log lines kept for failures. */
class Page {
  constructor(name, socket) {
    this.name = name;
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.console = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === "Runtime.consoleAPICalled") {
        const text = message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ");
        if (text.startsWith("obsync ")) this.console.push(text);
        if (this.console.length > 200) this.console.shift();
      }
    });
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("window closed"));
      this.pending.clear();
      this.closed = true;
    });
  }

  static async connect(name, target) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`${name}: DevTools socket refused`)), { once: true });
    });
    const page = new Page(name, socket);
    await page.send("Runtime.enable");
    return page;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("window closed"));
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Run `fn` in the window with JSON arguments; returns its (awaited) JSON value. */
  async run(fn, ...args) {
    const expression = `(${fn})(...${JSON.stringify(args)})`;
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

// ---- In-window helpers. Each runs inside one window with only its own
// `document`; labels are the ones the plugin shows, in one place so a renamed
// control is one edit here.

const LABELS = {
  trust: "Trust author and enable plugins",
  serverUrl: "Server URL",
  setupToken: "Setup token",
  setupButton: "Set up or recover",
  pairThis: "Pair this device",
  pairingCode: "Pairing code",
  pairButton: "Pair",
  approve: "Approve",
  phraseDone: "I have written it down",
  check: "Check",
  reached: "Reached your obsync server",
};

/** Type into the text field of the row called `name` in Settings or in a dialog, then leave it. */
function fillSetting(scope, name, value) {
  const root = scope === "dialog"
    ? [...document.querySelectorAll(".modal:not(.mod-settings)")].pop()
    : document.querySelector(".mod-settings .vertical-tab-content");
  if (!root) return false;
  const row = [...root.querySelectorAll(".setting-item")].find(
    (item) => item.querySelector(".setting-item-name")?.textContent.trim() === name,
  );
  const input = row?.querySelector("input, textarea");
  if (!input) return false;
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
  return true;
}

/** Type into a Settings field found by its placeholder (the setup token's row names the section, not the field). */
function fillPlaceholder(placeholder, value) {
  const input = document.querySelector(`.mod-settings .vertical-tab-content input[placeholder="${placeholder}"]`);
  if (!input) return false;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/** Click the visible, enabled button labelled exactly `label`. */
function click(label) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === label && !b.disabled && b.offsetParent !== null,
  );
  if (!button) return false;
  button.click();
  return true;
}

/** Settings is open on a tab carrying `row`. */
function settingsShow(row) {
  return [...document.querySelectorAll(".mod-settings .setting-item-name")].some((e) => e.textContent.trim() === row);
}

/** The recovery-phrase dialog: read the words HERE, type back the ones asked. */
function confirmPhrase(doneLabel) {
  const modal = [...document.querySelectorAll(".modal")].find((m) => m.querySelector(".obsync-phrase"));
  if (!modal) return false;
  const words = [...modal.querySelectorAll(".obsync-phrase li")].map((li) => li.textContent.trim());
  if (words.length !== 24) return false;
  for (const row of modal.querySelectorAll(".setting-item")) {
    const asked = /^Word (\d+)$/.exec(row.querySelector(".setting-item-name")?.textContent.trim() ?? "");
    const input = row.querySelector("input");
    if (!asked || !input) continue;
    input.value = words[Number(asked[1]) - 1];
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const done = [...modal.querySelectorAll("button")].find((b) => b.textContent.trim() === doneLabel);
  if (!done) return false;
  done.click();
  return true;
}

function pairingCode() {
  return document.querySelector(".modal pre.obsync-code")?.textContent.trim() || null;
}

function notices() {
  return [...document.querySelectorAll(".notice")].map((n) => n.textContent.trim());
}

/**
 * What Obsidian's secret storage did with the keys, read in the vault window:
 * whether it could encrypt, with which backend, and whether the one stored
 * entry is readable as plain JSON. Values never leave the window; only these
 * facts do.
 */
function secretStore() {
  const raw = app.loadLocalStorage("secrets-encrypted");
  let plain = false;
  try {
    plain = typeof raw === "string" && typeof JSON.parse(raw) === "object";
  } catch {
    plain = false;
  }
  return {
    encrypted: app.secretStorage.isEncryptionAvailable(),
    backend: app.secretStorage.adapter?.getSelectedStorageBackend?.() ?? "none reported",
    stored: typeof raw === "string" && raw.length > 0,
    plain,
  };
}

/** What is on screen, by label only: never an input's value, never the phrase or the code. */
function describe() {
  const pick = (root) => root && {
    title: root.querySelector(".modal-title")?.textContent.trim() ?? "",
    rows: [...root.querySelectorAll(".setting-item-name")].map((e) => e.textContent.trim()).slice(0, 30),
    buttons: [...root.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 30),
  };
  return {
    title: document.title,
    dialog: pick([...document.querySelectorAll(".modal:not(.mod-settings)")].pop()),
    settings: pick(document.querySelector(".mod-settings .vertical-tab-content")),
  };
}

// ---- In-main-window helpers: these use Obsidian's `app`, which only the vault
// window's global carries.

function pluginState(pluginId) {
  const plugin = app.plugins.plugins[pluginId];
  if (!plugin?.state) return null;
  return { paired: plugin.state.paired, server: plugin.state.data.serverUrl };
}

function openSettings(pluginId) {
  app.setting.open();
  app.setting.openTabById(pluginId);
  return true;
}

// ---- The instances.

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

class Instance {
  constructor(work, name, pluginDir) {
    this.name = name;
    this.root = path.join(work, name);
    this.data = path.join(this.root, "data");
    this.vault = path.join(this.root, `vault-${name}`);
    this.home = path.join(this.root, "home");
    this.pages = new Map();
    fs.mkdirSync(this.home, { recursive: true });
    const plugin = path.join(this.vault, ".obsidian", "plugins", PLUGIN_ID);
    fs.mkdirSync(plugin, { recursive: true });
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      fs.copyFileSync(path.join(pluginDir, file), path.join(plugin, file));
    }
    writeJson(path.join(this.vault, ".obsidian", "community-plugins.json"), [PLUGIN_ID]);
    // The vault list Obsidian keeps in its user-data directory: this vault,
    // open, so the instance starts in it rather than in the vault chooser.
    writeJson(path.join(this.data, "obsidian.json"), {
      vaults: { [randomBytes(8).toString("hex")]: { path: this.vault, ts: Date.now(), open: true } },
      updateDisabled: true,
    });
  }

  launch(binary, port, extra, homes) {
    const log = fs.openSync(path.join(this.root, "obsidian.log"), "a");
    const environment = { ...process.env };
    if (homes) environment.HOME = this.home;
    this.port = port;
    const launcher = process.env.OBSYNC_E2E_LAUNCHER;
    const argv = [`--user-data-dir=${this.data}`, `--remote-debugging-port=${port}`, ...extra];
    this.child = spawn(launcher || binary, launcher ? [binary, ...argv] : argv, {
      env: environment,
      stdio: ["ignore", log, log],
      detached: process.platform !== "win32",
    });
    this.child.on("error", (error) => console.error(`obsidian-drive: ${this.name} failed to start: ${error.message}`));
  }

  async targets() {
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
    return list.filter((t) => t.type === "page");
  }

  async page(target) {
    let page = this.pages.get(target.id);
    if (!page || page.closed) {
      page = await Page.connect(`${this.name}:${target.title}`, target);
      this.pages.set(target.id, page);
    }
    return page;
  }

  /** The vault window, where `app` lives. */
  async main() {
    const target = await until(`${this.name}: a vault window on the DevTools port`, async () =>
      (await this.targets()).find((t) => t.url.startsWith("app://obsidian.md/index.html")));
    return this.page(target);
  }

  /** Run a DOM helper in every open window; the first truthy answer wins. */
  async anywhere(fn, ...args) {
    for (const target of await this.targets()) {
      try {
        const value = await (await this.page(target)).run(fn, ...args);
        if (value) return value;
      } catch {
        // A window that closed between the listing and the call has nothing to offer.
      }
    }
    return null;
  }

  async all(fn) {
    const out = [];
    for (const target of await this.targets().catch(() => [])) {
      try {
        out.push(await (await this.page(target)).run(fn));
      } catch {
        // as above
      }
    }
    return out;
  }

  pluginLog() {
    return [...this.pages.values()].flatMap((page) => page.console);
  }

  /**
   * Quit as a person does, through Electron's own `app.quit()`, and wait until
   * the process has gone, so a relaunch on the same directories cannot meet
   * it. A signal to the whole process group is nearer a crash than a
   * restart, and a restart is what this proves.
   */
  async halt() {
    const child = this.child;
    const main = await this.main();
    await main.run(() => { setTimeout(() => window.electron.remote.app.quit(), 0); return true; });
    await until(`${this.name}: Obsidian quit`, () => child.exitCode !== null || child.signalCode !== null, 30_000);
    for (const page of this.pages.values()) page.close();
    this.pages.clear();
  }

  stop() {
    for (const page of this.pages.values()) page.close();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
}

async function openVault(instance) {
  const main = await instance.main();
  await until(`${instance.name}: Obsidian's workspace ready`, () =>
    main.run(() => !!(window.app && app.workspace && app.workspace.layoutReady)));
  // A vault that lists a community plugin opens in Restricted Mode and asks
  // whether to trust its author: the answer a person gives is the button.
  await until(`${instance.name}: ${LABELS.trust}`, () => instance.anywhere(click, LABELS.trust));
  await until(`${instance.name}: the plugin loaded`, () => main.run(pluginState, PLUGIN_ID));
  // The user agent carries both: `… obsidian/1.13.7 … Electron/43.3.0 …`.
  const agent = await main.run(() => navigator.userAgent);
  return {
    obsidian: /obsidian\/([\d.]+)/i.exec(agent)?.[1] ?? "unknown",
    electron: /Electron\/([\d.]+)/.exec(agent)?.[1] ?? "unknown",
  };
}

async function setServer(instance, url) {
  const main = await instance.main();
  await main.run(openSettings, PLUGIN_ID);
  await until(`${instance.name}: this plugin's settings`, () => instance.anywhere(settingsShow, LABELS.serverUrl));
  await until(`${instance.name}: the ${LABELS.serverUrl} field`, () =>
    instance.anywhere(fillSetting, "settings", LABELS.serverUrl, url));
  // The plugin stores the normalised address (a default port dropped), so the
  // comparison is by origin.
  await until(`${instance.name}: the server URL adopted`, async () => {
    const server = (await main.run(pluginState, PLUGIN_ID))?.server;
    return !!server && new URL(server).origin === new URL(url).origin;
  });
}

async function paired(instance) {
  const main = await instance.main();
  return (await main.run(pluginState, PLUGIN_ID))?.paired;
}

async function inVault(instance, fn, ...args) {
  return (await instance.main()).run(fn, ...args);
}

// ---- Files, read off each instance's own disk.

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function arrives(instance, relative, bytes, what) {
  const file = path.join(instance.vault, relative);
  const at = Date.now();
  await until(`${what}: ${relative} on ${instance.name}'s disk`, () =>
    fs.existsSync(file) && digest(fs.readFileSync(file)) === digest(bytes), SYNC_BUDGET_MS);
  return Date.now() - at;
}

async function leaves(instance, relative, what) {
  const file = path.join(instance.vault, relative);
  await until(`${what}: ${relative} gone from ${instance.name}'s disk`, () => !fs.existsSync(file), SYNC_BUDGET_MS);
}

function listing(instance, relative) {
  return fs.readdirSync(path.join(instance.vault, relative)).sort();
}

async function main() {
  const binary = env("OBSIDIAN_BIN");
  const work = env("OBSYNC_E2E_WORK");
  const pluginDir = env("OBSYNC_E2E_PLUGIN");
  const url = env("OBSYNC_E2E_URL");
  const tokenFile = env("OBSYNC_E2E_TOKEN_FILE");
  const extra = JSON.parse(process.env.OBSYNC_E2E_ARGS || "[]");
  const homes = process.env.OBSYNC_E2E_HOMES === "1";
  const ntfs = process.env.OBSYNC_E2E_NTFS === "1";
  const store = process.env.OBSYNC_E2E_SECRET_STORE || "";
  if (store && !STORES[store]) throw new Denied(`OBSYNC_E2E_SECRET_STORE must be one of ${Object.keys(STORES)}, not ${store}`);
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  fs.rmSync(tokenFile, { force: true });
  secrets.push(token);
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Denied("the setup token file does not hold 64 lowercase hex characters");
  console.log(`obsidian-drive: START binary=${binary} url=${url} platform=${process.platform} homes=${homes} ntfs=${ntfs}`);

  const a = new Instance(work, "a", pluginDir);
  const b = new Instance(work, "b", pluginDir);
  try {
    a.launch(binary, 19222, extra, homes);
    b.launch(binary, 19223, extra, homes);
    const [version] = await Promise.all([openVault(a), openVault(b)]);
    prove(`two instances: Obsidian ${version.obsidian} on Electron ${version.electron}, own user-data directories, the vault trusted and the plugin loaded in each`);

    // First device: server, token, the fresh vault key, the phrase confirmed.
    await setServer(a, url);
    await until("a: the setup token field", () => a.anywhere(fillPlaceholder, LABELS.setupToken, token));
    await until(`a: ${LABELS.setupButton}`, () => a.anywhere(click, LABELS.setupButton));
    await until("a: the recovery phrase confirmed", () => a.anywhere(confirmPhrase, LABELS.phraseDone));
    await until("a: paired after setup", () => paired(a));
    prove("first device: Server URL, setup token and the recovery-phrase check, through the plugin's own settings and dialog");

    // Second device: claim with the code the first one shows, then approve.
    await setServer(b, url);
    await until(`b: ${LABELS.pairThis}`, () => b.anywhere(click, LABELS.pairThis));
    await inVault(a, (id) => app.commands.executeCommandById(`${id}:pair-device`), PLUGIN_ID);
    const code = await until("a: a pairing code on screen", () => a.anywhere(pairingCode));
    secrets.push(code);
    await until(`b: the ${LABELS.pairingCode} field`, () => b.anywhere(fillSetting, "dialog", LABELS.pairingCode, code));
    await until(`b: ${LABELS.pairButton}`, () => b.anywhere(click, LABELS.pairButton));
    await until(`a: ${LABELS.approve} for the new device`, () => a.anywhere(click, LABELS.approve));
    await until("b: paired after approval", () => paired(b));
    prove("second device: the code shown on the first, typed into the second, approved on the first");

    // Two-way notes, a rename, folders.
    const first = `e2e note ${randomBytes(6).toString("hex")}\n`;
    await inVault(a, async (text) => {
      await app.vault.createFolder("e2e").catch(() => {});
      await app.vault.create("e2e/first.md", text);
    }, first);
    let ms = await arrives(b, "e2e/first.md", Buffer.from(first), "a note from the first device");
    prove(`a note made on the first device is on the second's disk, byte for byte, ${ms} ms after it was written`);

    const second = `reply ${randomBytes(6).toString("hex")}\n`;
    await inVault(b, async (text) => { await app.vault.create("e2e/from-b.md", text); return true; }, second);
    ms = await arrives(a, "e2e/from-b.md", Buffer.from(second), "a note from the second device");
    prove(`a note made on the second device is on the first's disk, ${ms} ms after it was written`);

    await inVault(b, () => app.fileManager.renameFile(app.vault.getAbstractFileByPath("e2e/first.md"), "e2e/renamed.md"));
    await arrives(a, "e2e/renamed.md", Buffer.from(first), "a rename");
    await leaves(a, "e2e/first.md", "a rename");
    prove("a rename on the second device is a rename on the first: the new name with the same bytes, the old name gone");

    const nested = `nested ${randomBytes(6).toString("hex")}\n`;
    await inVault(a, async (text) => {
      await app.vault.createFolder("e2e/folder/deeper");
      await app.vault.create("e2e/folder/deeper/inside.md", text);
      await app.vault.createFolder("e2e/empty");
    }, nested);
    await arrives(b, "e2e/folder/deeper/inside.md", Buffer.from(nested), "a nested folder");
    await until("an empty folder on the second device", () => fs.existsSync(path.join(b.vault, "e2e/empty")), SYNC_BUDGET_MS);
    if (listing(b, "e2e/empty").length !== 0) throw new Denied("the empty folder arrived with something in it");
    prove("folders: a nested folder with a note and an EMPTY folder both appear on the second device");

    // B2, measured where the user feels it: an edit written into the first
    // vault, until the second vault's file holds it. Obsidian's own editor
    // save delay comes before this and is not the plugin's.
    const rounds = Number(process.env.OBSYNC_E2E_B2_ROUNDS || 10);
    const latencies = [];
    for (let round = 0; round < rounds; round += 1) {
      const edit = `edit ${round} ${randomBytes(6).toString("hex")}\n`;
      const at = Date.now();
      await inVault(a, (body) => app.vault.modify(app.vault.getAbstractFileByPath("e2e/renamed.md"), body), edit);
      await arrives(b, "e2e/renamed.md", Buffer.from(edit), `edit ${round}`);
      latencies.push(Date.now() - at);
    }
    const sorted = [...latencies].sort((x, y) => x - y);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    prove(`B2 end to end: ${rounds} edits written on the first device reached the second's disk, p50 ${pick(0.5)} ms, p95 ${pick(0.95)} ms, max ${sorted.at(-1)} ms`);

    if (ntfs) await windowsJourneys(a, b);
    if (store) await restarted(a, b, { binary, extra, homes, store });
    if (homes) await untrusted(work, pluginDir, binary, extra, url);
    console.log(`obsidian-drive: SUMMARY steps=${proven} duration=${((Date.now() - started) / 1000).toFixed(1)}s decision=pass`);
  } catch (error) {
    console.error(`obsidian-drive: DENY ${scrub(error.message)}`);
    for (const instance of [a, b]) {
      const log = path.join(instance.root, "obsidian.log");
      const tail = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").slice(-25) : [];
      for (const line of tail) if (line.trim()) console.error(`obsidian-drive: ${instance.name} stdio: ${scrub(line)}`);
      for (const screen of await instance.all(describe)) {
        console.error(`obsidian-drive: ${instance.name} window: ${scrub(JSON.stringify(screen))}`);
      }
      for (const seen of await instance.all(notices)) {
        for (const line of seen) console.error(`obsidian-drive: ${instance.name} notice: ${scrub(line)}`);
      }
      for (const line of instance.pluginLog().slice(-40)) console.error(`obsidian-drive: ${instance.name} ${scrub(line)}`);
    }
    console.error(`obsidian-drive: SUMMARY steps=${proven} duration=${((Date.now() - started) / 1000).toFixed(1)}s decision=deny`);
    process.exitCode = 1;
  } finally {
    a.stop();
    b.stop();
  }
}

/**
 * The two Linux cases the docs name for where the keys are kept (#217): what
 * Obsidian's secret storage must report in each, and a warning it must not
 * show. The warning Obsidian 1.13 raises when it cannot encrypt is recorded,
 * never assumed, in the case without a keyring.
 */
const STORES = {
  "gnome-keyring": { encrypted: true, backend: "gnome_libsecret", plain: false },
  none: { encrypted: false, plain: true },
};
const UNENCRYPTED = "Secrets are stored without encryption";

function holds(instance, found, store, when) {
  const want = STORES[store];
  const wrong = Object.entries(want).filter(([key, value]) => found[key] !== value);
  if (!found.stored || wrong.length) {
    throw new Denied(`${instance.name} ${when}: Obsidian's secret storage reports ${JSON.stringify(found)}, `
      + `and with ${store} it must report ${JSON.stringify({ stored: true, ...want })}`);
  }
}

/**
 * The keys, across a restart: both instances stopped and started again on the
 * same directories must come back paired from what their secret storage kept,
 * and a note must still cross, which needs the vault key and the device
 * secret both.
 */
async function restarted(a, b, { binary, extra, homes, store }) {
  for (const instance of [a, b]) holds(instance, await inVault(instance, secretStore), store, "before the restart");
  await Promise.all([a.halt(), b.halt()]);
  a.launch(binary, 19222, extra, homes);
  b.launch(binary, 19223, extra, homes);
  await Promise.all([reopen(a), reopen(b)]);
  await until("a: paired again, from its secret storage", () => paired(a));
  await until("b: paired again, from its secret storage", () => paired(b));
  const text = `after the restart ${randomBytes(6).toString("hex")}\n`;
  await inVault(b, async (body) => { await app.vault.create("e2e/after-restart.md", body); return true; }, text);
  const ms = await arrives(a, "e2e/after-restart.md", Buffer.from(text), "a note after the restart");
  const [found] = await Promise.all([a, b].map(async (instance) => {
    const seen = await inVault(instance, secretStore);
    holds(instance, seen, store, "after the restart");
    return seen;
  }));
  const warned = [...(await a.all(notices)), ...(await b.all(notices))].flat().filter((line) => line.startsWith(UNENCRYPTED));
  if (store === "gnome-keyring" && warned.length) {
    throw new Denied(`with an unlocked keyring Obsidian still says "${warned[0]}"`);
  }
  prove(`the keys with ${store}: backend ${found.backend}, encrypted=${found.encrypted}, stored as plain JSON=${found.plain}; `
    + `both instances restarted, paired again from their secret storage, and a note crossed in ${ms} ms; `
    + `after the restart Obsidian ${warned.length ? `says "${warned[0]}" (${warned.length} windows)` : "shows no warning about it"}`);
}

/** A relaunched instance: the vault opens where it was, and the plugin loads from what it kept. */
async function reopen(instance) {
  const main = await instance.main();
  await until(`${instance.name}: Obsidian's workspace ready again`, () =>
    main.run(() => !!(window.app && app.workspace && app.workspace.layoutReady)));
  await until(`${instance.name}: the plugin loaded again`, async () => {
    await instance.anywhere(click, LABELS.trust);
    return main.run(pluginState, PLUGIN_ID);
  });
}

/**
 * The negative control for trust: a third instance whose HOME holds no NSS
 * database. Everything else is identical, so if it reached the server the two
 * above would prove nothing about the certificate store; it must be refused,
 * and the words it shows are recorded, because they are what a Linux user
 * who trusted the authority in the wrong place reads.
 */
async function untrusted(work, pluginDir, binary, extra, url) {
  const c = new Instance(work, "c", pluginDir);
  try {
    c.launch(binary, 19224, extra, true);
    await openVault(c);
    await setServer(c, url);
    await until(`c: ${LABELS.check}`, () => c.anywhere(click, LABELS.check));
    const shown = await until("c: an answer to Check", async () => {
      const lines = (await c.all(notices)).flat().filter((line) => line.trim() !== "");
      return lines.length ? lines : null;
    }, 180_000);
    if (shown.some((line) => line.startsWith(LABELS.reached))) {
      throw new Denied("an instance that trusts no authority reached the server: the trust above proves nothing");
    }
    prove(`untrusted: an instance with no NSS entry is refused; it shows "${shown.join(" / ")}"`);
  } finally {
    c.stop();
  }
}

/** The NTFS journeys the review names: a case-only rename, the trash, a locked file. */
async function windowsJourneys(a, b) {
  const text = `case ${randomBytes(6).toString("hex")}\n`;
  await inVault(a, async (body) => { await app.vault.create("e2e/Case Note.md", body); return true; }, text);
  await arrives(b, "e2e/Case Note.md", Buffer.from(text), "a note for the case-only rename");
  await inVault(a, () => app.fileManager.renameFile(app.vault.getAbstractFileByPath("e2e/Case Note.md"), "e2e/case note.md"));
  await until("the case-only rename on the second device", () => listing(b, "e2e").includes("case note.md")
    && !listing(b, "e2e").includes("Case Note.md"), SYNC_BUDGET_MS);
  prove("NTFS: a rename by capitalisation alone arrives as that rename, one file under the new spelling");

  await inVault(a, () => app.vault.trash(app.vault.getAbstractFileByPath("e2e/from-b.md"), false));
  await leaves(b, "e2e/from-b.md", "a note moved to the trash");
  prove("NTFS: a note moved to Obsidian's trash on one device is removed on the other");

  // A file another process holds open with no sharing: an editor, a backup
  // tool or a virus scanner does this on Windows, and a rename or a write
  // under it fails until it lets go. The edit must arrive once it does.
  const locked = path.join(b.vault, "e2e", "renamed.md");
  const holder = spawn("powershell", ["-NoProfile", "-Command",
    `$f=[System.IO.File]::Open('${locked}','Open','Read','None'); Start-Sleep -Seconds 20; $f.Close()`], { stdio: "ignore" });
  await sleep(2000);
  const edit = `edited while locked ${randomBytes(6).toString("hex")}\n`;
  await inVault(a, (body) => app.vault.modify(app.vault.getAbstractFileByPath("e2e/renamed.md"), body), edit);
  const ms = await arrives(b, "e2e/renamed.md", Buffer.from(edit), "an edit to a file another process held open");
  await new Promise((resolve) => (holder.exitCode !== null ? resolve() : holder.on("exit", resolve)));
  prove(`NTFS: an edit to a note another process held open arrived ${ms} ms after the edit, once the lock was let go, nothing lost`);
}

main().catch((error) => {
  console.error(`obsidian-drive: DENY ${scrub(error.message)}`);
  process.exitCode = 1;
});
