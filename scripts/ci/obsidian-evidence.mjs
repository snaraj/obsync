import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";

/** Read only comparison codes from visible pairing dialogs, never invitation fields. */
export function pairingCodes() {
  const shown = { creator: [], claimant: [] };
  for (const modal of document.querySelectorAll(".modal:not(.mod-settings)")) {
    const rect = modal.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const text = modal.textContent ?? "";
    for (const match of text.matchAll(/Approve only if the new device shows the code (\d{3} \d{3})\./g)) shown.creator.push(match[1]);
    for (const match of text.matchAll(/Waiting for approval on the other device\. Its prompt shows the code (\d{3} \d{3}):/g)) shown.claimant.push(match[1]);
  }
  return shown;
}

export function assertPairingCodes({ creator, claimant }) {
  if (creator.length !== 1 || claimant.length !== 1 || !/^\d{3} \d{3}$/.test(creator[0]) || creator[0] !== claimant[0]) {
    throw new Error("pairing comparison requires exactly one matching code on each device; approval refused");
  }
}

// Only reduced custody facts and a verified synthetic editor may leave a renderer.
// These functions run inside Obsidian; never return credential values.
export async function secretFacts(checkRevision = true, platform) {
  if (!["darwin", "win32", "linux"].includes(platform)) throw Error("native custody evidence requires a declared desktop platform");
  let raw;
  try { raw = app.loadLocalStorage("secrets-encrypted"); }
  catch { throw new Error("native custody diagnostics unavailable"); }
  let plain = false;
  try { plain = typeof raw === "string" && typeof JSON.parse(raw) === "object"; } catch {}
  let safe;
  try { safe = app.secretStorage?.adapter?.safeStorage; } catch {}
  const flag = value => typeof value === "boolean" ? value : null;
  let backend = "none reported", encrypted = null, outerEncrypted = null;
  try {
    const selected = platform === "linux" ? safe?.getSelectedStorageBackend?.() : undefined;
    if (selected !== undefined) backend = ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6", "basic_text", "unknown"].includes(selected)
      ? selected : "unrecognized";
  } catch { backend = "unavailable"; }
  try { encrypted = flag(safe?.isEncryptionAvailable?.()); } catch {}
  try { outerEncrypted = flag(app.secretStorage?.isEncryptionAvailable?.()); } catch {}
  const facts = { encrypted, outerEncrypted, backend, stored: typeof raw === "string" && raw.length > 0,
    plain, wrapped: false, plainRoot: null, revisionMatches: null, pinMatches: null, cleanupComplete: null };
  if (!checkRevision) return facts; // No plugin metadata or credential read during this observation.
  try {
    const plugin = app.plugins.plugins["obsync-private-sync"], metadata = await plugin.loadData();
    if (metadata.storageVersion !== 3 || metadata.credentialFormat !== "native-desktop-v1" ||
        metadata.credentialEnvelopeVersion !== 2 || !/^[0-9a-f]{32}$/.test(metadata.installationId) ||
        metadata.credentialRef !== `obsync-private-sync-v1-${metadata.installationId}-os`) throw Error();
    const oldRef = `obsync-private-sync-v1-${metadata.installationId}`;
    const stored = app.secretStorage.getSecret(metadata.credentialRef);
    const prefix = "obsync-native-custody-v1:";
    if (typeof stored !== "string" || !stored.startsWith(prefix)) throw Error();
    const text = stored.slice(prefix.length);
    if (!text || text.length > (16 << 20) * 2) throw Error();
    const { Buffer } = require("buffer");
    const bytes = Buffer.from(text, "base64");
    if (bytes.length > (16 << 20) || bytes.toString("base64") !== text) throw Error();
    const decoded = safe.decryptString(bytes);
    if (typeof decoded !== "string" || new TextEncoder().encode(decoded).length > (16 << 20)) throw Error();
    const envelope = JSON.parse(decoded), current = envelope.current, custody = envelope.custody;
    const state = plugin.state, pin = metadata.sealPin, accepted = state?.custody2();
    facts.wrapped = true;
    // Inspect only the two deterministic old owned references, never enumerate secrets.
    const retired = [app.secretStorage.getSecret(oldRef), app.secretStorage.getSecret(oldRef + "-claim")];
    const claim = app.secretStorage.getSecret(metadata.credentialRef + "-claim");
    facts.cleanupComplete = metadata.credentialCleanupPending === false && [...retired, claim].every(value => value === null || value === "");
    facts.plainRoot = [stored, ...retired, claim].some(value => typeof value === "string" && value !== "" && !value.startsWith(prefix));
    facts.revisionMatches = envelope.version === 2 && envelope.installationId === metadata.installationId &&
      Number.isSafeInteger(metadata.credentialRevision) && metadata.credentialRevision > 0 &&
      metadata.credentialRevision === current?.revision && metadata.serverUrl === current?.serverUrl &&
      metadata.deviceId === current?.deviceId;
    facts.pinMatches = /^[0-9a-f]{64}$/.test(current?.vrk) && /^[0-9a-f]{64}$/.test(current?.deviceSecret) &&
      /^[0-9a-f]{32}$/.test(current?.deviceId) && /^[0-9a-f]{32}$/.test(pin?.generation) &&
      pin?.suite === 2 && pin.phase === "active" && custody?.suite === 2 &&
      custody.phase === "active" && custody.enrollment === null && custody.rotation === null && custody.generation === pin.generation &&
      state.paired === true &&
      state.data.vrk === current?.vrk && state.data.deviceId === current?.deviceId &&
      state.data.deviceSecret === current?.deviceSecret && state.data.serverUrl === current?.serverUrl &&
      JSON.stringify(state.data.edgeHeaders) === JSON.stringify(current?.edgeHeaders) &&
      JSON.stringify(accepted) === JSON.stringify(custody);
    // If the host outer layer is JSON, its exact owned entry must still be our wrapped packet.
    if (plain && JSON.parse(raw)[metadata.credentialRef] !== stored) throw Error();
    return facts;
  } catch { throw new Error("native credential envelope could not be verified"); }
}

