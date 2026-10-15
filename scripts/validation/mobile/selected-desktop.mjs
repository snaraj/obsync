// Native settings/Files controls. Read-only identities and independent disk
// bytes prove the result; only actual Obsidian user controls perform renames.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { boundManifest, owned, privateRead, privateSave, digest } from './desktop-guard.mjs';
import { connect, targets, sleep } from './cdp.mjs';
const [run, source, command, index] = process.argv.slice(2);
let state, c, watchElapsed;
const uiPrelude = `const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state?.paired||p.state.custody2()?.phase!=='active'||p.state.data.serverUrl!==P.url)throw Error('owned active selected peer');
 const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const one=(selector,text=null)=>{const es=[...document.querySelectorAll(selector)].filter(visible).filter(e=>text===null||e.textContent.trim()===text);if(es.length!==1||es[0].disabled)throw Error('ordinary selected control identity');return es[0];};
 // Settings can live in the manifest-bound app's separate owned document.
 const documents=()=>[...new Set([document,app.setting.modalEl?.isConnected?app.setting.modalEl.ownerDocument:null].filter(d=>d&&!d.defaultView?.closed))];
 const pane=()=>{const ps=documents().flatMap(d=>[...d.querySelectorAll('.mod-settings .vertical-tab-content')]).filter(visible);if(ps.length>1)throw Error('selected settings pane identity');return ps[0]??null;};
 const row=name=>{const root=pane();if(!root)throw Error('selected settings pane identity');const rs=[...root.querySelectorAll('.setting-item')].filter(visible).filter(r=>r.querySelector('.setting-item-name')?.textContent.trim()===name);if(rs.length!==1)throw Error('selected setting identity');return rs[0];};`;
