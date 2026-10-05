#!/usr/bin/env node
// Trusted input in two owned native editor windows; independent disk convergence.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { connect, manifest, sleep } from './cdp.mjs';

const [run] = process.argv.slice(2), state = manifest(run);
const clients = { A: await connect(state, 'A'), B: await connect(state, 'B') };
const receipt = { result: 'RUNNING', physicalPhone: 'NOT_RUN', cases: [] };
const save = () => writeFileSync(join(run, 'evidence', 'native-cotype.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
async function until(fn, label, ms = 60000) {
  const deadline = Date.now() + ms;
  do { if (await fn()) return; await sleep(100); } while (Date.now() < deadline);
  throw Error(label + ' deadline');
}
async function exact(path, text) {
  for (const name of ['A', 'B']) {
    try { if (readFileSync(join(state.devices[name].vault, path), 'utf8') !== text) return false; }
    catch { return false; }
    if (!await clients[name].evaluate(`return app.workspace.getMostRecentLeaf()?.view?.file?.path === P.path &&
      app.workspace.getMostRecentLeaf().view.editor?.getValue() === P.text &&
      app.plugins.plugins['obsync-private-sync'].currentStatus().kind === 'idle';`, { path, text })) return false;
  }
  return true;
}
try {
  for (let trial = 1; trial <= 3; trial++) {
    const path = `cotype-${trial}.md`, base = 'A: \nB: \n';
    await clients.A.evaluate(`if (document.querySelector('.modal-container') || app.vault.getAbstractFileByPath(P.path)) throw Error('fresh editor precondition');
      const file = await app.vault.create(P.path, P.base); await app.workspace.getLeaf(false).openFile(file, {state:{mode:'source'}}); return true;`, { path, base });
    for (const name of ['A', 'B']) await clients[name].evaluate(`const file = await wait(() => app.vault.getAbstractFileByPath(P.path), 'paired note', 60000);
      await app.workspace.getLeaf(false).openFile(file, {state:{mode:'source'}});
      await wait(() => app.workspace.getMostRecentLeaf()?.view?.editor?.getValue() === P.base, 'baseline', 60000);
      const editor = app.workspace.getMostRecentLeaf().view.editor; editor.focus(); editor.setCursor({line:P.line,ch:3});
      window.__cotypeInput = {trusted:0,untrusted:0}; window.__cotypeListener = e => window.__cotypeInput[e.isTrusted?'trusted':'untrusted']++;
      document.addEventListener('beforeinput', window.__cotypeListener, true); return true;`, { path, base, line: name === 'A' ? 0 : 1 });
    await until(() => exact(path, base), 'initial independent bytes');
    const sequences = { A: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', B: 'abcdefghijklmnopqrstuvwxyz' };
    const row = { trial, cadenceMs: 300, startedAt: Date.now(), input: {}, timeline: [] };
    receipt.cases.push(row); save();
    await Promise.all(['A', 'B'].map(async name => {
      for (const character of sequences[name]) {
        const start = Date.now();
        const before = await clients[name].evaluate(`const view = app.workspace.getMostRecentLeaf()?.view;
          if (document.querySelector('.modal-container') || view?.file?.path !== P.path) throw Error('editor target changed');
          return view.editor.getCursor();`, { path });
        await clients[name].insertText(character);
        row.timeline.push({ device: name, character, at: Date.now(), cursorBefore: before });
        await sleep(Math.max(0, 300 - (Date.now() - start)));
      }
    }));
    row.inputEndedAt = Date.now();
    const expected = `A: ${sequences.A}\nB: ${sequences.B}\n`;
    await until(() => exact(path, expected), 'concurrent editor and disk convergence');
    row.convergenceAfterInputMs = Date.now() - row.inputEndedAt;
    const ids = [];
    for (const name of ['A', 'B']) {
      row.input[name] = await clients[name].evaluate(`document.removeEventListener('beforeinput', window.__cotypeListener, true);
        return { ...window.__cotypeInput, cursor: app.workspace.getMostRecentLeaf().view.editor.getCursor(),
        fileId: app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path)?.fileId };`, { path });
      if (row.input[name].trusted !== sequences[name].length || row.input[name].untrusted !== 0) throw Error('trusted input count differs');
      ids.push(row.input[name].fileId);
      const conflicts = readdirSync(state.devices[name].vault).filter(n => n.startsWith(`cotype-${trial} `));
      if (conflicts.length) throw Error('conflict copy created');
      await clients[name].screenshot(`cotype-${trial}-${name}`);
    }
    if (!/^[0-9a-f]{32}$/.test(ids[0]) || ids[0] !== ids[1]) throw Error('note identity differs');
    row.result = 'PASS'; row.sha256 = createHash('sha256').update(expected).digest('hex');
    row.independentDiskAndEditor = true; save();
  }
  receipt.result = 'PASS'; receipt.visualInspection = 'PENDING'; save();
  console.log(JSON.stringify({ result: receipt.result, cases: receipt.cases.length }));
} catch (error) {
  receipt.result = 'FAIL'; receipt.reason = error.message; save(); throw error;
} finally {
  for (const c of Object.values(clients)) c.close();
}
