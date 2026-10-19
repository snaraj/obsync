// Fixture provisioning through the native public Vault API, never an ordinary
// user-rename claim. Outside control is created only after selection is saved.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundManifest, owned, privateSave, digest } from './desktop-guard.mjs';
import { connect, sleep } from './cdp.mjs';
const [run, source, command] = process.argv.slice(2);
const notes = command === 'seed' ? [
  { label: 'selected-one', path: 'Team docs/One.md', text: '# One\n\nSynthetic selected folder sentinel one.\n' },
  { label: 'selected-two', path: 'Team docs/Two.md', text: '# Two\n\nSynthetic selected folder sentinel two.\n' },
] : command === 'outside' ? [
  { label: 'selected-outside', path: 'Outside/Sentinel.md', text: '# Outside\n\nSynthetic desktop excluded control after selection.\n' },
] : null;
let c, state;
try {
  if (!notes) throw Error('finite fixture command required');
  state = boundManifest(run, source);
  for (const note of notes) if (existsSync(join(state.devices.A.vault, note.path)) || existsSync(join(state.secrets, `note-${note.label}.json`))) throw Error('fresh fixture required');
  c = await connect(state, 'A');
  await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state?.paired||p.state.custody2()?.phase!=='active'||p.state.data.serverUrl!==P.url)throw Error('active owned fixture required');
    if(P.command==='outside'&&JSON.stringify(p.state.data.syncFolders)!==JSON.stringify(['Team docs']))throw Error('save selected scope before fresh excluded control');
    for(const note of P.notes){if(app.vault.getAbstractFileByPath(note.path)||p.state.fileByPath(note.path))throw Error('fresh native fixture required');}
    const folder=P.command==='seed'?'Team docs':'Outside';if(app.vault.getAbstractFileByPath(folder))throw Error('fresh fixture folder required');
    await app.vault.createFolder(folder);for(const note of P.notes)await app.vault.create(note.path,note.text);return true;`, { command, notes });
  for (const note of notes) {
    const path = join(state.devices.A.vault, note.path), end = Date.now() + 30000;
    let matched = false;
    while (Date.now() < end) {
      if (existsSync(path)) { owned(path, false, false); if (readFileSync(path, 'utf8') === note.text) { matched = true; break; } }
      await sleep(100);
    }
    if (!matched) throw Error('independent fixture disk bytes differ');
    privateSave(join(state.secrets, `note-${note.label}.json`), JSON.stringify({ path: note.path, text: note.text, sha256: digest(note.text) }));
  }
  const native = await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(P.command==='seed')await wait(()=>P.notes.every(n=>/^[a-f0-9]{64}$/.test(p.state.fileByPath(n.path)?.versionId??''))&&p.currentStatus().kind==='idle','native fixture publication',60000);
    if(P.command==='outside'){await new Promise(r=>setTimeout(r,2500));if(P.notes.some(n=>p.state.fileByPath(n.path)))throw Error('excluded fixture acquired sync identity');}
    return {sourceIdentityCount:P.notes.filter(n=>!!p.state.fileByPath(n.path)).length};`, { command, notes });
  const receipt = { schema: 1, result: command === 'seed' ? 'PREPARED' : 'OBSERVED', sourceHead: state.source_head,
    action: { actor: 'desktop', method: 'public-vault-api-fixture-provisioning' }, command,
    fileCount: notes.length, independentDiskMatches: true, sourceIdentityCount: native.sourceIdentityCount,
    fixtureSha256: notes.map(n => digest(n.text)), ordinaryRename: 'NOT_PERFORMED', physicalPhone: 'NOT_RUN' };
  writeFileSync(join(state.run, 'evidence', `selected-fixtures-${command}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(receipt));
} catch { console.log(JSON.stringify({ result: 'FAIL', phase: 'native-selected-fixture', detail: 'Owned fixture provision or readback refused.' })); process.exitCode = 1; }
finally { c?.close(); }
