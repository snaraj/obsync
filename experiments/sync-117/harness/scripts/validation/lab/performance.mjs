#!/usr/bin/env node
// Metrics only; native setup remains journeys.mjs's settings/dialog flow.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, manifest, sleep } from './cdp.mjs';

const [run, command, mode = 'shown', rawCount = '7700'] = process.argv.slice(2);
const state = manifest(run), count = Number(rawCount), c = await connect(state, 'A');
if (!['shown', 'minimized'].includes(mode) || !Number.isInteger(count) || count < 1) throw Error('invalid measurement arguments');
function save(name, value) {
  if (name.endsWith('-failure')) name += '-' + Date.now();
  writeFileSync(join(state.run, 'evidence', name + '.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function read() {
  return c.evaluate(`const p = app.plugins.plugins['obsync-private-sync'], m = window.__labMeasure;
    return { started: m.started, now: Date.now(), hidden: document.hidden, minimized: window.electronWindow.isMinimized(),
      notes: Object.keys(p.state.data.files).filter(path => path.endsWith('.md')).length,
      idle: p.currentStatus().kind === 'idle', pushes: m.pushed.length, saves: m.saves.length };`);
}
try {
  if (command === 'prepare') {
    await c.evaluate(`const p = app.plugins.plugins['obsync-private-sync'];
      if (p.state.paired || window.__labMeasure) throw Error('measurement needs an unpaired fresh device');
      const m = window.__labMeasure = { pushed: [], saves: [], host: [], failures: [], sync: [], started: null, windowMismatches: 0 };
      const log = p.log;
      p.log = function(line) {
        const now = Date.now();
        if (/^push path_class=file .*decision=pushed /.test(line)) { m.pushed.push(now); if (document.hidden !== (P.mode === 'minimized')) m.windowMismatches++; }
        if (/^host decision=throttle_/.test(line)) m.host.push([now, line]);
        if (/^sync_now /.test(line)) m.sync.push([now, line]);
        if (/(?:^| )decision=(?:failed|refused|timeout)(?: |$)/.test(line)) m.failures.push([now, line]);
        return log.call(this, line);
      };
      const save = p.saveData;
      p.saveData = async function(...args) {
        const at = Date.now(); await save.apply(this, args); m.saves.push({ at, durationMs: Date.now() - at, pushed: m.pushed.length });
      };
      const setup = p.setUpAccount;
      p.setUpAccount = function(...args) { m.started = Date.now(); return setup.apply(this, args); };
      const win = window.electronWindow;
      if (P.mode === 'minimized') win.minimize(); else { win.restore(); win.show(); }
      await wait(() => document.hidden === (P.mode === 'minimized'), 'window state');
      m.windowAt = Date.now(); return true;`, { mode });
    console.log(JSON.stringify({ prepared: true }));
  } else if (command === 'measure') {
    const windowState = await c.evaluate(`const m = window.__labMeasure;
      return { measurementPresent: !!m, at: m?.windowAt ?? null, hidden: document.hidden,
        minimized: window.electronWindow.isMinimized(), mismatches: m?.windowMismatches ?? null,
        setupStarted: m?.started != null };`);
    save('window', windowState);
    if (!windowState.measurementPresent || windowState.hidden !== (mode === 'minimized') || windowState.mismatches || !windowState.setupStarted)
      throw Error('setup changed the measured window state; safe fields retained in window.json');
    const progress = [], deadline = Date.now() + 60 * 60 * 1000;
    let current;
    while (Date.now() < deadline) {
      current = await read(); progress.push(current); save('progress', progress);
      if (current.hidden !== (mode === 'minimized')) throw Error('window state changed during measurement');
      console.log(JSON.stringify(current));
      if (current.notes === count && current.pushes === count && current.idle) break;
      await sleep(5000);
    }
    if (current.notes !== count || current.pushes !== count || !current.idle) throw Error('first sync deadline');
    const firstSyncCompletedAt = Date.now();
    // A minimized sample stays minimized for at least ten complete minutes.
    while (mode === 'minimized' && Date.now() - windowState.at < 600000) {
      await sleep(5000);
      current = await read(); progress.push(current); save('progress', progress);
      if (!current.hidden || !current.minimized) throw Error('window restored before ten minutes');
    }
    await c.evaluate(`const m = window.__labMeasure; m.syncFrom = m.sync.length; m.syncAt = Date.now();
      app.commands.executeCommandById('obsync-private-sync:sync-now'); return true;`);
    let sync;
    const syncDeadline = Date.now() + 600000;
    while (Date.now() < syncDeadline) {
      sync = await c.evaluate(`const m = window.__labMeasure;
        const hit = m.sync.slice(m.syncFrom).find(([, line]) => /^sync_now decision=drained /.test(line));
        return hit && { durationMs: hit[0] - m.syncAt, hidden: document.hidden };`);
      if (sync) break;
      await sleep(1000);
    }
    if (!sync) throw Error('Sync now ten-minute deadline');
    const metrics = await c.evaluate(`const m = window.__labMeasure; return { pushed: m.pushed, saves: m.saves, host: m.host, failures: m.failures, started: m.started };`);
    const bins = [];
    for (let start = 0; start + 1000 < metrics.pushed.length; start += 1000)
      bins.push(1000000 / (metrics.pushed[start + 1000] - metrics.pushed[start]));
    const durationMs = metrics.pushed.at(-1) - metrics.pushed[0];
    const result = { mode, notes: count, durationMs, notesPerSecond: (count - 1) * 1000 / durationMs, syncNowMs: sync.durationMs,
      minimizedMs: mode === 'minimized' ? Date.now() - windowState.at : 0,
      thousandRates: bins, seventhOverFirst: bins.length >= 7 ? bins[6] / bins[0] : null,
      savesPer100Notes: metrics.saves.filter(s => s.at >= metrics.started && s.at <= firstSyncCompletedAt).length * 100 / count, metrics,
      acceptance: 'raw sample; compare three alternated pairs, timing window and TLS route separately' };
    save('performance', result);
    console.log(JSON.stringify({ mode, notes: count, notesPerSecond: result.notesPerSecond, syncNowMs: result.syncNowMs, seventhOverFirst: result.seventhOverFirst }));
  } else throw Error('usage: performance.mjs <run> prepare|measure [shown|minimized] [notes]');
} catch (error) {
  save('performance-failure', { result: 'FAIL', stage: command, reason: error.message });
  throw error;
} finally { c.close(); }