const ui = (body, params={}) => c.evaluate(uiPrelude+body,params);
async function selectedScope() {
  const marker=randomUUID(),connections=[],deadline=Date.now()+30000;
  let expired=false,saved=false;
  // One original30s window, including discovery/actions and a reserved cleanup second.
  const within=async(action,cleanup=false)=>{
    const due=cleanup?deadline:deadline-1000,remaining=due-Date.now();
    if(remaining<=0||expired&&!cleanup)throw Error('owned scope input deadline');
    let timer;
    try{const value=await Promise.race([action(),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;for(const candidate of connections)candidate.close();reject(Error('owned scope input deadline'));},remaining);})]);if(Date.now()>=due){expired=true;throw Error('owned scope input deadline');}return value;}
    finally{clearTimeout(timer);}
  };
  try {
    await within(()=>ui(`app.setting.open();app.setting.openTabById('obsync-private-sync');await wait(()=>pane()&&row('Folder selection'),'folder settings',Math.max(0,P.deadline-Date.now()));const select=row('Folder selection').querySelector('select');const options=[...select.options].filter(o=>o.textContent.trim()==='Selected folders only');if(options.length!==1)throw Error('selected option changed');select.value=options[0].value;select.dispatchEvent(new select.ownerDocument.defaultView.Event('change',{bubbles:true}));const t=row('Selected folders').querySelector('textarea');if(!t||t.disabled)throw Error('selected textarea absent');t.focus();t.select();return true;`,{deadline:deadline-1000}));
    await within(()=>ui(`const root=pane();if(!root||root.hasAttribute('data-obsync-owned-scope'))throw Error('owned scope marker occupied');root.setAttribute('data-obsync-owned-scope',P.marker);return true;`,{marker}));
    const matches=[];
    const pages=await within(()=>targets(state,'A'));
    if(!Array.isArray(pages)||pages.length<1||pages.length>8||new Set(pages.map(page=>page.id)).size!==pages.length)throw Error('bounded owned Settings pages required');
    for(const page of pages) {
      const candidate=await within(async()=>{const opened=await connect(state,'A',false,page.id);if(expired){opened.close();throw Error('owned scope input deadline');}connections.push(opened);return opened;});
      const found=await within(()=>candidate.evaluate(`const roots=[...document.querySelectorAll('[data-obsync-owned-scope]')].filter(e=>e.getAttribute('data-obsync-owned-scope')===P.marker);if(roots.length>1)throw Error('scope target ambiguous');return roots.length===1&&roots[0].isConnected&&roots[0].matches('.mod-settings .vertical-tab-content');`,{marker},false));
      if(found===true)matches.push(candidate);
    }
    if(matches.length!==1)throw Error('one process-owned Settings target required');
    const input=matches[0];
    const scoped=`const roots=[...document.querySelectorAll('[data-obsync-owned-scope]')].filter(e=>e.getAttribute('data-obsync-owned-scope')===P.marker);if(roots.length!==1||!roots[0].isConnected||!roots[0].matches('.mod-settings .vertical-tab-content'))throw Error('owned Settings target changed');const root=roots[0];const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const row=name=>{const rows=[...root.querySelectorAll('.setting-item')].filter(visible).filter(r=>r.querySelector('.setting-item-name')?.textContent.trim()===name);if(rows.length!==1)throw Error('owned scope row identity');return rows[0];};`;
    await within(()=>input.evaluate(scoped+`const t=row('Selected folders').querySelector('textarea');if(!t||t.disabled)throw Error('selected textarea absent');t.focus();t.select();if(document.activeElement!==t)throw Error('owned selected input focus');return true;`,{marker},false));
    await within(()=>input.insertText('Team docs'));
    const point=await within(()=>input.evaluate(scoped+`if(row('Selected folders').querySelector('textarea').value!=='Team docs')throw Error('native selected text differs');const buttons=[...row('Save on this device').querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.textContent.trim()==='Save');if(buttons.length!==1)throw Error('ordinary scope save identity');const b=buttons[0];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||(hit!==b&&!b.contains(hit)))throw Error('scope Save pointer target blocked');return {x,y};`,{marker},false));
    await within(()=>input.mouseEvent('mousePressed',point.x,point.y));await within(()=>input.mouseEvent('mouseReleased',point.x,point.y));
    await within(()=>ui(`await wait(()=>!p.changingScope&&JSON.stringify(p.state.data.syncFolders)===JSON.stringify(['Team docs']),'scope save',Math.max(0,P.deadline-Date.now()));return true;`,{deadline:deadline-1000}));
    saved=true;
  } finally {
    try {await within(()=>c.evaluate(`const docs=[...new Set([document,app.setting?.modalEl?.ownerDocument].filter(d=>d&&!d.defaultView?.closed))];for(const d of docs)for(const e of d.querySelectorAll('[data-obsync-owned-scope]'))if(e.getAttribute('data-obsync-owned-scope')===P.marker)e.removeAttribute('data-obsync-owned-scope');if(P.close)app.setting.close();return true;`,{marker,close:saved}),true);}
    finally {for(const candidate of connections)candidate.close();}
  }
}
async function pointer(selector, text=null, button='left') {
  const point=await ui(`const e=one(P.selector,P.text);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`,{selector,text});
  await c.mouseEvent('mousePressed',point.x,point.y,button);
  await c.mouseEvent('mouseReleased',point.x,point.y,button);
}
async function exactBytes(folder) {
  const names=readdirSync(state.devices.A.vault);
  if(names.filter(n=>n.toLowerCase()==='team docs').length!==1||!names.includes(folder))throw Error('exact selected folder case');
  const notes=['one','two'].map(label=>JSON.parse(privateRead(join(state.secrets,`note-selected-${label}.json`))));
  for(const note of notes){const path=join(state.devices.A.vault,folder,note.path.split('/').at(-1));owned(path,false,false);if(readFileSync(path,'utf8')!==note.text)throw Error('selected descendant disk bytes');}
  const local=JSON.parse(privateRead(join(state.secrets,'note-selected-outside.json'))),path=join(state.devices.A.vault,local.path);
  owned(path,false,false);if(readFileSync(path,'utf8')!==local.text)throw Error('local excluded bytes changed');
  if(existsSync(join(state.devices.A.vault,'Outside/Phone-sentinel.md')))throw Error('foreign excluded file received');
  const trash=join(state.devices.A.vault,'.trash');if(existsSync(trash)){owned(trash,true,false);if(readdirSync(trash).length)throw Error('owned trash nonempty');}
  return notes.map(n=>({suffix:n.path.split('/').at(-1),sha256:digest(n.text)}));
}
async function snapshot(folder) {
  const disk=await exactBytes(folder);
  const value=await ui(`await wait(()=>!p.changingScope&&JSON.stringify(p.state.data.syncFolders)===JSON.stringify([P.folder])&&p.currentStatus().kind==='idle','selected idle policy',60000);
    if(app.vault.getAbstractFileByPath('Outside/Phone-sentinel.md')||p.state.fileByPath('Outside/Sentinel.md'))throw Error('excluded boundary indexed or tracked');
    const notes=[];for(const expected of P.disk){const r=p.state.fileByPath(P.folder+'/'+expected.suffix);if(!/^[a-f0-9]{32}$/.test(r?.fileId??'')||!/^[a-f0-9]{64}$/.test(r?.versionId??''))throw Error('selected identity absent');notes.push({...expected,fileId:r.fileId,versionId:r.versionId});}
    const page=await p.transport.listFiles(null,{interactive:true});if(page.next!==null||page.files.length<3||page.files.length>64)throw Error('selected bounded complete inventory');
    const records=[];for(const f of page.files){const file=await p.transport.getFile(f.file_id,{interactive:true});if(file.versions.length>128||JSON.stringify(file).length>1048576)throw Error('selected history budget');records.push({fileId:f.file_id,heads:[...file.heads].sort(),versions:file.versions.map(v=>({id:v.version_id,parents:[...v.parents].sort(),deleted:v.deleted})).sort((a,b)=>a.id.localeCompare(b.id))});}
    records.sort((a,b)=>a.fileId.localeCompare(b.fileId));return {generation:p.state.custody2().generation,notes,records};`,{folder,disk});
  await exactBytes(folder);return {schema:1,sourceHead:state.source_head,folder,...value};
}
function checkedSnapshot(snapshot){
    if(!/^[a-f0-9]{40}$/.test(snapshot.sourceHead??'')||!/^[a-f0-9]{32}$/.test(snapshot.generation??'')||
       !Array.isArray(snapshot.notes)||snapshot.notes.length!==2||new Set(snapshot.notes.map(n=>n.fileId)).size!==2||
       JSON.stringify(snapshot.notes.map(n=>n.suffix).sort())!==JSON.stringify(['One.md','Two.md'])||!Array.isArray(snapshot.records)||
       new Set(snapshot.records.map(r=>r.fileId)).size!==snapshot.records.length)throw Error('selected snapshot incomplete');
    for(const note of snapshot.notes){
      if(!/^[a-f0-9]{64}$/.test(note.sha256??'')||!/^[a-f0-9]{32}$/.test(note.fileId??'')||!/^[a-f0-9]{64}$/.test(note.versionId??''))throw Error('selected note binding invalid');
      const records=snapshot.records.filter(r=>r.fileId===note.fileId);
      const record=records[0];
      if(records.length!==1||JSON.stringify(record.heads)!==JSON.stringify([note.versionId])||!Array.isArray(record.versions)||
         record.versions.length<1||record.versions.length>128||new Set(record.versions.map(v=>v.id)).size!==record.versions.length||
         !record.versions.some(v=>v.id===note.versionId))throw Error('selected history absent');
      for(const version of record.versions){
        if(!/^[a-f0-9]{64}$/.test(version.id??'')||version.deleted!==false||!Array.isArray(version.parents)||version.parents.length>128||
           new Set(version.parents).size!==version.parents.length||version.parents.some(id=>!/^[a-f0-9]{64}$/.test(id)||!record.versions.some(v=>v.id===id)))throw Error('selected note tombstone or incomplete ancestry');
      }
      for(const version of record.versions)ancestry(record,version.id); // cycles fail even in equal snapshots
    }
}
function ancestry(record,head){
  const found=new Set(),visiting=new Set();
  const visit=id=>{if(visiting.has(id))throw Error('selected ancestry cycle');if(found.has(id))return;const version=record.versions.find(v=>v.id===id);if(!version)throw Error('selected ancestry missing');visiting.add(id);for(const parent of version.parents)visit(parent);visiting.delete(id);found.add(id);};
  visit(head);return found;
}
export function preservedRename(before,after){
  checkedSnapshot(before);checkedSnapshot(after);
  const identities=s=>s.notes.map(({suffix,fileId,sha256})=>({suffix,fileId,sha256}));
  if(before.sourceHead!==after.sourceHead||before.generation!==after.generation||JSON.stringify(identities(before))!==JSON.stringify(identities(after)))throw Error('selected note identities or bytes changed');
  for(const note of before.notes){
    const old=before.records.find(r=>r.fileId===note.fileId),current=after.records.find(r=>r.fileId===note.fileId),head=after.notes.find(n=>n.fileId===note.fileId).versionId;
    if(before.folder!==after.folder&&note.versionId===head)throw Error('renamed path manifest was not published');
    const reachable=ancestry(current,head);
    if(!reachable.has(note.versionId))throw Error('rename lost prior head ancestry');
    for(const version of old.versions){if(JSON.stringify(current.versions.find(v=>v.id===version.id))!==JSON.stringify(version))throw Error('rename lost or changed prior history');}
    for(const version of current.versions){if(!old.versions.some(v=>v.id===version.id)&&!reachable.has(version.id))throw Error('rename added detached history');}
  }
}
export function unchangedQuiet(before,after){
  checkedSnapshot(before);checkedSnapshot(after);
  if(before.sourceHead!==after.sourceHead||before.generation!==after.generation||before.folder!==after.folder||
     JSON.stringify(before.notes)!==JSON.stringify(after.notes)||JSON.stringify(before.records)!==JSON.stringify(after.records))throw Error('quiet server heads or histories changed');
}
async function main(){
try {
  if(!['scope','rename','before','returned','watch-down','watch-up'].includes(command)||index!==undefined)throw Error('finite selected desktop command');
  state=boundManifest(run,source);c=await connect(state,'A');
  if(command==='scope'){
    await selectedScope();
  }else if(command==='rename'){
    const before=await snapshot('Team docs');privateSave(join(state.secrets,'selected-original.json'),JSON.stringify(before));
    await ui(`app.setting.close();const leaves=app.workspace.getLeavesOfType('file-explorer');if(leaves.length!==1)throw Error('one Files view required');await app.workspace.revealLeaf(leaves[0]);await wait(()=>{const e=document.querySelector('.nav-folder-title[data-path="Team docs"]');return e&&visible(e);},'visible selected folder');return true;`);
    await pointer('.nav-folder-title[data-path="Team docs"]',null,'right');
    await ui(`await wait(()=>[...document.querySelectorAll('.menu-item-title')].filter(visible).some(e=>e.textContent.trim()==='Rename...'),'ordinary folder context menu');return true;`);
    await pointer('.menu-item-title','Rename...');
    await ui(`const e=await wait(()=>document.querySelector('.nav-folder-title.is-being-renamed .nav-folder-title-content'),'native inline folder rename');if(!e.isContentEditable||e.textContent!=='Team docs')throw Error('native folder title identity');e.focus();const range=document.createRange(),s=document.getSelection();range.selectNodeContents(e);s.removeAllRanges();s.addRange(range);if(s.toString()!=='Team docs')throw Error('folder title selection');return true;`);
    await c.insertText('team docs');await c.keyEvent('keyDown','Enter','Enter');await c.keyEvent('keyUp','Enter','Enter');
    await sleep(500);const after=await snapshot('team docs');preservedRename(before,after);
  }else if(command==='before'){
    const current=await snapshot('team docs');preservedRename(JSON.parse(privateRead(join(state.secrets,'selected-original.json'))),current);
    privateSave(join(state.secrets,'selected-before-return.json'),JSON.stringify(current));
  }else if(command==='returned'){
    const end=Date.now()+60000;while(!readdirSync(state.devices.A.vault).includes('Team docs')){if(Date.now()>end)throw Error('passive selected case return');await sleep(100);}
    const current=await snapshot('Team docs');preservedRename(JSON.parse(privateRead(join(state.secrets,'selected-before-return.json'))),current);
    privateSave(join(state.secrets,'selected-watch.json'),JSON.stringify(current));
  }else{
    const folder=command==='watch-down'?'team docs':'Team docs';
    const before=JSON.parse(privateRead(join(state.secrets,command==='watch-down'?'selected-before-return.json':'selected-watch.json'))),start=performance.now();
    for(let i=0;i<=10;i++){
      if(i)await sleep(30000);
      const current=await snapshot(folder);unchangedQuiet(before,current);
    }
    watchElapsed=Math.floor(performance.now()-start);if(watchElapsed<300000)throw Error('selected watch too short');
    const logs=c.consoleSummary;
    if(!Number.isFinite(logs.windowStartedAtEpochMs)||!['windowErrors','windowExceptions','incomingManifestScopeRefusals'].every(key=>Number.isInteger(logs[key])&&logs[key]>=0))throw Error('scoped selected log coverage absent');
    if(logs.windowExceptions||logs.windowErrors||logs.incomingManifestScopeRefusals)throw Error('selected incoming manifest or native console failure');
  }
  const receipt={schema:1,result:'PASS',sourceHead:state.source_head,command,watchMs:watchElapsed,
    ordinaryUiAction:command==='scope'||command==='rename',nativeTrustedInput:command==='scope'||command==='rename',
    independentDiskBytes:command!=='scope',selectedIdentityAndBytesPreserved:command!=='scope',priorHistoryAndAncestryPreserved:command!=='scope',
    historiesAndHeadsUnchanged:command.startsWith('watch-'),noteTombstonesAbsent:command!=='scope',
    logCoverage:command.startsWith('watch-')?'OBSERVED':'NOT_MEASURED',incomingManifestScopeRefusals:command.startsWith('watch-')?c.consoleSummary.incomingManifestScopeRefusals:undefined,
    excludedControlsPreserved:command!=='scope',trashEmpty:command!=='scope',physicalPhone:'NOT_RUN'};
  writeFileSync(join(state.run,'evidence',`selected-desktop-${command}.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));
}catch{console.log(JSON.stringify({result:'FAIL',stage:'selected-desktop-'+command,detail:'Owned selected UI or independent boundary refused.'}));process.exitCode=1;}
finally{c?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
