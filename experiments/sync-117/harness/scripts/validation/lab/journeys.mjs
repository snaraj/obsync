#!/usr/bin/env node
// Native lab setup and desktop rehearsals. Physical phone rows stay NOT_RUN.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, manifest, sleep, targets } from './cdp.mjs';
import { click, fillSetting, fillPlaceholder, settingsShow, confirmPhrase, pairingCode, LABELS } from '../../ci/obsidian-drive.mjs';

const [run, command, name = 'A'] = process.argv.slice(2);
const state = manifest(run);
const connections = [];
async function client(device, chooser = false) {
  const c = await connect(state, device, chooser); connections.push(c); return c;
}
function evidence(label, value) {
  if (!/^[a-zA-Z0-9-]+$/.test(label)) throw Error('invalid evidence label');
  if (value.result === 'FAIL' || existsSync(join(state.run, 'evidence', label + '.json'))) label += '-' + Date.now();
  writeFileSync(join(state.run, 'evidence', label + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value));
}
async function until(read, stage, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const answer = await read(); if (answer) return answer; await sleep(200); }
  throw Error(stage + ' deadline');
}
async function anywhere(device, fn, ...args) {
  for (const target of await targets(state, device)) {
    const c = await connect(state, device, false, target.id);
    try {
      const answer = await c.evaluate(`return (${fn.toString()})(...P.args);`, { args }, false);
      if (answer) return answer;
    } finally { c.close(); }
  }
  return null;
}
async function mainRead(device, body, params = {}) {
  const c = await client(device);
  try { return await c.evaluate(body, params); }
  catch { throw Error(`device ${device}: main-window step refused`); }
  finally { c.close(); }
}
async function failureState(device) {
  const windows = [];
  for (const target of await targets(state, device)) {
    const c = await connect(state, device, false, target.id);
    try {
      windows.push(await c.evaluate(`const p = window.app?.plugins?.plugins?.['obsync-private-sync'];
        const setup = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === P.setup);
        return { ownedVault: window.app?.vault?.adapter?.basePath === P.vault,
          paired: p?.state?.paired ?? null, enrolling: p?.enrolling ?? null,
          recoveryConfirmed: p?.state?.data?.recoveryPhrase === 'confirmed', status: p?.currentStatus?.().kind ?? null,
          hidden: document.hidden, minimized: window.electronWindow?.isMinimized?.() ?? null,
          phraseWords: document.querySelectorAll('.obsync-phrase li').length,
          phraseInputs: document.querySelector('.obsync-phrase')?.closest('.modal')?.querySelectorAll('input').length ?? 0,
          pairingCodes: document.querySelectorAll('.obsync-code').length,
          setupButton: !!setup, setupDisabled: setup?.disabled ?? null,
          noticeCount: document.querySelectorAll('.notice').length };`, { setup: LABELS.setupButton }, false));
    } finally { c.close(); }
  }
  return { windows, console: connections.map(c => c.consoleSummary).filter(c => c.errors || c.warnings || c.exceptions || c.pluginLines) };
}
async function open(device) {
  const c = await client(device, true);
  try { await c.evaluate(`require('electron').ipcRenderer.sendSync('vault-open', P.vault, false); return true;`, {}, false); }
  catch (error) { if (error.message !== 'CDP disconnected') throw error; }
  c.close();
  await until(async () => {
    try { return await mainRead(device, 'return !!app.workspace?.layoutReady;'); } catch { return false; }
  }, 'native vault ready');
  await until(() => anywhere(device, click, LABELS.trust), 'native author trust');
  return await until(() => mainRead(device, `const p = app.plugins.plugins['obsync-private-sync']; return p && { loaded: true, version: p.manifest.version };`), 'plugin loaded');
}
async function serverUrl(device) {
  await mainRead(device, `app.setting.open(); app.setting.openTabById('obsync-private-sync'); return true;`);
  await until(() => anywhere(device, settingsShow, LABELS.serverUrl), 'server settings');
  await until(() => anywhere(device, fillSetting, 'settings', LABELS.serverUrl, state.url), 'server field');
  await until(() => mainRead(device, `return app.plugins.plugins['obsync-private-sync'].state.data.serverUrl === P.url;`), 'server saved');
}
function matchCode() {
  const text = [...document.querySelectorAll('.modal:not(.mod-settings)')].map(m => m.textContent).join(' ');
  return /the code ([0-9]{3} [0-9]{3})/.exec(text)?.[1] ?? null;
}
async function idle(device) {
  return await until(async () => {
    try {
      return await mainRead(device, `const p = app.plugins.plugins['obsync-private-sync'];
        return p?.state.paired && p.currentStatus().kind === 'idle' &&
          [...document.querySelectorAll('[aria-label], [title]')].some(e => (e.getAttribute('aria-label') ?? e.getAttribute('title') ?? '') === 'obsync: idle');`);
    } catch { return false; } // The owned main window is created after CDP becomes ready.
  }, `device ${device}: visible idle`, 60000);
}
async function transfer(from, to, label) {
  const path = `Lab-${label}-${Date.now()}.md`, text = `# ${label}\n\nReusable sync sentinel from ${from}.\n`;
  const started = Date.now();
  await mainRead(from, `const file = await app.vault.create(P.path, P.text); await app.workspace.getLeaf(false).openFile(file); return true;`, { path, text });
  const destination = join(state.devices[to].vault, path);
  await until(() => { try { return readFileSync(destination, 'utf8') === text; } catch { return false; } }, `${label}: peer bytes`, 60000);
  const ms = Date.now() - started;
  const observed = await mainRead(to, `const file = await wait(() => app.vault.getAbstractFileByPath(P.path), 'peer index');
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(file);
    await wait(() => leaf.view.editor?.getValue() === P.text, 'peer editor bytes');
    const p = app.plugins.plugins['obsync-private-sync'];
    const record = await wait(() => p.state.fileByPath(P.path), 'peer identity');
    return { editorMatches: true, fileId: record.fileId };`, { path, text });
  const sourceId = await mainRead(from, `return (await wait(() => app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path), 'source identity')).fileId;`, { path });
  if (!/^[a-f0-9]{32}$/.test(sourceId) || observed.fileId !== sourceId) throw Error(`${label}: file identity differs`);
  await idle(to);
  const c = await client(to); await c.screenshot(label + '-peer'); c.close();
  evidence(label, { result: 'PASS', kind: 'desktop rehearsal', from, to, path, bytesMatch: true,
    sha256: createHash('sha256').update(text).digest('hex'), arrivalMs: ms, editorMatches: observed.editorMatches, identityMatches: true,
    visibleIdle: true, physicalPhone: 'NOT_RUN' });
}
try {
  if (command === 'init') {
    for (const device of Object.keys(state.devices)) evidence(`init-${device}`, { device, ...await open(device) });
  } else if (command === 'setup-first') {
    await client(name); // Keep one console observer through the complete native setup.
    await serverUrl(name);
    // Token stays in this process and the owned renderer; never in argv/output.
    const token = readFileSync(join(state.run, 'runtime/server/journal/v1/setup-token'), 'utf8').trim();
    await until(() => anywhere(name, fillPlaceholder, LABELS.setupToken, token), 'setup token field');
    await until(() => anywhere(name, click, LABELS.setupButton), 'setup button');
    await until(() => anywhere(name, confirmPhrase, LABELS.phraseDone), 'native phrase confirmation');
    await until(() => mainRead(name, `return app.plugins.plugins['obsync-private-sync'].state.paired;`), 'account paired');
    await mainRead(name, 'app.setting.close(); return true;');
    evidence('setup-first', { device: name, paired: true, recoveryConfirmed: true });
  } else if (command === 'pair') {
    await serverUrl('B');
    await until(() => anywhere('B', click, LABELS.pairThis), 'pair this device');
    await mainRead('A', `app.commands.executeCommandById('obsync-private-sync:pair-device'); return true;`);
    const code = await until(() => anywhere('A', pairingCode), 'native pairing code');
    if (!/^[A-Z2-7]{128}$/.test(code)) throw Error('pair code shape');
    await until(() => anywhere('B', fillSetting, 'dialog', LABELS.pairingCode, code), 'pair code field');
    await until(() => anywhere('B', click, LABELS.pairButton), 'pair button');
    const theirs = await until(() => anywhere('B', matchCode), 'claimant match code');
    const ours = await until(() => anywhere('A', matchCode), 'creator match code');
    if (ours !== theirs) throw Error('pairing codes differ');
    await until(() => anywhere('A', click, LABELS.approve), 'approval button');
    await until(() => mainRead('B', `return app.plugins.plugins['obsync-private-sync'].state.paired;`), 'key kept');
    for (const device of ['A', 'B']) {
      await mainRead(device, `app.setting.close(); return true;`);
      await anywhere(device, function () { document.querySelectorAll('.modal-container .modal-close-button').forEach(b => b.click()); return true; });
    }
    evidence('pair', { paired: true, comparedNativeMatchCodes: true, physicalPhone: 'NOT_RUN' });
  } else if (command === 'notes') {
    await transfer('A', 'B', 'J2');
    await transfer('B', 'A', 'J1');
  } else if (command === 'restart') {
    for (const device of ['A', 'B']) {
      const started = Date.now();
      execFileSync('python3', ['-B', fileURLToPath(new URL('./lab.py', import.meta.url)), 'restart', '--run', state.run, '--device', device], { stdio: 'ignore' });
      Object.assign(state, manifest(state.run));
      await idle(device);
      const c = await client(device); await c.screenshot(`J8-${device}`); c.close();
      evidence(`J8-${device}`, { result: 'PASS', desktop: device, restartToVisibleIdleMs: Date.now() - started, physicalPhone: 'NOT_RUN' });
    }
  } else if (command === 'sweep') {
    for (const device of Object.keys(state.devices)) {
      await idle(device);
      const c = await client(device);
      const notices = await c.evaluate(`return [...document.querySelectorAll('.notice')].map(n => ({ characters: n.textContent.length }));`);
      await c.screenshot(`sweep-${device}-workspace`);
      await c.evaluate(`app.commands.executeCommandById('obsync-private-sync:status'); return true;`);
      await until(() => c.evaluate(`return [...document.querySelectorAll('.modal-title')].some(e => e.textContent === 'Sync status');`), 'sync status dialog');
      await c.screenshot(`sweep-${device}-status`);
      await c.evaluate(`document.querySelectorAll('.modal-container .modal-close-button').forEach(b => b.click()); app.setting.open(); app.setting.openTabById('obsync-private-sync'); return true;`);
      await until(() => anywhere(device, settingsShow, LABELS.serverUrl), 'settings sweep');
      let settings = false;
      for (const target of await targets(state, device)) {
        const page = await connect(state, device, false, target.id);
        try {
          if (await page.evaluate(`return (${settingsShow.toString()})(P.row);`, { row: LABELS.serverUrl }, false)) {
            let more = true, index = 0;
            while (more && index < 12) {
              await page.screenshot(`sweep-${device}-settings-${++index}`, false);
              more = await page.evaluate(`const pane = document.querySelector('.vertical-tab-content'); const before = pane.scrollTop; pane.scrollTop += pane.clientHeight * .85; return pane.scrollTop > before;`, {}, false);
              await sleep(100);
            }
            if (more) throw Error('settings exceeds screenshot page budget');
            settings = true;
          }
        } finally { page.close(); }
      }
      if (!settings) throw Error('settings capture absent');
      await c.evaluate(`app.setting.close(); return true;`);
      const consoleCounts = { ...c.consoleSummary };
      c.close();
      evidence(`sweep-${device}`, { result: consoleCounts.errors || consoleCounts.exceptions ? 'FAIL' : 'PASS',
        device, visibleIdle: true, notices, settingsCaptured: settings, console: consoleCounts,
        screenshots: 'workspace, Sync status, settings; input values masked', visualInspection: 'PENDING', physicalPhone: 'NOT_RUN' });
      if (consoleCounts.errors || consoleCounts.exceptions) throw Error('console error or exception during visual sweep');
    }
  } else {
    throw Error('usage: journeys.mjs <external-run> init|setup-first|pair|notes|restart|sweep [device]');
  }
} catch (error) {
  let diagnostic;
  try { diagnostic = await failureState(name); }
  catch { diagnostic = { unavailable: true }; }
  evidence(command + '-failure', { result: 'FAIL', stage: command, reason: error.message, diagnostic });
  process.exitCode = 1;
} finally {
  for (const c of connections) c.close();
}
