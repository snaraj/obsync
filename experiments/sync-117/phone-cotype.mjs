import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [tooling,run,caseName,command,phoneEndedAt]=process.argv.slice(2);
if(!/^phone-live-cotype[0-9]{1,2}$/.test(caseName??''))throw Error('bounded case name required');
const {manifest,connect,sleep}=await import(pathToFileURL(resolve(tooling,'scripts/validation/lab/cdp.mjs')));
const state=manifest(run),c=await connect(state,'A'),path=caseName+'.md';
const base='Desktop control 42\nphone7\n',upper='ABCDEFGHIJKLMNOPQRSTUVWXYZ',lower='abcdefghijklmnopqrstuvwxyz';
const save=(name,value)=>writeFileSync(join(run,'evidence',name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});
try{
 if(command==='prepare'){
  await c.evaluate(`if(document.querySelector('.modal-container')||app.vault.getAbstractFileByPath(P.path))throw Error('fresh note precondition');const f=await app.vault.create(P.path,'');const leaf=app.workspace.getLeaf(false);await leaf.openFile(f,{state:{mode:'source'}});await wait(()=>!!leaf.view.editor,'native editor');leaf.view.editor.focus();leaf.view.editor.setCursor({line:0,ch:0});return true;`,{path});
  await c.insertText(base);
  await c.evaluate(`await wait(()=>app.workspace.getMostRecentLeaf()?.view?.file?.path===P.path&&app.workspace.getMostRecentLeaf().view.editor.getValue()===P.base,'native base');await wait(()=>/^[a-f0-9]{32}$/.test(app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path)?.fileId??''),'note identity',60000);return true;`,{path,base});
  const deadline=Date.now()+30000;while(readFileSync(join(state.devices.A.vault,path),'utf8')!==base){if(Date.now()>deadline)throw Error('base disk deadline');await sleep(100);}
  const result={result:'PREPARED',at:new Date().toISOString(),path,base,nativeEditorAndIndependentDiskMatch:true};save(caseName+'-prepared',result);console.log(JSON.stringify(result));
 }else if(command==='run'){
  const initial=await c.evaluate(`if(document.querySelector('.modal-container'))throw Error('dialog owns native editor');const view=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file?.path===P.path);if(view?.editor?.getValue()!==P.base)throw Error('shared baseline differs');const id=app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path)?.fileId;if(!/^[a-f0-9]{32}$/.test(id??''))throw Error('missing identity');return {id,lineCount:view.editor.getValue().split(String.fromCharCode(10)).length};`,{path,base});
  if(initial.lineCount!==3)throw Error('native newline semantics mismatch');
  if(readFileSync(join(state.devices.A.vault,path),'utf8')!==base)throw Error('initial independent disk differs');
  const readyAt=Date.now(),goPath=join(run,'runtime',caseName+'-go.json');let go;
  console.log(JSON.stringify({result:'READY',readyAt,nativeLineCount:initial.lineCount,goFile:'runtime/'+caseName+'-go.json',goShape:{startedAt:'Date.now()'},startDeadlineSeconds:120}));
  while(Date.now()<readyAt+120000){
   try{const stat=lstatSync(goPath);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid()||stat.size>200)throw Error('go custody');go=JSON.parse(readFileSync(goPath,'utf8'));if(!Number.isSafeInteger(go.startedAt)||go.startedAt<readyAt||go.startedAt>Date.now())throw Error('go timestamp');break;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
   await sleep(25);
  }
  if(!go)throw Error('start signal deadline');
  await c.evaluate(`window.labPhoneFocus={startedAt:Date.now(),samples:[{at:Date.now(),stage:'armed',hasFocus:document.hasFocus()}],overflow:false};window.labPhoneFocusSample=stage=>{const t=window.labPhoneFocus;if(t.samples.length<512)t.samples.push({at:Date.now(),stage,hasFocus:document.hasFocus()});else t.overflow=true;};window.labPhoneWindowListener=e=>window.labPhoneFocusSample(e.type);window.addEventListener('focus',window.labPhoneWindowListener);window.addEventListener('blur',window.labPhoneWindowListener);window.labPhoneCotype={trusted:0,untrusted:0};window.labPhoneCotypeListener=e=>window.labPhoneCotype[e.isTrusted?'trusted':'untrusted']++;document.addEventListener('beforeinput',window.labPhoneCotypeListener,true);return true;`);
  const receipt={result:'RUNNING',path,base,sequence:upper,cadenceMs:800,initialFileId:initial.id,readyAt,goAt:go.startedAt,startedAt:Date.now(),timeline:[]};
  save(caseName+'-A-input',receipt);console.log(JSON.stringify({result:'STARTED',startedAt:receipt.startedAt,count:26,cadenceMs:800}));
  try{
   for(const character of upper){const tick=Date.now();await c.evaluate(`if(document.querySelector('.modal-container'))throw Error('dialog owns native editor');const leaf=app.workspace.getMostRecentLeaf();if(leaf?.view?.file?.path!==P.path||!leaf.view.editor)throw Error('native note changed');const e=leaf.view.editor;if(e.getValue().split(String.fromCharCode(10)).length!==3)throw Error('line count changed');window.labPhoneFocusSample('before-editor-focus');e.focus();e.setCursor({line:2,ch:e.getLine(2).length});window.labPhoneFocusSample('after-editor-focus');return true;`,{path});const sentAt=Date.now();await c.insertText(character);const acknowledgedAt=Date.now();receipt.timeline.push({character,sentAt,acknowledgedAt});save(caseName+'-A-input',receipt);await sleep(Math.max(0,800-(Date.now()-tick)));}
  }finally{receipt.nativeInput=await c.evaluate(`document.removeEventListener('beforeinput',window.labPhoneCotypeListener,true);window.labPhoneFocusSample('finished');window.removeEventListener('focus',window.labPhoneWindowListener);window.removeEventListener('blur',window.labPhoneWindowListener);const result={...window.labPhoneCotype,focus:window.labPhoneFocus};delete window.labPhoneWindowListener;delete window.labPhoneFocus;delete window.labPhoneFocusSample;delete window.labPhoneCotypeListener;delete window.labPhoneCotype;return result;`);receipt.endedAt=receipt.timeline.at(-1)?.acknowledgedAt??Date.now();receipt.result=receipt.timeline.length===26&&receipt.nativeInput.trusted===26&&receipt.nativeInput.untrusted===0?'INPUT_COMPLETE':'FAIL';save(caseName+'-A-input',receipt);console.log(JSON.stringify({result:receipt.result,endedAt:receipt.endedAt,count:receipt.timeline.length,nativeInput:{trusted:receipt.nativeInput.trusted,untrusted:receipt.nativeInput.untrusted},focusSamples:receipt.nativeInput.focus.samples.length}));}
  if(receipt.result!=='INPUT_COMPLETE')process.exitCode=1;
 }else if(command==='observe'){
  const source=JSON.parse(readFileSync(join(run,'evidence',caseName+'-A-input.json'),'utf8')),lastPhone=Number(phoneEndedAt);
  if(source.result!=='INPUT_COMPLETE'||!Number.isSafeInteger(lastPhone)||lastPhone<source.startedAt||lastPhone>Date.now())throw Error('last phone input timestamp refused');
  const deadline=Math.max(lastPhone,source.endedAt)+120000,samples=[];let proof,disk,native;
  if(Date.now()>deadline)throw Error('observation began beyond frozen deadline');
  do{
   disk=readFileSync(join(state.devices.A.vault,path),'utf8');native=await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'],view=app.workspace.getLeavesOfType('markdown').map(l=>l.view).find(v=>v.file?.path===P.path);return {text:view?.editor?.getValue()??null,id:p.state.fileByPath(P.path)?.fileId??null,status:p.currentStatus().kind};`,{path});
   const suffix=disk.startsWith(base)?disk.slice(base.length):'',copies=readdirSync(state.devices.A.vault).filter(n=>n.startsWith(path.slice(0,-3)));
   proof={fixedPrefixIntact:disk.startsWith(base),desktopEditorMatchesIndependentDisk:native.text===disk,exactlyOnceAndPerStreamOrder:suffix.length===52&&[...suffix].filter(x=>upper.includes(x)).join('')===upper&&[...suffix].filter(x=>lower.includes(x)).join('')===lower,oneFileNoConflict:copies.length===1&&copies[0]===path,sameNonemptyFileId:native.id===source.initialFileId&&/^[a-f0-9]{32}$/.test(native.id??'')};
   samples.push({at:Date.now(),bytes:Buffer.byteLength(disk),...proof});if(Object.values(proof).every(Boolean))break;await sleep(250);
  }while(Date.now()<deadline);
  const result={at:new Date().toISOString(),result:Object.values(proof).every(Boolean)?'PASS':'FAIL',path,deadline,phoneLastInputAt:lastPhone,desktopLastInputAt:source.endedAt,bytes:Buffer.byteLength(disk),sha256:createHash('sha256').update(disk).digest('hex'),...proof,samples,physicalPhoneFinalBuffer:'ROOT_NATIVE_READBACK_REQUIRED'};save(caseName+'-A-observation',result);writeFileSync(join(run,'evidence',caseName+'-A-final.txt'),disk,{mode:0o600});console.log(JSON.stringify({...result,samples:undefined,text:disk}));if(result.result!=='PASS')process.exitCode=1;
 }else throw Error('unknown command');
}catch{console.log(JSON.stringify({result:'FAIL',reason:'native co-type step refused or frozen deadline elapsed'}));process.exitCode=1;}finally{c.close();}
