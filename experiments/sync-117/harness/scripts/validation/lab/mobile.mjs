// Disposable Android emulator rehearsal; never physical-phone acceptance.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { manifest, connect, sleep, targets } from './cdp.mjs';
import { click, fillSetting, pairingCode, LABELS } from '../../ci/obsidian-drive.mjs';
const [run, androidRun, command, androidVault = '/storage/emulated/0/Documents/Obsync-Lab-Android'] = process.argv.slice(2);
const state = manifest(run), android = manifest(androidRun);
const emulator = android.processes.emulator;
const serial = `emulator-${emulator.argv[emulator.argv.indexOf('-port') + 1]}`;
const adb = join(android.run, 'sdk/platform-tools/adb');
const adbPort = +(android.processes.adb.argv[android.processes.adb.argv.indexOf('-L') + 1].split(':').at(-1));
function shell(...args) { return execFileSync(adb, ['-P', String(adbPort), '-s', serial, ...args], { encoding: 'utf8' }).trim(); }
let forward;
const clients = [];
function record(label, value) {
  const result = { ...value, platform: 'Android emulator', physicalPhone: 'NOT_RUN' };
  writeFileSync(join(state.run, 'evidence', `${label}-${Date.now()}.json`), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
}
async function mobile() {
  const appPid = +shell('shell', 'pidof', 'md.obsidian');
  if (!Number.isInteger(appPid) || appPid <= 1) throw Error('owned Android app absent');
  forward = +shell('forward', 'tcp:0', `localabstract:webview_devtools_remote_${appPid}`);
  state.devices.M = { android: true, adb, adbPort, serial, appPid, port: forward,
    vault: androidVault };
  state.processes.M = emulator;
}
async function client(name) { const c = await connect(state, name); clients.push(c); return c; }
async function read(name, body, params = {}) { const c = await client(name); try { return await c.evaluate(body, params); } finally { c.close(); } }
async function until(fn, stage, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(250); }
  throw Error(`${stage} deadline`);
}
async function ui(name, fn, ...args) {
  for (const target of await targets(state, name)) {
    const c = await connect(state, name, false, target.id); clients.push(c);
    try { const result = await c.evaluate(`return (${fn.toString()})(...P.args);`, { args }, false); if (result) return result; }
    finally { c.close(); }
  }
  return false;
}
function matchCode() {
  return /the code ([0-9]{3} [0-9]{3})/.exec([...document.querySelectorAll('.modal:not(.mod-settings)')].map(e => e.textContent).join(' '))?.[1] ?? null;
}
async function progress(name) {
  return await read(name, `const p = app.plugins.plugins['obsync-private-sync'], status = p.currentStatus(); return { paired: p.state.paired, files: Object.keys(p.state.data.files).length, notes: Object.keys(p.state.data.files).filter(p => p.endsWith('.md')).length, status: status.kind, pending: status.pending, checking: status.checking, lastSeq: p.state.data.lastSeq, dropped: Object.keys(p.state.data.dropped).length };`);
}
async function bytes(name, path, expected) {
  if (name === 'A') { try { return readFileSync(join(state.devices.A.vault, path), 'utf8') === expected; } catch { return false; } }
  try { return execFileSync(adb, ['-P', String(adbPort), '-s', serial, 'exec-out', 'cat', `${state.devices.M.vault}/${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) === expected; } catch { return false; }
}
async function verify(path, expected) {
  for (const name of ['A', 'M']) await until(() => bytes(name, path, expected), `${name} independent disk bytes`, 180000);
  const ids = [];
  for (const name of ['A', 'M']) ids.push(await read(name, `const f = await wait(() => app.vault.getAbstractFileByPath(P.path), 'file index', 60000); const leaf = app.workspace.getLeaf(false); await leaf.openFile(f); await wait(() => leaf.view.editor?.getValue() === P.text, 'editor bytes', 60000); return (await wait(() => app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path), 'identity')).fileId;`, { path, text: expected }));
  if (!/^[a-f0-9]{32}$/.test(ids[0]) || ids[0] !== ids[1]) throw Error('peer file identity mismatch');
  return { peerDisk: true, peerEditor: true, sameNonemptyFileId: true };
}

try {
  await mobile();
  if (command === 'pair') {
    await read('A', `const p = app.plugins.plugins['obsync-private-sync']; window.labPairing = [];
      if (window.labPairingTap !== p) { window.labPairingTap = p; const previous = p.log.bind(p); p.log = line => { if (/^pairing role=creator decision=/.test(line)) window.labPairing.push({ at: Date.now(), decision: /decision=([^ ]+)/.exec(line)?.[1] }); return previous(line); }; } return true;`);
    await read('M', `app.setting.open(); app.setting.openTabById('obsync-private-sync'); return true;`);
    await until(() => ui('M', fillSetting, 'settings', LABELS.serverUrl, state.url), 'mobile server URL');
    await until(() => ui('M', click, LABELS.pairThis), 'mobile pair control');
    await read('A', `app.commands.executeCommandById('obsync-private-sync:pair-device'); return true;`);
    const code = await until(() => ui('A', pairingCode), 'creator pairing code');
    if (!/^[A-Z2-7]{128}$/.test(code)) throw Error('pair code shape');
    await until(() => ui('M', fillSetting, 'dialog', LABELS.pairingCode, code), 'mobile pairing field');
    await until(() => ui('M', click, LABELS.pairButton), 'mobile pair submit');
    const theirs = await until(() => ui('M', matchCode), 'mobile match code');
    const ours = await until(() => ui('A', matchCode), 'creator match code');
    if (theirs !== ours) throw Error('native match codes differ');
    await until(() => ui('A', click, LABELS.approve), 'creator approval');
    const started = Date.now();
    await until(() => read('M', `return app.plugins.plugins['obsync-private-sync'].state.paired;`), 'mobile key kept');
    for (const name of ['A', 'M']) await read(name, `app.setting.close(); return true;`);
    const samples = [];
    const result = await until(async () => {
      const p = await progress('M');
      const decision = await read('A', `return window.labPairing ?? [];`);
      samples.push({ atMs: Date.now() - started, ...p, decision });
      if (samples.length % 10 === 0) console.log(JSON.stringify({ mobileFiles: p.files, status: p.status }));
      return decision.some(d => d.decision === 'paired') ? { progress: p, decision } : false;
    }, 'creator kept-key status', 120000);
    const heartbeat = await read('M', `const p = app.plugins.plugins['obsync-private-sync']; const own = (await p.transport.devices({ interactive: true })).devices.find(d => d.device_id === p.state.data.deviceId); return { active: own?.state === 'active', heartbeatPresent: typeof own?.last_heartbeat === 'number', equalTimestamp: typeof own?.last_heartbeat === 'number' && own.last_heartbeat === own.last_sign_in };`);
    record('android-pairing', { result: 'PASS', comparedNativeMatchCodes: true, ...result, heartbeat, samples });
  } else if (command === 'progress') {
    record('android-progress', { A: await progress('A'), M: await progress('M') });
  } else if (command === 'readback') {
    const path = await read('M', `return Object.keys(app.plugins.plugins['obsync-private-sync'].state.data.files).find(p => /^Speed\\/F[0-9]{3}\\/Note [0-9]{5}\\.md$/.test(p));`);
    if (!path || !/^Speed\/F[0-9]{3}\/Note [0-9]{5}\.md$/.test(path)) throw Error('downloaded sentinel absent');
    const expected = readFileSync(join(state.devices.A.vault, path), 'utf8');
    const proof = await verify(path, expected);
    for (const name of ['A', 'M']) { const c = await client(name); await c.screenshot(`android-readback-${name}`); }
    record('android-readback', { result: 'PASS', path, bytes: Buffer.byteLength(expected), ...proof, visualInspection: 'PENDING' });
  } else if (command === 'controls') {
    for (const name of ['A', 'M']) record(`android-controls-${name}`, await read(name, `const p = app.plugins.plugins['obsync-private-sync']; return { name: P.name, paired: p.state.paired, serverMatches: p.state.data.serverUrl === P.url, pairingCodeVisible: !!document.querySelector('.obsync-code'), matchCodeVisible: /the code [0-9]{3} [0-9]{3}/.test([...document.querySelectorAll('.modal')].map(m => m.textContent).join(' ')), pairSubmit: !!button('Pair'), approve: !!button('Approve') };`, { name }));
    const c = await client('M'); await c.screenshot('android-controls');
  } else if (command === 'scope') {
    const before = await progress('M');
    await read('M', `if (!app.vault.getAbstractFileByPath('Lab314')) await app.vault.createFolder('Lab314'); app.setting.open(); app.setting.openTabById('obsync-private-sync'); return true;`);
    await until(() => read('M', `const select = row('Folder selection')?.querySelector('select'); if (!select) return false; select.value = 'selected'; select.dispatchEvent(new Event('change', { bubbles: true })); return true;`), 'folder selector');
    await until(() => ui('M', fillSetting, 'settings', 'Selected folders', 'Lab314'), 'selected folders');
    await read('M', `const save = row('Save on this device')?.querySelector('button'); if (!save || save.disabled || save.textContent !== 'Save') throw Error('save selection control'); save.click(); return true;`);
    await until(() => read('M', `return JSON.stringify(app.plugins.plugins['obsync-private-sync'].state.data.syncFolders) === '["Lab314"]';`), 'selection stored');
    await read('M', `app.setting.close(); return true;`);
    const c = await client('M');
    record('android-scope', { result: 'PASS', before, selection: 'Lab314', console: c.consoleSummary,
      limitation: 'Long first download observed and then narrowed for empty-note rehearsal; full 7700-note Android completion NOT_RUN.' });
  } else if (command === 'sweep') {
    for (const name of ['A', 'M']) {
      const c = await client(name);
      await c.evaluate(`document.querySelectorAll('.modal-container .modal-close-button').forEach(b => b.click()); app.setting.close(); return true;`);
      await c.screenshot(`android-${name}-workspace`);
      await c.evaluate(`app.commands.executeCommandById('obsync-private-sync:status'); return true;`);
      await until(() => c.evaluate(`return [...document.querySelectorAll('.modal-title')].some(e => e.textContent === 'Sync status');`), 'status modal');
      await c.screenshot(`android-${name}-status`);
      await c.evaluate(`document.querySelectorAll('.modal-container .modal-close-button').forEach(b => b.click()); app.setting.open(); app.setting.openTabById('obsync-private-sync'); return true;`);
      await c.screenshot(`android-${name}-settings`);
      await c.evaluate(`app.setting.close(); return true;`);
      record(`android-sweep-${name}`, { result: 'PASS', ...(await progress(name)), console: c.consoleSummary, visualInspection: 'PENDING' });
    }
  } else throw Error('usage: mobile.mjs <lab-run> <android-run> pair|progress|readback|controls|scope|sweep');
} catch (error) {
  record('android-failure', { result: 'FAIL', stage: command, reason: error.message }); process.exitCode = 1;
} finally {
  for (const c of clients) c.close();
  if (forward) shell('forward', '--remove', `tcp:${forward}`);
}
