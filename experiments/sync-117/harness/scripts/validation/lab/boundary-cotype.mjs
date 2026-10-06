// Native input at line boundaries, with independent file and editor readback.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect, manifest, sleep } from './cdp.mjs';

const [run] = process.argv.slice(2), state = manifest(run);
const clients = { A: await connect(state, 'A'), B: await connect(state, 'B') };
const receipt = { result: 'RUNNING', cases: [], physicalPhone: 'NOT_RUN' };
const save = () => writeFileSync(join(run, 'evidence/boundary-cotype.json'), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
const cases = [
  { name: 'prefix-and-suffix', base: 'ABCDEFGHIJKL', A: [...'MNOPQRSTUVWXYZ'], B: [...'abcdefghijklmnopqrstuvwxyz'], prefixB: true,
    expected: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { name: 'two-prefixes', base: 'anchor', A: [...'ABCDEFGHIJKLM'], B: [...'abcdefghijklm'], prefixA: true, prefixB: true,
    expected: 'ABCDEFGHIJKLMabcdefghijklmanchor' },
  { name: 'word-boundaries', base: '# Both', A: [' A001', ' A002', ' A003', ' A004'], B: [' B001', ' B002', ' B003', ' B004'],
    expected: '# Both A001 A002 A003 A004 B001 B002 B003 B004' },
];
async function until(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  do { if (await fn()) return; await sleep(150); } while (Date.now() < deadline);
  throw Error(label + ' deadline');
}
try {
  for (const spec of cases) {
    const path = 'boundary-' + spec.name + '.md', base = 'Control 42\n' + spec.base + '\n', expected = 'Control 42\n' + spec.expected + '\n';
    const row = { name: spec.name, path, base, expected, cadenceMs: 350, timeline: [], observations: [] };
    receipt.cases.push(row); save();
    await clients.A.evaluate(`if (document.querySelector('.modal-container') || app.vault.getAbstractFileByPath(P.path)) throw Error('fresh note required');
      await app.vault.create(P.path, P.base); return true;`, {path, base});
    for (const name of ['A', 'B']) {
      await clients[name].evaluate(`const file = await wait(() => app.vault.getAbstractFileByPath(P.path), 'note', 60000);
        await app.workspace.getLeaf(false).openFile(file, {state:{mode:'source'}});
        await wait(() => app.workspace.getMostRecentLeaf()?.view?.editor?.getValue() === P.base, 'base', 60000);
        const e = app.workspace.getMostRecentLeaf().view.editor; e.focus(); e.setCursor({line:1,ch:P.prefix ? 0 : e.getLine(1).length});
        window.labBoundaryInput = {trusted:0,untrusted:0}; window.labBoundaryListener = e => window.labBoundaryInput[e.isTrusted?'trusted':'untrusted']++;
        document.addEventListener('beforeinput', window.labBoundaryListener, true); return true;`, {path, base, prefix: !!spec['prefix' + name]});
    }
    await until(() => ['A','B'].every(name => readFileSync(join(state.devices[name].vault,path),'utf8') === base), 'base on both disks');
    row.startedAt = Date.now();
    await Promise.all(['A', 'B'].map(async name => {
      for (const text of spec[name]) {
        const tick = Date.now();
        const before = await clients[name].evaluate(`const v = app.workspace.getMostRecentLeaf()?.view;
          if (document.querySelector('.modal-container') || v?.file?.path !== P.path) throw Error('editor changed');
          return {cursor:v.editor.getCursor(),typing:app.plugins.plugins['obsync-private-sync'].host.typing(P.path)};`, {path});
        await clients[name].insertText(text);
        row.timeline.push({device:name,text,sentAt:tick,acknowledgedAt:Date.now(),...before}); save();
        await sleep(Math.max(0, 350 - (Date.now() - tick)));
      }
    }));
    row.lastInputAt = Math.max(...row.timeline.map(r => r.acknowledgedAt));
    const deadline = row.lastInputAt + 60000;
    do {
      const samples = {};
      for (const name of ['A','B']) {
        const disk = readFileSync(join(state.devices[name].vault,path),'utf8');
        const native = await clients[name].evaluate(`const p = app.plugins.plugins['obsync-private-sync'], v = app.workspace.getMostRecentLeaf()?.view;
          return {editor:v?.file?.path === P.path ? v.editor?.getValue() : null,cursor:v.editor?.getCursor(),typing:p.host.typing(P.path),status:p.currentStatus().kind,id:p.state.fileByPath(P.path)?.fileId};`, {path});
        const files = readdirSync(state.devices[name].vault).filter(n => n.startsWith(path.slice(0,-3)));
        samples[name] = {disk,...native,fileCount:files.length,sha256:createHash('sha256').update(disk).digest('hex')};
      }
      row.observations.push({at:Date.now(),...samples});
      row.result = Object.values(samples).every(s => s.disk === expected && s.editor === expected && s.fileCount === 1) && /^[0-9a-f]{32}$/.test(samples.A.id ?? '') && samples.A.id === samples.B.id ? 'PASS' : 'FAIL'; save();
      if (row.result === 'PASS') break;
      await sleep(500);
    } while (Date.now() < deadline);
    row.input = {};
    for (const name of ['A','B']) {
      row.input[name] = await clients[name].evaluate(`document.removeEventListener('beforeinput', window.labBoundaryListener, true);
        const r = window.labBoundaryInput; delete window.labBoundaryInput; delete window.labBoundaryListener; return r;`);
      if (row.input[name].trusted !== spec[name].length || row.input[name].untrusted) row.result = 'FAIL';
      await clients[name].screenshot('boundary-' + spec.name + '-' + name);
    }
    save(); console.log(JSON.stringify({case:spec.name,result:row.result,elapsedMs:Date.now()-row.startedAt}));
  }
  receipt.result = receipt.cases.every(c => c.result === 'PASS') ? 'PASS' : 'FAIL'; save();
  if (receipt.result !== 'PASS') process.exitCode = 1;
} catch (error) { receipt.result = 'FAIL'; receipt.reason = error.message; save(); throw error; }
finally { for (const c of Object.values(clients)) c.close(); }
