import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const {connect,manifest}=await import(pathToFileURL(join(process.env.OBSYNC_LINUX_HARNESS,'cdp.mjs')));
import { writeFileSync } from 'node:fs';
const [run,label]=process.argv.slice(2),state=manifest(run),rows=[];
for(const name of ['A','B']) {
  const c=await connect(state,name);
  try { rows.push(await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];
    const raw=app.loadLocalStorage('secrets-encrypted'); let plain=false;
    try { plain=typeof raw==='string' && typeof JSON.parse(raw)==='object'; } catch {}
    const metadata=await p.loadData();
    const secret=app.secretStorage.getSecret(metadata.credentialRef);
    const envelope=secret===null?null:JSON.parse(secret);
    return {device:P.name,encrypted:app.secretStorage.isEncryptionAvailable(),backend:app.secretStorage.adapter?.getSelectedStorageBackend?.()??'none reported',
      stored:typeof raw==='string'&&raw.length>0,plain,paired:p.state.paired,metadataRevision:metadata.credentialRevision,
      secretRevision:envelope?.current?.revision??null,previousRevision:envelope?.previous?.revision??null,
      failure:p.state.failure?.reason??null,keysLost:p.state.keysLost,
      quitCommands:Object.keys(app.commands.commands).filter(id=>/(^|:)quit$/.test(id))};`,{name})); }
  finally {c.close();}
}
writeFileSync(run+'/evidence/custody-'+label+'.json',JSON.stringify(rows,null,2)+'\n');
if(rows.some(r=>!r.encrypted||r.backend!=='gnome_libsecret'||r.plain||!r.stored||!r.paired||r.metadataRevision!==r.secretRevision))throw Error('native encrypted custody assertion');