export function assertCustody(found, want) {
  if (!found.stored || !found.wrapped || found.plainRoot !== false || !found.revisionMatches ||
      !found.pinMatches || !found.cleanupComplete ||
      Object.entries(want).some(([key, value]) => found[key] !== value)) {
    throw new Error("credential custody does not match the required native-wrapped storage and revision");
  }
}

// Dedicated negative path only: before Trust, count actual native boundaries.
// No secret values, request headers or bodies are retained or exported.
export function installCustodyRefusalProbe(origin, injectUnavailable, platform) {
  let restore = () => {}, injected = false, stage = "platform";
  try {
    if (!["darwin", "win32", "linux"].includes(platform)) throw Error();
    stage = "activation";
    if (window.obsyncCustodyRefusal || app.plugins.plugins["obsync-private-sync"]) throw Error();
    stage = "interface";
    const vault = app.vault, secret = app.secretStorage, safe = secret.adapter?.safeStorage;
    if (vault?.configDir !== ".obsidian" || !safe || typeof safe.isEncryptionAvailable !== "function" || typeof safe.encryptString !== "function" ||
        typeof safe.decryptString !== "function" || typeof secret.setSecret !== "function" || typeof secret.getSecret !== "function" ||
        typeof vault?.writePluginData !== "function" || typeof window.fetch !== "function") throw Error();
    stage = "availability";
    let available = null, backend = "none reported";
    available = safe.isEncryptionAvailable();
    if (typeof available !== "boolean") throw Error();
    if (platform === "linux") backend = safe.getSelectedStorageBackend?.() ?? backend;
    if (injectUnavailable && (available !== true || (platform === "linux" &&
      !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend)))) throw Error();
    stage = "install";
    const original = { set: secret.setSecret, save: vault.writePluginData, fetch: window.fetch,
      availability: Object.getOwnPropertyDescriptor(safe, "isEncryptionAvailable") };
    const seen = { publicWrites: 0, metadataWrites: 0, transportRequests: 0 };
    const blob = app.loadLocalStorage("secrets-encrypted");
    restore = () => {
      secret.setSecret = original.set; vault.writePluginData = original.save; window.fetch = original.fetch;
      if (injected) {
        if (original.availability) Object.defineProperty(safe, "isEncryptionAvailable", original.availability);
        else delete safe.isEncryptionAvailable;
      }
      delete window.obsyncCustodyRefusal; return true;
    };
    const observeSet = function (...args) { seen.publicWrites++; return original.set.apply(this, args); };
    // Official Plugin.saveData dispatches to vault.writePluginData(manifest.dir, data, options).
    const observeSave = function (...args) {
      if (args[0] === ".obsidian/plugins/obsync-private-sync") seen.metadataWrites++;
      return original.save.apply(this, args);
    };
    const observeFetch = function (...args) {
      try { if (new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url).origin === origin) seen.transportRequests++; } catch {}
      return original.fetch.apply(this, args);
    };
    secret.setSecret = observeSet; vault.writePluginData = observeSave; window.fetch = observeFetch;
    if (secret.setSecret !== observeSet || vault.writePluginData !== observeSave || window.fetch !== observeFetch) throw Error();
    if (injectUnavailable) {
      Object.defineProperty(safe, "isEncryptionAvailable", { configurable: true, value: () => false }); injected = true;
    }
    window.obsyncCustodyRefusal = { seen, blob, available, backend, platform, injected: injectUnavailable, restore };
    return true;
  } catch { restore(); throw Error(`native custody observer installation refused: ${stage}`); }
}

