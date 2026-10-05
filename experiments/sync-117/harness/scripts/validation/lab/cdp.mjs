// Only the instances in a lab.py manifest may be driven. No global discovery.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function manifest(run) {
  run = realpathSync(run);
  const state = JSON.parse(readFileSync(join(run, 'lab.json')));
  if (state.format !== 1 || state.run !== run || state.stopped) throw Error('invalid or stopped lab');
  return state;
}

export async function targets(state, name) {
  const device = state.devices[name], record = state.processes[name];
  if (!device || !record) throw Error('unowned device');
  if (device.android) {
    const port = record.argv[record.argv.indexOf('-port') + 1];
    if (!record.argv.includes('-avd') || device.serial !== `emulator-${port}`) throw Error('unowned emulator');
    const pid = execFileSync(device.adb, ['-P', String(device.adbPort), '-s', device.serial, 'shell', 'pidof', 'md.obsidian'], { encoding: 'utf8' }).trim();
    if (pid !== String(device.appPid)) throw Error('Android app restarted; refresh its owned forward');
  } else if (!record.argv.includes(`--user-data-dir=${device.userdata}`)) throw Error('unowned device');
  const actual = execFileSync('ps', ['-p', String(record.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim();
  if (actual !== record.identity) throw Error('device process identity changed');
  return (await (await fetch(`http://127.0.0.1:${device.port}/json/list`, { signal: AbortSignal.timeout(15000) })).json()).filter(t => t.type === 'page');
}
export async function connect(state, name, chooser = false, targetId = null) {
  const device = state.devices[name];
  const pages = await targets(state, name);
  if (!chooser && targetId === null) {
    for (const page of pages) {
      const c = await connect(state, name, false, page.id);
      if (await c.evaluate('return window.app?.vault?.adapter?.basePath === P.vault;', {}, false)) return c;
      c.close();
    }
    throw Error('recorded vault has no main window');
  }
  const target = pages.find(t => targetId ? t.id === targetId : chooser || t.title.includes(`Lab-${name}`));
  if (!target) throw Error('lab window not ready');
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || +url.port !== device.port) throw Error('foreign CDP address');
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(Error('CDP connection failed')); });
  let next = 0;
  const pending = new Map();
  const consoleSummary = { errors: 0, warnings: 0, exceptions: 0, pluginLines: 0, reasons: {} };
  ws.onmessage = event => {
    const answer = JSON.parse(event.data), request = pending.get(answer.id);
    if (request) { clearTimeout(request.timer); pending.delete(answer.id); request.resolve(answer); }
    if (answer.method === 'Runtime.exceptionThrown') consoleSummary.exceptions++;
    if (answer.method === 'Runtime.consoleAPICalled') {
      if (answer.params.type === 'error') consoleSummary.errors++;
      if (answer.params.type === 'warning') consoleSummary.warnings++;
      if (answer.params.args.some(arg => typeof arg.value === 'string' && arg.value.startsWith('obsync '))) consoleSummary.pluginLines++;
      for (const arg of answer.params.args) if (typeof arg.value === 'string' && arg.value.startsWith('obsync ')) {
        const reason = /\breason=([a-z_]{1,40})(?:\s|$)/.exec(arg.value)?.[1];
        if (reason && Object.keys(consoleSummary.reasons).length < 40) consoleSummary.reasons[reason] = (consoleSummary.reasons[reason] ?? 0) + 1;
      }
    }
  };
  ws.onclose = () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('CDP disconnected')); } pending.clear(); };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP deadline')); }, 125000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(body, params = {}, checkVault = true) {
    const prelude = `const P = ${JSON.stringify({ ...params, vault: device.vault, run: state.run, url: state.url })};
      const wait = async (read, stage, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw Error(stage); };
      const button = label => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
      const row = name => [...document.querySelectorAll('.setting-item')].find(r => r.querySelector('.setting-item-name')?.textContent.trim() === name);
      const fill = (input, value) => { if (!input) throw Error('missing input'); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
      ${checkVault ? "if (app.vault.adapter.basePath !== P.vault) throw Error('foreign vault');" : ''}`;
    const answer = await send('Runtime.evaluate', { expression: `(async () => { ${prelude}\n${body} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (answer.error || answer.result?.exceptionDetails) throw Error('lab UI step refused or timed out; no secret-bearing exception printed');
    return answer.result?.result?.value;
  }
  async function screenshot(name, checkVault = true) {
    if (!/^[a-zA-Z0-9-]+$/.test(name)) throw Error('invalid capture name');
    await evaluate(`if (document.querySelector('.obsync-phrase, .obsync-code') || [...document.querySelectorAll('input[type=password]')].some(e => e.value !== '') || [...document.querySelectorAll('.modal-container')].some(m => !m.querySelector('.mod-settings') && !['Sync status', 'Export and open a copy'].includes(m.querySelector('.modal-title')?.textContent ?? ''))) throw Error('private dialog');
      const style = document.createElement('style'); style.id = 'lab-capture-mask'; style.textContent = 'input,textarea,.lab-capture-status table tr:nth-child(-n+2) > :not(:first-child),.lab-capture-status table tr:nth-child(-n+2) > :not(:first-child) * { color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } .obsync-phrase,.obsync-code,.modal-container:not(.lab-capture-allowed) { visibility: hidden !important; }'; document.head.append(style);
      for (const modal of document.querySelectorAll('.modal-container')) { modal.classList.add('lab-capture-allowed'); if (modal.querySelector('.modal-title')?.textContent === 'Sync status') modal.classList.add('lab-capture-status'); } return true;`, {}, checkVault);
    try {
      const answer = await send('Page.captureScreenshot', { format: 'png' });
      if (answer.error || !answer.result?.data) throw Error('screenshot failed');
      await evaluate(`if (document.querySelector('.obsync-phrase, .obsync-code, .modal-container:not(.lab-capture-allowed)') || [...document.querySelectorAll('input[type=password]')].some(e => e.value !== '')) throw Error('dialog changed during capture'); return true;`, {}, checkVault);
      writeFileSync(join(state.run, 'evidence', name + '.png'), Buffer.from(answer.result.data, 'base64'), { mode: 0o600 });
    } finally {
      await evaluate(`document.getElementById('lab-capture-mask')?.remove(); document.querySelectorAll('.lab-capture-allowed,.lab-capture-status').forEach(e => e.classList.remove('lab-capture-allowed', 'lab-capture-status')); return true;`, {}, checkVault);
    }
  }
  await send('Runtime.enable');
  async function insertText(text) {
    if (typeof text !== 'string' || text.length > 16384) throw Error('input text bound');
    const answer = await send('Input.insertText', { text });
    if (answer.error) throw Error('native text input refused');
  }
  async function keyEvent(type, key, code = '', modifiers = 0) {
    if (!['keyDown', 'keyUp'].includes(type) || typeof key !== 'string' || key.length > 40 ||
        typeof code !== 'string' || code.length > 40 || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) throw Error('key event bound');
    const answer = await send('Input.dispatchKeyEvent', { type, key, code, modifiers });
    if (answer.error) throw Error('native key input refused');
  }
  async function copyToClipboard(text) {
    if (device.android || typeof text !== 'string' || text.length > 16384) throw Error('clipboard bound');
    return await evaluate(`if (Object.hasOwn(window, 'labPreviousClipboard')) throw Error('clipboard already held');
      const clipboard = require('electron').clipboard; window.labPreviousClipboard = clipboard.readText();
      window.labCopiedClipboard = P.text; clipboard.writeText(P.text); return true;`, { text });
  }
  async function restoreClipboard(expected = null) {
    if (device.android) throw Error('desktop clipboard required');
    return await evaluate(`if (!Object.hasOwn(window, 'labPreviousClipboard')) return false;
      const clipboard = require('electron').clipboard, same = clipboard.readText() === (P.expected ?? window.labCopiedClipboard);
      if (same) clipboard.writeText(window.labPreviousClipboard);
      delete window.labPreviousClipboard; delete window.labCopiedClipboard; return same;`, { expected });
  }
  return { evaluate, screenshot, insertText, keyEvent, copyToClipboard, restoreClipboard, consoleSummary, close: () => ws.close() };
}
