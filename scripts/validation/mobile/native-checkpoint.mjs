// Bounded read-only native histories/heads + independent synthetic disk bytes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { boundManifest, owned, privateRead, privateSave, digest } from './desktop-guard.mjs';
import { connect } from './cdp.mjs';
const [run, source, label, previous, scope = 'all'] = process.argv.slice(2);
let c;
try {
  if (!/^[a-z][a-z0-9-]{0,48}$/.test(label) || previous && !/^[a-z][a-z0-9-]{0,48}$/.test(previous) || !['all', 'notes'].includes(scope)) throw Error('finite checkpoint arguments');
  const state = boundManifest(run, source), expected = JSON.parse(privateRead(join(state.run, 'private/full-fixtures.json')));
  if (!Array.isArray(expected) || expected.length < 2 || expected.length > 32) throw Error('explicit bounded synthetic fixtures');
  for (const note of expected) {
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(note.path) || typeof note.text !== 'string' || Buffer.byteLength(note.text) > 16384) throw Error('bounded root note');
    const path = join(state.devices.A.vault, note.path); owned(path, false, false);
    if (readFileSync(path, 'utf8') !== note.text) throw Error('independent note bytes differ');
  }
  c = await connect(state, 'A');
  const snapshot = await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state?.paired||p.state.data.serverUrl!==P.url||p.state.custody2()?.suite!==2)throw Error('owned suite2 snapshot');
    const before=p.state.custody2().generation,ids=P.notes.map(note=>{const r=p.state.fileByPath(note.path);if(!r||!/^[a-f0-9]{32}$/.test(r.fileId))throw Error('known native note absent');return {path:note.path,fileId:r.fileId,versionId:r.versionId};});
    const page=await p.transport.listFiles(null,{interactive:true});if(page.next!==null||page.files.length<ids.length+1||page.files.length>64)throw Error('bounded complete synthetic inventory');
    const records=[];for(const row of page.files){if(!/^[a-f0-9]{32}$/.test(row.file_id))throw Error('file id shape');const file=await p.transport.getFile(row.file_id,{interactive:true});if(file.versions.length>128||JSON.stringify(file).length>1048576)throw Error('history budget');records.push({fileId:file.file_id,heads:[...file.heads].sort(),versions:file.versions.map(v=>v.version_id).sort()});}
    if(p.state.custody2().generation!==before||ids.some(old=>p.state.fileByPath(old.path)?.fileId!==old.fileId||p.state.fileByPath(old.path)?.versionId!==old.versionId))throw Error('checkpoint changed while read');
    records.sort((a,b)=>a.fileId.localeCompare(b.fileId));const status=p.currentStatus();return {generation:before,phase:p.state.custody2().phase,status:status.kind,engineState:p.engine===null?'ABSENT':p.engine?.started===false?'STOPPED':p.engine?.started===true?'RUNNING':'UNKNOWN',notes:ids,records};`, { notes: expected });
  const current = { schema: 1, sourceHead: state.source_head, capturedAt: new Date().toISOString(), ...snapshot,
    disk: expected.map(note => ({ path: note.path, sha256: digest(note.text) })) };
  if (previous) {
    const prior = JSON.parse(privateRead(join(state.secrets, `checkpoint-${previous}.json`)));
    if (prior.sourceHead !== current.sourceHead || prior.generation !== current.generation || JSON.stringify(prior.notes) !== JSON.stringify(current.notes) || JSON.stringify(prior.disk) !== JSON.stringify(current.disk)) throw Error('note identity or bytes changed');
    const select = value => scope === 'all' ? value.records : value.records.filter(r => prior.notes.some(note => note.fileId === r.fileId));
    if (JSON.stringify(select(prior)) !== JSON.stringify(select(current))) throw Error('server histories or heads changed');
  }
  const path = join(state.secrets, `checkpoint-${label}.json`);
  if (existsSync(path)) throw Error('checkpoint label already used');
  privateSave(path, JSON.stringify(current));
  const receipt = { schema: 1, result: previous ? 'PASS' : 'OBSERVED', sourceHead: state.source_head, label,
    scope, independentDiskMatches: true, fileCount: snapshot.records.length, noteCount: snapshot.notes.length,
    phase: snapshot.phase, status: snapshot.status, engineState:snapshot.engineState, historiesAndHeadsUnchanged: previous ? true : 'NOT_COMPARED',
    checkpointSha256: digest(readFileSync(path)), generationHash: digest(snapshot.generation), physicalPhone: 'NOT_RUN' };
  writeFileSync(join(state.run, 'evidence', `native-checkpoint-${label}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(receipt));
} catch { console.log(JSON.stringify({ result: 'FAIL', phase: 'native-checkpoint', firstFailure: 'Owned history/head/disk checkpoint refused.' })); process.exitCode = 1; }
finally { c?.close(); }
