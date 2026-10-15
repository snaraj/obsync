// Ordinary controls on the manifest-bound disposable desktop; never mock custody.
import { readFileSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, sleep, targets } from './cdp.mjs';
import { pairingCodes } from '../../ci/obsidian-evidence.mjs';
import { boundManifest, owned, privateRead as readPrivate, privateSave as savePrivate, assertAndroidObservation, digest } from './desktop-guard.mjs';

const args = process.argv.slice(2), positional = [], options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    if (!['source', 'android-run', 'observation'].includes(key) || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('invalid desktop option');
    options[key] = args[++i];
  } else positional.push(args[i]);
}
const [run, command, label = 'sentinel'] = positional;
const commands = ['pair-generate', 'pair-match', 'pair-approve', 'status', 'snapshot', 'note', 'read-note', 'save-old', 'inspect-cancel', 'block-access', 'rotate-stage', 'save-new', 'prepare', 'resume', 'seed', 'commit', 'close-dialog', 'quit'];
if (!commands.includes(command) || !/^[a-z][a-z0-9-]{0,32}$/.test(label)) throw Error('invalid private operator arguments');
if (!options.source || positional.length > 3) throw Error('explicit candidate source required');
const state = boundManifest(run, options.source), runtime = state.secrets;
const privateRead = name => readPrivate(join(runtime, name));
const privateSave = (name, value) => savePrivate(join(runtime, name), value);
const pluginVersion = JSON.parse(readFileSync(join(state.run, 'runtime/build/plugin/manifest.json'))).version;
const backupShape = /^obsync-recovery-v2(?: [a-z]+){24}$/;
const oldName = 'phone-old-recovery-backup.txt', newName = 'phone-new-recovery-backup.txt', targetName = 'phone-desktop-target.json';
let c, stage='connect';
function record(value) {
  const receipt = { schema: 1, at: new Date().toISOString(), sourceHead: state.source_head, sourceDirty: false, command,
    action: { actor: 'desktop', method: ['status', 'snapshot'].includes(command) ? 'read-only-state' : 'ordinary-control' }, physicalPhone: 'NOT_RUN', ...value };
  writeFileSync(join(state.run, 'evidence', `phone-desktop-${command}-${Date.now()}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(receipt));
}
const dom = `
  const p=app.plugins.plugins['obsync-private-sync'];
  if(!p?.state || p.manifest.version!==P.pluginVersion || p.state.data.serverUrl!==P.url) throw Error('owned candidate required');
  const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  // Obsidian settings lives in a separate owned document with no window.app.
  // Keep state assertions in the manifest-bound main vault; use its live modal.
  const documents=()=>[...new Set([document,app.setting.modalEl?.isConnected?app.setting.modalEl.ownerDocument:null].filter(d=>d&&!d.defaultView?.closed))];
  const ownedElements=selector=>documents().flatMap(d=>[...d.querySelectorAll(selector)]);
  const dialogs=()=>ownedElements('.modal:not(.mod-settings)').filter(visible);
  const oneDialog=title=>{const ds=dialogs();if(ds.length!==1||ds[0].querySelector('.modal-title')?.textContent.trim()!==title)throw Error('dialog identity');return ds[0];};
  const press=(root,text)=>{const bs=[...root.querySelectorAll('button')].filter(b=>b.textContent.trim()===text&&!b.disabled&&visible(b));if(bs.length!==1)throw Error('button identity');bs[0].scrollIntoView({block:'center'});bs[0].click();};
  const settingRow=(root,name)=>{const rs=[...root.querySelectorAll('.setting-item')].filter(r=>r.querySelector('.setting-item-name')?.textContent.trim()===name);if(rs.length!==1)throw Error('row identity');return rs[0];};
  const pane=()=>{const ps=ownedElements('.mod-settings .vertical-tab-content').filter(visible);if(ps.length>1)throw Error('settings pane ambiguous');return ps[0]??null;};
  const fillOwned=(input,value)=>{if(!input)throw Error('missing owned input');input.value=value;const Event=input.ownerDocument.defaultView.Event;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
  const listReady=()=>/^[0-9]+ devices? on this account(?:,.*)?\\.$/.test(settingRow(pane(),'Device list').querySelector('.setting-item-description')?.textContent.trim()??'');
  const activeOthers=()=>[...pane().querySelectorAll('.setting-item')].filter(r=>[...r.querySelectorAll('button')].some(b=>b.textContent.trim()==='Revoke')&&!/\\(this device\\)|\\(revoked\\)|\\(not paired yet\\)/.test(r.querySelector('.setting-item-name')?.textContent??''));
  const rotation=()=>oneDialog('Encryption upgrade and key rotation');
`;
async function ui(body, params = {}) { return c.evaluate(dom + body, { ...params, pluginVersion }); }
async function phase(expected) {
  const result=await ui(`await wait(()=>p.state.custody2()?.phase===P.expected,'phase did not complete',45000);return {phase:p.state.custody2().phase,rotationPending:!!p.state.custody2().rotation};`, { expected });
  await checkpoint();return result;
}
async function checkpoint() {
  const saved=await ui(`const pin=p.state.custody2();if(!['prepared','commit_unknown'].includes(pin?.phase))return null;const r=pin.rotation;const stable=JSON.stringify([pin.generation,p.state.data.vrk,r.intent,r.newRoot,r.fromSuite,r.prepared,r.commit]);const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable)));return {phase:pin.phase,fingerprint:[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('')};`);
  if(!saved)return false;
  const name=`phone-transition-${saved.phase}-checkpoint.json`;
  if(existsSync(join(runtime,name))){const prior=JSON.parse(privateRead(name));if(prior.fingerprint!==saved.fingerprint)throw Error('pending transition changed');}
  else privateSave(name,JSON.stringify(saved));
  return true;
}
async function readSnapshot() {
  return ui(`const devices=await p.listDevices({interactive:true});const self=p.state.data.deviceId;const pin=p.state.custody2();const stableDevices=devices.map(d=>[d.device_id,d.state,d.revoked,d.name,d.platform,d.app_version]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));const stable=JSON.stringify([stableDevices,self,p.state.data.deviceSecret,p.state.data.vrk,pin]);const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable)));return {phase:pin?.phase??null,paired:p.state.paired,activeOtherCount:devices.filter(d=>d.device_id!==self&&!d.revoked&&d.state!=='pending').length,revokedCount:devices.filter(d=>d.revoked).length,deviceCount:devices.length,fingerprint:[...digest].map(b=>b.toString(16).padStart(2,'0')).join('')};`);
}
async function settings() {
  await ui(`if(dialogs().length)throw Error('close owned dialog first');app.setting.open();app.setting.openTabById('obsync-private-sync');await wait(()=>pane()&&[...pane().querySelectorAll('.setting-item-name')].some(e=>e.textContent.trim()==='Recovery backup'),'settings');return true;`);
}
async function closeDialog(title) {
  await ui(`const m=oneDialog(P.title);const bg=m.parentElement?.querySelector(':scope > .modal-bg');if(!bg||!visible(bg))throw Error('owned dialog background identity');bg.click();return true;`, { title });
  await ui(`await wait(()=>dialogs().length===0,'dialog did not close');return true;`);
}
async function openRevoke() {
  stage='revoke-settings';
  await settings();
  stage='revoke-sole-active-target';
  const selected = await ui(`await wait(()=>listReady(),'device list');const rs=activeOthers();if(rs.length!==1)throw Error('sole active other device required');const name=rs[0].querySelector('.setting-item-name').textContent.trim().replace(/ · [a-f0-9]{8}$/,'');return {name};`);
  if (existsSync(join(runtime, targetName))) {
    stage='revoke-recorded-target';
    if (JSON.parse(privateRead(targetName)).name !== selected.name) throw Error('selected phone name changed');
  } else privateSave(targetName, JSON.stringify(selected));
  stage='revoke-open-and-explanation';
  await ui(`const rs=activeOthers();if(rs.length!==1||rs[0].querySelector('.setting-item-name').textContent.trim().replace(/ · [a-f0-9]{8}$/,'')!==P.name)throw Error('device list changed');press(rs[0],'Revoke');await wait(()=>dialogs().length===1,'revoke dialog');const m=dialogs()[0];if(!/^Revoke .+\\?$/.test(m.querySelector('.modal-title')?.textContent.trim()??''))throw Error('revoke dialog identity');const text=m.textContent;if(!text.includes('Revocation cannot erase data or keys already copied')||!text.includes('can decrypt future ciphertext if it obtains it elsewhere'))throw Error('revoke explanation missing');return true;`, selected);
}
async function backupFromDialog(title) {
  const text = await ui(`const m=oneDialog(P.title);const pre=await wait(()=>{const ps=[...m.querySelectorAll('pre')].filter(visible);return ps.length===1?ps[0]:null;},'complete backup not displayed');return pre.textContent.trim();`, { title });
  if (!backupShape.test(text)) throw Error('complete suite2 backup required');
  return text;
}
async function creatorMatches() {
  const matches = [];
  for (const target of await targets(state, 'A')) {
    const page = await connect(state, 'A', false, target.id);
    try {
      if (await page.evaluate('return window.app?.vault?.adapter?.basePath === P.vault;', {}, false) !== true) continue;
      const shown = await page.evaluate(`return (${pairingCodes.toString()})();`);
      for (const code of shown.creator) matches.push({ code, targetId: target.id });
    } finally { page.close(); }
  }
  return matches;
}
async function creatorMatch() {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const shown = await creatorMatches();
    if (shown.length > 1) throw Error('creator comparison ambiguous');
    if (shown.length === 1) return shown[0];
    await sleep(100);
  }
  throw Error('creator comparison absent');
}
function androidObservation() {
  if (!options['android-run'] || !options.observation) throw Error('explicit independent Android observation required');
  const androidRun = resolve(options['android-run']), path = resolve(options.observation);
  owned(androidRun, true); owned(join(androidRun, 'private'), true);
  if (path !== join(androidRun, 'private/android-claimant-observation.json')) throw Error('foreign Android observation');
  const android = JSON.parse(readPrivate(join(androidRun, 'android.json')));
  if (android.format !== 1 || android.run !== androidRun || android.sourceHead !== state.source_head || android.expiresAtEpoch <= Date.now() / 1000) throw Error('foreign or expired Android session');
  // The shared controller revalidates its holder, private ADB and emulator before
  // this fixed read. Never run an unscoped adb or discover another device.
  const appPid = execFileSync('python3', ['-B', fileURLToPath(new URL('../android-session.py', import.meta.url)), 'adb', '--run', androidRun, '--', 'shell', 'pidof', 'md.obsidian'], {
    encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!/^[0-9]+$/.test(appPid)) throw Error('sole owned Android process required');
  return { value: JSON.parse(readPrivate(path)), appPid: Number(appPid), hash: digest(readFileSync(path)) };
}
async function compareAndroid() {
  const shown = await creatorMatch(), observation = androidObservation();
  const invitation = owned(join(runtime, 'phone-pair-code.txt'));
  const code = assertAndroidObservation(observation.value, [shown.code], invitation.mtimeMs, observation.appPid);
  if (existsSync(join(runtime, 'pair-approval-used.json'))) throw Error('this invitation was already approved');
  return { ...shown, code, observationHash: observation.hash };
}
try {
  c = await connect(state, 'A');
  if (command === 'pair-generate') {
    if (existsSync(join(runtime, 'phone-pair-code.txt'))) throw Error('invitation already exists; begin an explicitly archived pairing round');
    const code = await ui(`if(!p.state.paired||p.state.custody2()?.phase!=='active'||p.state.custody2()?.suite!==2||dialogs().length)throw Error('active creator required');app.setting.close();app.commands.executeCommandById('obsync-private-sync:pair-device');return await wait(()=>{const ds=dialogs();if(ds.length!==1||ds[0].querySelector('.modal-title')?.textContent.trim()!=='Pair a new device')return null;const ps=[...ds[0].querySelectorAll('pre.obsync-code')].filter(visible);return ps.length===1?ps[0].textContent.trim():null;},'native creator code');`);
    if (!/^[A-Z2-7]{128}$/.test(code)) throw Error('private invitation shape');
    privateSave('phone-pair-code.txt', code);
    record({ result: 'READY', privateInvitationWritten: true });
  } else if (command === 'pair-match') {
    const shown = await compareAndroid();
    privateSave('phone-creator-match.txt', shown.code);
    record({ result: 'MATCHED', independentObservations: true, creatorVisibleCount: 1, claimantObservationFresh: true, codesMatch: true });
  } else if (command === 'pair-approve') {
    const shown = await compareAndroid();
    const page = await connect(state, 'A', false, shown.targetId);
    try {
      await page.evaluate(`const shown=(${pairingCodes.toString()})();if(shown.creator.length!==1||shown.creator[0]!==P.expected)throw Error('native comparison refused');const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const ms=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(m=>visible(m)&&m.textContent.includes('Approve only if the new device shows the code '+P.expected+'.'));if(ms.length!==1)throw Error('creator identity');const bs=[...ms[0].querySelectorAll('button')].filter(b=>visible(b)&&!b.disabled&&b.textContent.trim()==='Approve');if(bs.length!==1)throw Error('approve identity');bs[0].click();return true;`, { expected: shown.code });
    } finally { page.close(); }
    privateSave('pair-approval-used.json', JSON.stringify({ observationHash: shown.observationHash, at: new Date().toISOString() }));
    record({ result: 'APPROVED', independentObservations: true, creatorVisibleCount: 1, codesMatch: true, comparedBeforeApproval: true,
      consentObserved: 'NOT_OBSERVED_BY_DESKTOP', claimantKeyKept: 'NOT_OBSERVED_BY_DESKTOP' });
  } else if (command === 'status') {
    const pendingCheckpointMatches=await checkpoint();
    record({...await ui(`const s=p.currentStatus(),pin=p.state.custody2();const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');return {result:'OBSERVED',paired:p.state.paired,status:s.kind,pending:s.pending,phase:pin?.phase??null,suite:pin?.suite??null,rotationPending:!!pin?.rotation,previousHistoryAvailable:!!pin?.history,dialogCount:dialogs().length,generationHash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pin?.generation??'')))].map(b=>b.toString(16).padStart(2,'0')).join(''),credentialHash:await hash([p.state.data.deviceId,p.state.data.deviceSecret]),nativeStoreUnmodified:true};`),pendingCheckpointMatches});
  } else if (command === 'snapshot') {
    const snapshot=await readSnapshot();privateSave(`phone-desktop-snapshot-${Date.now()}.json`,JSON.stringify(snapshot));
    record({result:'OBSERVED',privateHashedSnapshotWritten:true,authenticatedDeviceListRead:true,phase:snapshot.phase,activeOtherCount:snapshot.activeOtherCount,revokedCount:snapshot.revokedCount,deviceCount:snapshot.deviceCount});
  } else if (command === 'note') {
    if (existsSync(join(runtime, `note-${label}.json`))) throw Error('synthetic note label already used');
    await ui(`if(dialogs().length||p.state.custody2()?.phase!=='active'||!p.state.paired)throw Error('active owned editor required');app.setting.close();return true;`);
    await c.keyEvent('keyDown', 'n', 'KeyN', 4); await c.keyEvent('keyUp', 'n', 'KeyN', 4);
    await ui(`await wait(()=>app.workspace.activeLeaf?.view?.editor&&/^Untitled(?: [0-9]+)?\\.md$/.test(app.workspace.activeLeaf.view.file?.path??'')&&app.workspace.activeLeaf.view.editor.getValue()==='','new empty native note');const ts=[...document.querySelectorAll('.workspace-leaf.mod-active .inline-title')].filter(visible);if(ts.length!==1||!ts[0].isContentEditable)throw Error('native title unavailable');ts[0].focus();return true;`);
    const name = `Phone-${label}-${Date.now()}`, text = `# ${name}\n\nSynthetic native desktop sentinel.\n`;
    // Obsidian can handle Cmd+A at the workspace while title focus settles.
    // Select exactly the observed title before trusted native text insertion.
    await ui(`const ts=[...document.querySelectorAll('.workspace-leaf.mod-active .inline-title')].filter(visible);if(ts.length!==1||!ts[0].isContentEditable||!/^Untitled(?: [0-9]+)?$/.test(ts[0].textContent))throw Error('new title identity');const t=ts[0];t.focus();const selection=t.ownerDocument.getSelection(),range=t.ownerDocument.createRange();range.selectNodeContents(t);selection.removeAllRanges();selection.addRange(range);if(selection.toString()!==t.textContent)throw Error('title selection not established');return true;`);
    await c.insertText(name);
    await c.keyEvent('keyDown', 'Enter', 'Enter'); await c.keyEvent('keyUp', 'Enter', 'Enter');
    await ui(`await wait(()=>app.workspace.activeLeaf?.view?.file?.path===P.path,'native title rename');const es=[...document.querySelectorAll('.workspace-leaf.mod-active .cm-content')].filter(visible);if(es.length!==1||!es[0].isContentEditable)throw Error('native editor unavailable');es[0].focus();return true;`, { path: name + '.md' });
    await c.insertText(text);
    await ui(`await wait(()=>app.workspace.activeLeaf.view.editor.getValue()===P.text,'native editor bytes');return true;`, { text });
    const path = join(state.devices.A.vault, name + '.md'), start = Date.now();
    let matched = false;
    while (Date.now() - start < 30000) {
      if (existsSync(path)) { const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink()) throw Error('owned note custody'); if (readFileSync(path, 'utf8') === text) { matched = true; break; } }
      await sleep(100);
    }
    if (!matched) throw Error('independent disk bytes did not match');
    privateSave(`note-${label}.json`, JSON.stringify({ path: name + '.md', text, sha256: digest(text) }));
    record({ result: 'PASS', syntheticNote: name + '.md', nativeInsertText: true, editorMatches: true, independentDiskMatches: true, sha256: createHash('sha256').update(text).digest('hex'), diskReadbackMs: Date.now() - start });
  } else if (command === 'read-note') {
    const note = JSON.parse(privateRead(`note-${label}.json`));
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}(?: \(restored-[a-f0-9]{32}\))?\.md$/.test(note.path) || typeof note.text !== 'string' ||
        !note.text.startsWith('# ') || Buffer.byteLength(note.text) > 16384 || note.sha256 !== digest(note.text)) throw Error('bounded synthetic note expectation required');
    const path = join(state.devices.A.vault, note.path), started = Date.now();
    let matched = false;
    while (Date.now() - started < 60000) {
      if (existsSync(path)) {
        owned(path, false, false);
        if (readFileSync(path, 'utf8') === note.text) { matched = true; break; }
      }
      await sleep(100);
    }
    if (!matched) throw Error('passive disk convergence absent');
    const passiveMs = Date.now() - started;
    await ui(`if(dialogs().length)throw Error('close owned dialog first');app.setting.close();return true;`);
    await c.keyEvent('keyDown', 'o', 'KeyO', 4); await c.keyEvent('keyUp', 'o', 'KeyO', 4);
    await ui(`const input=await wait(()=>{const ms=ownedElements('.prompt').filter(visible);if(ms.length!==1)return null;const inputs=[...ms[0].querySelectorAll('input.prompt-input')].filter(visible);return inputs.length===1?inputs[0]:null;},'native quick switcher');input.focus();return true;`);
    await c.insertText(note.path);
    await ui(`await wait(()=>{const ms=ownedElements('.prompt').filter(visible);if(ms.length!==1)return false;const inputs=[...ms[0].querySelectorAll('input.prompt-input')].filter(visible);return inputs.length===1&&inputs[0].value===P.path&&[...ms[0].querySelectorAll('.suggestion-item')].filter(visible).length===1;},'unique quick switcher result');return true;`, { path: note.path });
    await c.keyEvent('keyDown', 'Enter', 'Enter'); await c.keyEvent('keyUp', 'Enter', 'Enter');
    await ui(`await wait(()=>app.workspace.activeLeaf?.view?.file?.path===P.path&&app.workspace.activeLeaf.view.editor?.getValue()===P.text,'received native editor bytes');return true;`, note);
    // Read again after opening so an editor observation cannot conceal a disk race.
    owned(path, false, false);
    if (readFileSync(path, 'utf8') !== note.text) throw Error('observed disk bytes changed');
    record({ result: 'PASS', passiveReceiveBeforeReadback: true, independentDiskMatches: true, editorMatches: true, nativeQuickSwitcher: true, sha256: note.sha256, length: Buffer.byteLength(note.text), passiveReadbackMs: passiveMs });
  } else if (command === 'save-old') {
    if (existsSync(join(runtime, oldName))) throw Error('old backup already saved');
    await settings();
    await ui(`if(p.state.custody2()?.phase!=='active'||p.state.data.recoveryPhrase!=='confirmed')throw Error('confirmed current backup required');press(settingRow(pane(),'Recovery backup'),'Show');await wait(()=>dialogs().length===1,'recovery dialog');return true;`);
    privateSave(oldName, await backupFromDialog('Recovery backup'));
    await closeDialog('Recovery backup'); record({ result: 'PASS', completeOldBackupSaved: true, privateFileReadback: true });
  } else if (command === 'inspect-cancel' || command === 'block-access' || command === 'rotate-stage') {
    stage='revoke-backup-preconditions';
    if (!backupShape.test(privateRead(oldName))) throw Error('save old backup first');
    if (command === 'rotate-stage' && existsSync(join(runtime, newName))) throw Error('new backup already exists');
    await ui(`if(p.state.custody2()?.phase!=='active')throw Error('active phase required');return true;`);
    const before=command==='inspect-cancel'?await readSnapshot():null;
    if(before&&before.activeOtherCount!==1)throw Error('authenticated sole other device required');
    await openRevoke();
    if (command === 'inspect-cancel') {
      await ui(`const m=dialogs()[0];const bs=[...m.querySelectorAll('button')].filter(b=>visible(b)&&!b.disabled).map(b=>b.textContent.trim());if(bs.filter(b=>b==='Rotate key').length!==1||bs.filter(b=>b==='Block access').length!==1)throw Error('revoke choices');return true;`);
      await closeDialog(await ui(`return dialogs()[0].querySelector('.modal-title').textContent.trim();`));
      await ui(`if(activeOthers().length!==1||p.state.custody2()?.phase!=='active'||!p.state.paired)throw Error('cancel state changed');return true;`);
      const after=await readSnapshot();if(after.activeOtherCount!==1||before.fingerprint!==after.fingerprint)throw Error('authenticated cancel state changed');
      record({ result: 'PASS', accessOnlyExplanationPresent: true, rotateChoicePresent: true, cancelled: true, activeOtherStillListed: true, activePhaseUnchanged: true, authenticatedBeforeAfterUnchanged:true });
    } else if (command === 'block-access') {
      await ui(`press(dialogs()[0],'Block access');await wait(()=>dialogs().length===0&&listReady()&&activeOthers().length===0&&/revoked/.test(settingRow(pane(),'Device list').textContent),'active other no longer listed',45000);return true;`);
      const after=await readSnapshot();if(after.activeOtherCount!==0||after.revokedCount<1)throw Error('authenticated revocation not observed');
      record({ result: 'OBSERVED', accessOnlyPressed: true, activeOtherNoLongerListed: true, authenticatedRevokedDeviceObserved:true, physicalPhoneRefusal: 'NOT_OBSERVED_BY_HELPER' });
    } else {
      stage='rotate-stage-control';
      await ui(`press(dialogs()[0],'Rotate key');await wait(()=>dialogs().length===1&&dialogs()[0].querySelector('.modal-title')?.textContent==='Encryption upgrade and key rotation','rotation dialog');press(rotation(),'Stage encryption transition');return true;`);
      await phase('draft'); privateSave(newName, await backupFromDialog('Encryption upgrade and key rotation'));
      if (privateRead(newName) === privateRead(oldName)) throw Error('new backup did not differ');
      record({ result: 'PASS', phase: 'draft', completeNewBackupSavedSeparately: true, backupsDiffer: true, privateFileReadback: true });
    }
  } else if (command === 'save-new') {
    if (existsSync(join(runtime, newName))) throw Error('new backup already saved');
    const backup = await backupFromDialog('Encryption upgrade and key rotation');
    if (backup === privateRead(oldName)) throw Error('new backup did not differ');
    privateSave(newName, backup); record({ result: 'PASS', completeNewBackupSavedSeparately: true, privateFileReadback: true, backupsDiffer: true });
  } else if (command === 'resume') {
    await settings(); await ui(`if(!p.state.custody2()?.rotation)throw Error('pending transition required');press(settingRow(pane(),'Recovery backup'),'Resume encryption transition');await wait(()=>dialogs().length===1,'resume dialog');rotation();return true;`);
    record(await ui(`return {result:'OBSERVED',phase:p.state.custody2().phase,rotationPending:!!p.state.custody2().rotation};`));
  } else if (command === 'prepare' || command === 'commit') {
    const backup = privateRead(newName), token = readPrivate(join(state.run, 'runtime/server/journal/v1/setup-token'));
    if (!backupShape.test(backup) || !/^[a-f0-9]{64}$/.test(token) || backup === privateRead(oldName)) throw Error('private transition input shape');
    await ui(`const pin=p.state.custody2();if(pin?.phase!==P.phase||!pin.rotation)throw Error('transition phase required');const m=rotation();const ps=[...m.querySelectorAll('pre')].filter(visible);if(ps.length!==1||ps[0].textContent.trim()!==P.backup)throw Error('saved new backup differs from displayed backup');fillOwned(settingRow(m,'Confirm complete new backup').querySelector('textarea'),P.backup);fillOwned(settingRow(m,'Setup token').querySelector('input'),P.token);press(m,P.action);return true;`, { backup, token, phase: command === 'prepare' ? 'draft' : 'commit_unknown', action: command === 'prepare' ? 'Prepare transition' : 'Commit new key' });
    await phase(command === 'prepare' ? 'prepared' : 'active');
    record({ result: 'PASS', phase: command === 'prepare' ? 'prepared' : 'active', savedNewBackupReadBackThroughUI: true, setupTokenFromOwnedRuntime: true, physicalPhoneAcceptance: 'NOT_OBSERVED_BY_HELPER' });
  } else if (command === 'seed') {
    await ui(`if(!['prepared','seeding'].includes(p.state.custody2()?.phase))throw Error('seed phase required');press(rotation(),'Re-encrypt current versions');return true;`);
    await phase('commit_unknown'); record({ result: 'PASS', phase: 'commit_unknown', ordinaryReencryptControlPressed: true, restartRequiredBeforeCommit: true });
  } else if (command === 'close-dialog') {
    const title = await ui(`if(dialogs().length!==1)throw Error('sole owned dialog required');const title=dialogs()[0].querySelector('.modal-title')?.textContent.trim();if(!['Encryption upgrade and key rotation','Recovery backup'].includes(title))throw Error('unapproved dialog');return title;`);
    await closeDialog(title); record({ result: 'PASS', closedOwnedDialog: true });
  } else if (command === 'quit') {
    await ui(`setTimeout(()=>window.electron.remote.app.quit(),0);return true;`);
    record({ result: 'QUIT_REQUESTED', normalAppQuit: true, ownedProcessAbsence: 'NOT_OBSERVED_BY_HELPER' });
  }
} catch {
  record({ result: 'FAIL', stage, detail: 'Owned desktop step refused or timed out; secret-bearing details withheld. Inspect the current phase before another action.' });
  process.exitCode = 1;
} finally { c?.close(); }