export function custodyRefusalFacts() {
  const probe = window.obsyncCustodyRefusal;
  if (!probe) throw Error("custody refusal observer missing");
  const state = app.plugins.plugins["obsync-private-sync"]?.state;
  const visible = [...document.querySelectorAll(".notice")].some(node => node.textContent.includes(
    "cannot use operating-system encryption for this vault's sync credentials. Sync is stopped before enrollment or credential storage."));
  return { ...probe.seen, unavailable: probe.injected || probe.available !== true ||
    (probe.platform === "linux" && !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(probe.backend)), stateAbsent: state == null,
    rootAbsent: state?.data?.vrk == null && state?.custody2?.() == null &&
      ![...document.querySelectorAll(".modal pre")].some(node => node.textContent.trim().startsWith("obsync-recovery-v2 ")),
    blobUnchanged: app.loadLocalStorage("secrets-encrypted") === probe.blob, visible };
}

/** Synthetic source-origin negative evidence; not real-server or TLS acceptance. */
export async function verifyNativeCustodyRefusal(instance, trustLabel, click, until, injectUnavailable = false) {
  const sockets = new Set();
  let controls = 0, requests = 0, page, timer;
  const server = http.createServer((req, res) => {
    const control = req.url === "/__control" && req.method === "GET";
    if (control) controls++; else requests++;
    let received = 0;
    req.on("data", bytes => { received += bytes.length; if (received > 65536) req.destroy(); });
    req.resume();
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
    req.on("end", () => res.end('{"reachable":true}'));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setTimeout(3000, () => socket.destroy()); });
  const run = async (fn, ...args) => {
    try { return await Promise.race([page.run(fn, ...args), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("native custody evaluator exceeded 5000ms")), 5000);
    })]); } finally { clearTimeout(timer); }
  };
  const metadata = path.join(instance.vault, ".obsidian", "plugins", "obsync-private-sync", "data.json");
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(metadata, JSON.stringify({ serverUrl: origin }));
    const baseline = fs.readFileSync(metadata);
    page = await instance.main();
    await until("unavailable host workspace ready", () => run(() => !!(window.app && app.workspace?.layoutReady)));
    await until("unavailable host waits for Trust before activation", () => instance.anywhere(label =>
      [...document.querySelectorAll("button")].some(button => button.textContent.trim() === label), trustLabel));
    const reachable = await run(async origin => (await fetch(origin + "/__control", {
      credentials: "omit", signal: AbortSignal.timeout(3000) })).ok, origin);
    if (reachable !== true || controls !== 1) throw Error("custody negative fixture native reachability control failed");
    if (await run(installCustodyRefusalProbe, origin, injectUnavailable, process.platform) !== true) throw Error("custody observer was not installed");
    await until("unavailable host trusts the plugin", () => instance.anywhere(click, trustLabel));
    await until("visible pre-persistence custody refusal", async () =>
      instance.pluginLog().some(line => /state decision=stopped reason=desktop_custody_unavailable(?:\s|$)/.test(line)) &&
      (await run(custodyRefusalFacts)).visible);
    const facts = await run(custodyRefusalFacts);
    if (!facts.unavailable || !facts.visible || !facts.stateAbsent || !facts.rootAbsent || !facts.blobUnchanged ||
        facts.publicWrites !== 0 || facts.metadataWrites !== 0 || facts.transportRequests !== 0 ||
        requests !== 0 || !fs.readFileSync(metadata).equals(baseline)) {
      throw Error("custody unavailable refusal had side effects or lacked its required evidence");
    }
    return { refused: true, publicWrites: 0, metadataWrites: 0, transportRequests: 0,
      sourceRequests: 0, enrollments: 0, rootAbsent: true, nativeControl: true, injected: injectUnavailable };
  } finally {
    clearTimeout(timer);
    try {
      if (page && await run(() => window.obsyncCustodyRefusal ? window.obsyncCustodyRefusal.restore() : true) !== true) throw Error("custody observer cleanup refused");
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
}

/** macOS simultaneous only: actual false may prove refusal; this source is synthetic HTTP. */
export async function verifyConcurrentNativeCustody(a, b, trustLabel, click, until, platform) {
  if (platform !== "darwin") throw Error("concurrent custody requires actual macOS");
  const sockets = new Set(), peers = [];
  let controls = 0, requests = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__control") controls++; else requests++;
    let received = 0;
    req.on("data", bytes => { received += bytes.length; if (received > 65536) req.destroy(); }); req.resume();
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
    req.on("end", () => res.end('{"reachable":true}'));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.setTimeout(3000, () => socket.destroy()); });
  const run = async (peer, fn, ...args) => {
    let timer;
    try { return await Promise.race([peer.page.run(fn, ...args), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("concurrent custody evaluator exceeded 5000ms")), 5000);
    })]); } finally { clearTimeout(timer); }
  };
  const ref = `obsync-private-sync-v1-${"0".repeat(32)}-os`, marker = "obsync-native-counter-control";
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const instance of [a, b]) {
      const metadata = path.join(instance.vault, ".obsidian", "plugins", "obsync-private-sync", "data.json");
      const peer = { instance, metadata, original: fs.existsSync(metadata) ? fs.readFileSync(metadata) : null, page: null };
      peers.push(peer);
      fs.writeFileSync(metadata, JSON.stringify({ serverUrl: origin })); peer.baseline = fs.readFileSync(metadata);
      peer.page = await instance.main();
      await until("concurrent custody workspace ready", () => run(peer, () => !!(window.app && app.workspace?.layoutReady)));
      await until("concurrent custody waits for Trust", () => instance.anywhere(label =>
        [...document.querySelectorAll("button")].some(button => button.textContent.trim() === label), trustLabel));
      const reachable = await run(peer, async origin => (await fetch(origin + "/__control", {
        credentials: "omit", signal: AbortSignal.timeout(3000) })).ok, origin);
      if (reachable !== true || controls !== peers.length) throw Error("concurrent custody source reachability refused");
      if (await run(peer, installCustodyRefusalProbe, origin, false, platform) !== true) throw Error("concurrent custody observer not installed");
      peer.available = await run(peer, () => window.obsyncCustodyRefusal.available);
      if (typeof peer.available !== "boolean") throw Error("concurrent custody requires actual boolean availability");
    }
    const availability = peers.map(peer => peer.available);
    if (availability.every(value => value === true)) return { refused: false, availability };
    const snapshots = [];
    for (const peer of peers) {
      if (peer.available === false) {
        await until("actual unavailable peer trusts plugin", () => peer.instance.anywhere(click, trustLabel));
        await until("actual unavailable peer visibly refuses custody", async () =>
          peer.instance.pluginLog().some(line => /state decision=stopped reason=desktop_custody_unavailable(?:\s|$)/.test(line)) &&
          (await run(peer, custodyRefusalFacts)).visible);
      }
      const facts = await run(peer, custodyRefusalFacts);
      if ((peer.available === false && !facts.visible) || !facts.stateAbsent || !facts.rootAbsent ||
          !facts.blobUnchanged || facts.publicWrites !== 0 || facts.metadataWrites !== 0 || facts.transportRequests !== 0 ||
          requests !== 0 || !fs.readFileSync(peer.metadata).equals(peer.baseline)) throw Error("concurrent custody pre-control refusal evidence failed");
      snapshots.push({ unavailable: peer.available === false, publicWrites: 0, metadataWrites: 0, transportRequests: 0,
        rootAbsent: true, stateAbsent: true, blobUnchanged: true, metadataUnchanged: true });
    }
    // Intentional nonsecret controls happen AFTER the immutable zero-side-effect snapshot. Never reset counters.
    for (const peer of peers) {
      const empty = await run(peer, ref => {
        const value = app.secretStorage.getSecret(ref); return value === null || value === "";
      }, ref);
      if (empty !== true) throw Error("owned control reference occupied");
      peer.controlStarted = true;
      await run(peer, (ref, marker) => {
        app.secretStorage.setSecret(ref, marker);
        if (app.secretStorage.getSecret(ref) !== marker) throw Error("native public-write control refused");
      }, ref, marker);
      await run(peer, origin => app.vault.writePluginData(".obsidian/plugins/obsync-private-sync", {
        serverUrl: origin, obsyncNativeCounterControl: true,
      }), origin);
      if (JSON.parse(fs.readFileSync(peer.metadata, "utf8")).obsyncNativeCounterControl !== true) throw Error("native metadata control readback refused");
      const reachable = await run(peer, async origin => (await fetch(origin + "/__observer-control", {
        method: "POST", credentials: "omit", signal: AbortSignal.timeout(3000) })).ok, origin);
      const counts = await run(peer, () => ({ ...window.obsyncCustodyRefusal.seen }));
      if (reachable !== true || counts.publicWrites !== 1 || counts.metadataWrites !== 1 || counts.transportRequests !== 1 ||
          requests !== peers.indexOf(peer) + 1) throw Error("native observer positive control counts refused");
      await run(peer, async (ref, origin) => {
        app.secretStorage.setSecret(ref, "");
        if (app.secretStorage.getSecret(ref) != null && app.secretStorage.getSecret(ref) !== "") throw Error("native public control cleanup refused");
        await app.vault.writePluginData(".obsidian/plugins/obsync-private-sync", { serverUrl: origin });
      }, ref, origin);
      const after = await run(peer, () => ({ ...window.obsyncCustodyRefusal.seen }));
      const data = JSON.parse(fs.readFileSync(peer.metadata, "utf8"));
      if (after.publicWrites !== 2 || after.metadataWrites !== 2 || after.transportRequests !== 1 || requests !== peers.indexOf(peer) + 1 ||
          Object.keys(data).length !== 1 || data.serverUrl !== origin) throw Error("native observer control cleanup refused");
    }
    return { refused: true, availability, source: "synthetic-http", preControl: snapshots, sourceRequestsBeforeControls: 0,
      controls: { publicWritesPerPeer: 1, metadataWritesPerPeer: 1, sourceRequestsPerPeer: 1,
        cleanupPublicWritesPerPeer: 1, cleanupMetadataWritesPerPeer: 1 }, sourceRequestsAfterControls: requests };
  } finally {
    try {
      const restored = await Promise.allSettled(peers.map(async peer => {
        try {
          if (peer.page && await run(peer, started => {
            if (!window.obsyncCustodyRefusal) return true;
            let cleared = true;
            try {
              const control = `obsync-private-sync-v1-${"0".repeat(32)}-os`;
              if (started) {
                const value = app.secretStorage.getSecret(control);
                if (value === "obsync-native-counter-control") {
                  app.secretStorage.setSecret(control, "");
                  const remaining = app.secretStorage.getSecret(control);
                  if (remaining !== null && remaining !== "") cleared = false;
                } else if (value !== null && value !== "") cleared = false;
              }
            } catch { cleared = false; }
            const restored = window.obsyncCustodyRefusal.restore();
            return cleared && restored === true;
          }, peer.controlStarted === true) !== true) throw Error("concurrent custody observer restoration refused");
        } finally {
          if (peer.original === null) fs.rmSync(peer.metadata, { force: true }); else fs.writeFileSync(peer.metadata, peer.original);
        }
      }));
      if (restored.some(result => result.status !== "fulfilled")) throw Error("concurrent custody observer restoration refused");
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
}

// Capture the editor rectangle only. No settings, modal, recovery phrase,
// pairing code, notice, file list, profile path or other desktop surface.
export function editorBounds(file, text) {
  const visible = (node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  if ([...document.querySelectorAll(".modal-container, .notice-container .notice")].some(visible)) return null;
  const view = app.workspace.activeLeaf?.view;
  if (view?.file?.path !== file || view.editor?.getValue() !== text) return null;
  // Public openFile resolves before Obsidian's debounced word-count refresh.
  // These English ASCII fixtures must show their own character count, not
  // the previous note's. Waiting observes native UI; it never forces refresh.
  const footer = document.querySelector(".status-bar-item.plugin-word-count")?.textContent ?? "";
  if (!footer.endsWith(`words${text.length} characters`)) return null;
  const editor = view.containerEl.querySelector(".markdown-source-view");
  if (!editor || !visible(editor)) return null;
  const rect = editor.getBoundingClientRect();
  if (rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function captureEditor(instance, phase, file, text, output, until) {
  if (!output) return;
  const main = await instance.main();
  await main.send("Page.bringToFront");
  const clip = await until("only the expected synthetic editor visible", () => main.run(editorBounds, file, text));
  const disk = fs.readFileSync(path.join(instance.vault, file));
  if (!disk.equals(Buffer.from(text))) throw new Error("capture refused: independent disk differs from editor");
  const { data } = await main.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
  const after = await main.run(editorBounds, file, text);
  if (JSON.stringify(after) !== JSON.stringify(clip)
      || !fs.readFileSync(path.join(instance.vault, file)).equals(disk)) {
    throw new Error("capture refused: editor or disk changed during capture");
  }
  const png = Buffer.from(data, "base64");
  const name = `${phase}-${instance.name}`;
  fs.writeFileSync(path.join(output, `${name}.png`), png, { flag: "wx" });
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify({
    phase, peer: instance.name, platform: process.platform,
    source: process.env.GITHUB_SHA ?? "local", editorSha256: digest(Buffer.from(text)), diskSha256: digest(disk),
    pngSha256: digest(png), width: clip.width, height: clip.height,
  }) + "\n", { flag: "wx" });
}

export function finishEvidence(output, custody) {
  if (!["before", "quit", "paired", "transferred", "after"].every((key) => custody?.[key] === true)) {
    throw new Error("incomplete native restart and custody evidence");
  }
  const expected = ["cotype-a", "cotype-b", "restart-a-a", "restart-a-b", "restart-b-a", "restart-b-b"];
  const names = expected.flatMap((name) => [name + ".png", name + ".json"]).sort();
  if (JSON.stringify(fs.readdirSync(output).sort()) !== JSON.stringify(names)) {
    throw new Error("expected exactly six editor images and their receipts");
  }
  for (const name of expected) {
    const receipt = JSON.parse(fs.readFileSync(path.join(output, name + ".json"), "utf8"));
    if (receipt.editorSha256 !== receipt.diskSha256
        || receipt.pngSha256 !== digest(fs.readFileSync(path.join(output, name + ".png")))) {
      throw new Error("capture receipt does not match its editor, disk and image");
    }
  }
}
