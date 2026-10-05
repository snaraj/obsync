// Change only the server address in the recorded disposable desktop vault.
import { connect, manifest, targets, sleep } from './harness/scripts/validation/lab/cdp.mjs';
import { fillSetting, LABELS } from './harness/scripts/ci/obsidian-drive.mjs';
const state = manifest(process.argv[2]), c = await connect(state, 'A');
try {
  await c.evaluate(`app.setting.open(); app.setting.openTabById('obsync-private-sync'); return true;`);
  let filled = false;
  const deadline = Date.now() + 30000;
  while (!filled && Date.now() < deadline) {
    for (const target of await targets(state, 'A')) {
      const page = await connect(state, 'A', false, target.id);
      try {
        filled = await page.evaluate(`return (${fillSetting.toString()})('settings', P.label, P.url);`,
          { label: LABELS.serverUrl }, false);
      } finally { page.close(); }
      if (filled) break;
    }
    if (!filled) await sleep(100);
  }
  if (!filled) throw Error('owned settings field unavailable');
  await c.evaluate(`await wait(() => app.plugins.plugins['obsync-private-sync'].state.data.serverUrl === P.url,
    'saved URL'); app.setting.close(); return true;`);
  console.log(JSON.stringify({ result: 'PASS', nativeServerSettingSaved: true }));
} finally { c.close(); }
