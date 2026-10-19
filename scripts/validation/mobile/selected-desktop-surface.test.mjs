import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(process.env.OBSYNC_SELECTED_SCOPE_SOURCE??new URL('./selected-desktop.mjs',import.meta.url),'utf8');
const prelude=/const uiPrelude = `([\s\S]*?)`;/.exec(source)?.[1];
const scope=/ui\(`(app\.setting\.open\(\);[\s\S]*?return true;)`/.exec(source)?.[1];
assert.ok(prelude&&scope,'actual selected Settings action must be present');
const render=new Function('app','document','P','wait','Date','return (async()=>{'+prelude+'\n'+scope+'})()');
const execute=(app,document,P,wait)=>render(app,document,{deadline:30000,...P},wait,{now:()=>0});
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const cdpSource=readFileSync(new URL('./cdp.mjs',import.meta.url),'utf8');
const evaluateStart=cdpSource.indexOf('  async function evaluate(body, params = {}, checkVault = true) {');
const evaluateEnd=cdpSource.indexOf('\n  async function screenshot(',evaluateStart);
assert.ok(evaluateStart>=0&&evaluateEnd>evaluateStart,'actual CDP evaluator required');
const cdpEvaluate=new Function('send','device','state','scriptJson',cdpSource.slice(evaluateStart,evaluateEnd)+';return evaluate;');
const uiStart=source.indexOf('const ui = async '),uiEnd=source.indexOf('\nasync function selectedScope()',uiStart);
assert.ok(uiStart>=0&&uiEnd>uiStart,'actual scope diagnostic wrapper required');
test('scope renderer diagnostics allow fixed refusal codes without exporting exception text',async()=>{
  const f=fixture();f.app.workspace={};
  const c={evaluate:(body,P)=>new AsyncFunction('app','document','P',body)(f.app,f.main,{url:'owned-url',...P})};
  const ui=new Function('c','uiPrelude','command',source.slice(uiStart,uiEnd)+';return ui;')(c,prelude,'scope');
  await assert.rejects(ui("throw Error('selected setting identity');"),/^Error: scope-renderer-ROW_IDENTITY$/);
  await assert.rejects(ui("throw Error(P.sensitive);",{sensitive:'synthetic exception text must stay private'}),/^Error: scope-renderer-RENDERER_REFUSAL$/);
  await assert.rejects(ui("throw TypeError(P.sensitive);",{sensitive:'synthetic exception text must stay private'}),/^Error: scope-renderer-RENDERER_TYPE_ERROR$/);
});
test('actual CDP prelude compiles every selected scope renderer without lexical collisions',async()=>{
  const scoped=/const scoped=`([\s\S]*?)`;/.exec(source)?.[1];assert.ok(scoped);
  const bodies=[prelude+scope,...[...source.matchAll(/input\.evaluate\(scoped\+`([\s\S]*?)`/g)].map(match=>scoped+match[1])];
  assert.equal(bodies.length,3,'initial pane and both native target renderers covered');
  const evaluate=cdpEvaluate(async(method,{expression})=>{assert.equal(method,'Runtime.evaluate');assert.doesNotThrow(()=>new Function(expression));return {result:{result:{value:true}}};},{vault:'owned-vault'},{run:'owned-run',url:'owned-url'},JSON.stringify);
  for(const body of bodies)assert.equal(await evaluate(body,{deadline:30000,marker:'scope-marker'},false),true);
  for(const match of source.matchAll(/\bui\(`([\s\S]*?)`/g))assert.equal(await evaluate(prelude+match[1],{},false),true);
});
const begin=source.indexOf('async function selectedScope() {'),end=source.indexOf('\nasync function pointer(',begin);
assert.ok(begin>=0&&end>begin,'actual complete scope action required');
const fullAction=new AsyncFunction('ui','c','state','targets','connect','randomUUID','Date','setTimeout','clearTimeout','let scopeDeadline,scopeStage;'+source.slice(begin,end)+';return selectedScope();');
function fixture({detached=true,closed=false,duplicate=false,missing=false,missingRows=false}={}){
  const counters={focus:0,select:0,change:0,globalRows:0,save:0};
  const availability={missing,missingRows},attrs=new Map();
  const visible={getBoundingClientRect:()=>({x:20,y:30,width:10,height:10})};
  const main={defaultView:{closed:false},querySelectorAll(selector){if(selector==='.setting-item'){counters.globalRows++;return [];}if(selector==='[data-obsync-owned-scope]')return !detached&&attrs.size?[pane]:[];return !detached&&selector==='.mod-settings .vertical-tab-content'&&!availability.missing?[pane]:[];},elementFromPoint:()=>null};
  class SettingsEvent{constructor(type,options){this.type=type;this.bubbles=options.bubbles;}}
  const owner={defaultView:{closed,Event:SettingsEvent},querySelectorAll:selector=>selector==='[data-obsync-owned-scope]'?(attrs.size?[pane]:[]):selector==='.mod-settings .vertical-tab-content'&&!availability.missing?(duplicate?[pane,pane]:[pane]):[],elementFromPoint:()=>save};
  const doc=detached?owner:main;
  const dropdown={options:[{textContent:'Selected folders only',value:'selected'}],ownerDocument:doc,dispatchEvent(event){assert.ok(event instanceof SettingsEvent);assert.equal(event.type,'change');assert.equal(event.bubbles,true);counters.change++;}};
  const textarea={value:'',disabled:false,focus(){counters.focus++;doc.activeElement=this;},select(){counters.select++;}};
  const p={state:{paired:true,custody2:()=>({phase:'active'}),data:{serverUrl:'owned-url',syncFolders:undefined}},changingScope:false};
  const save={...visible,textContent:'Save',disabled:false,scrollIntoView(){},contains:()=>false};
  const rows=[['Folder selection','select',dropdown],['Selected folders','textarea',textarea],['Save on this device','button',save]].map(([name,selector,input])=>({...visible,querySelector:s=>s==='.setting-item-name'?{textContent:name}:s===selector?input:null,querySelectorAll:s=>s==='button'&&selector==='button'?[save]:[]}));
  const pane={...visible,isConnected:true,matches:selector=>selector==='.mod-settings .vertical-tab-content',hasAttribute:k=>attrs.has(k),getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),querySelectorAll:selector=>selector==='.setting-item'&&!availability.missingRows?rows:[]};
  if(!detached){main.defaultView.Event=SettingsEvent;main.elementFromPoint=()=>save;}
  const app={plugins:{plugins:{'obsync-private-sync':p}},setting:{modalEl:{isConnected:true,ownerDocument:doc},open(){},openTabById(id){assert.equal(id,'obsync-private-sync');},close(){assert.equal(attrs.size,0,'remove marker before closing its document');doc.defaultView.closed=true;}}};
  return {app,main,owner,doc,p,pane,attrs,counters,dropdown,textarea,save,availability};
}
test('actual first Settings renderer uses either owned document and owner-realm change',async()=>{
  for(const detached of [true,false]){
    const f=fixture({detached});assert.equal(await execute(f.app,f.main,{url:'owned-url'},async read=>read()),true);
    assert.equal(f.dropdown.value,'selected');assert.deepEqual(f.counters,{focus:1,select:1,change:1,globalRows:0,save:0});
  }
});
test('actual first Settings renderer refuses absent, closed or ambiguous owned pane before input',async()=>{
  for(const options of [{missing:true},{closed:true},{duplicate:true}]){
    const f=fixture(options);await assert.rejects(execute(f.app,f.main,{url:'owned-url'},async read=>read()),/selected settings pane identity/);
    assert.equal(f.counters.change,0);assert.equal(f.counters.focus,0);
  }
});
test('first Settings renderer passively waits within the supplied original deadline',async()=>{
  const f=fixture({missing:true});let clock=0,polls=0;
  const wait=async(read,stage,ms)=>{const end=clock+ms;while(clock<end){polls++;if(clock===200)f.availability.missing=false;const value=read();if(value)return value;assert.equal(f.counters.change,0);clock+=100;}throw Error(stage);};
  await execute(f.app,f.main,{url:'owned-url'},wait);assert.equal(clock,200);assert.equal(polls,3);
  const absent=fixture({missing:true});clock=0;polls=0;
  const never=async(read,stage,ms)=>{const end=clock+ms;while(clock<end){polls++;if(read())return true;clock+=100;}throw Error(stage);};
  await assert.rejects(execute(absent.app,absent.main,{url:'owned-url'},never),/folder settings/);assert.equal(clock,30000);assert.equal(polls,300);assert.equal(absent.counters.change,0);
});
test('an already visible Settings pane waits for its rows before changing any control',async()=>{
  const f=fixture({missingRows:true});let clock=0,polls=0;
  const wait=async(read,stage,ms)=>{const end=clock+ms;while(clock<end){polls++;if(clock===200)f.availability.missingRows=false;const value=read();if(value)return value;assert.equal(f.counters.change,0);clock+=100;}throw Error(stage);};
  await execute(f.app,f.main,{url:'owned-url'},wait);assert.equal(clock,200);assert.equal(polls,3);assert.equal(f.counters.change,1);
  const absent=fixture({missingRows:true});clock=0;
  const never=async(read,stage,ms)=>{const end=clock+ms;while(clock<end){if(read())return true;clock+=100;}throw Error(stage);};
  await assert.rejects(execute(absent.app,absent.main,{url:'owned-url'},never),/folder settings/);assert.equal(clock,30000);assert.equal(absent.counters.change,0);
});
async function scenario(mode='separate'){
  const f=fixture({detached:mode!=='main'}),calls=[],connections=[];let clock=0,waitBudget,hung=false;
  if(mode==='blocked')f.doc.elementFromPoint=()=>({});
  if(mode==='offscreen')f.save.getBoundingClientRect=()=>({x:2000,y:20,width:10,height:10});
  const wait=async(read,stage,ms=30000)=>{waitBudget=ms;while(clock<29000){if(await read())return true;clock+=100;}throw Error(stage);};
  const evaluate=(doc,body,P={})=>new AsyncFunction('app','document','P','wait','Date','innerWidth','innerHeight',body)(f.app,doc,{url:'owned-url',...P},wait,{now:()=>clock},1024,768);
  const ui=async(body,P)=>{const value=await evaluate(f.main,prelude+body,P);if(mode==='late-save'&&body.includes("'scope save'"))clock=29500;return value;};
  function client(name,doc){
    const c={name,evaluate:async(body,P)=>{const value=await evaluate(doc,body,P);if(mode==='changed'&&value===true&&body.includes('return roots.length===1'))f.pane.isConnected=false;return value;},close(){calls.push(['close',name]);},async insertText(text){calls.push(['text',name]);if(doc.activeElement===f.textarea&&mode!=='text-dropped')f.textarea.value=text;},async mouseEvent(type,x,y){calls.push([type,name]);if(type==='mouseReleased'&&doc.elementFromPoint(x,y)===f.save){f.counters.save++;if(mode!=='save-refused')f.p.state.data.syncFolders=[f.textarea.value];}}};connections.push(c);return c;
  }
  const main=client('main-initial',f.main);
  const targets=async(state,name)=>{assert.equal(name,'A');if(mode==='hung'){hung=true;return new Promise(()=>{});}if(mode==='slow')clock=28000;return mode==='missing'?[{id:'main'}]:mode==='duplicate'?[{id:'main'},{id:'settings'},{id:'clone'}]:mode==='main'?[{id:'main'}]:[{id:'main'},{id:'settings'}];};
  const connect=async(state,name,chooser,id)=>{assert.equal(name,'A');assert.equal(chooser,false);if(mode==='slow')clock+=1500;return client(id,id==='main'?f.main:f.doc);};
  let timerId=0;const timers=new Map();
  const setTimeout=(fn,ms)=>{const id=++timerId;timers.set(id,true);if(hung&&ms>1000)queueMicrotask(()=>{if(timers.has(id)){clock+=ms;fn();}});return id;};
  const clearTimeout=id=>timers.delete(id);
  try{await fullAction(ui,main,{},targets,connect,()=> 'scope-marker',{now:()=>clock},setTimeout,clearTimeout);return {f,calls,clock,waitBudget};}
  catch(error){return {f,calls,clock,error};}
  finally{assert.equal(f.attrs.size,0,'temporary owned DOM marker removed on every exit');assert.equal(timers.size,0,'deadline timer cleared');for(const {name} of connections)if(name!=='main-initial')assert.ok(calls.some(c=>c[0]==='close'&&c[1]===name),'all temporary connections closed');}
}
test('complete scope action sends native text and Save only to the exact marker-bound page, then checks persisted policy',async()=>{
  for(const mode of ['main','separate']){
    const {f,calls,error}=await scenario(mode);assert.equal(error,undefined);assert.deepEqual(f.p.state.data.syncFolders,['Team docs']);assert.equal(f.counters.save,1);assert.equal(f.doc.defaultView.closed,true);
    assert.deepEqual(calls.filter(c=>c[0]!=='close'),[['text',mode==='main'?'main':'settings'],['mousePressed',mode==='main'?'main':'settings'],['mouseReleased',mode==='main'?'main':'settings']]);
  }
});
test('missing/duplicate target, elapsed discovery and hung lookup refuse before native actions and always clean marker',async()=>{
  for(const mode of ['missing','duplicate','slow','hung']){
    const {error,calls,clock}=await scenario(mode);assert.ok(error,mode);assert.equal(calls.some(c=>c[0]==='text'||c[0].startsWith('mouse')),false,mode);assert.ok(clock<=30000,mode);
  }
});
test('native Save without actual saved syncFolders fails the original remaining deadline',async()=>{
  const {f,error,clock}=await scenario('save-refused');assert.ok(error);assert.equal(f.counters.save,1);assert.equal(f.p.state.data.syncFolders,undefined);assert.equal(clock,29000);
});
test('changed pane, blocked/offscreen Save and a late completion cannot claim native scope success',async()=>{
  for(const mode of ['changed','blocked','offscreen','late-save']){
    const {error,calls,clock}=await scenario(mode);assert.ok(error,mode);assert.ok(clock<=30000,mode);
    if(mode!=='late-save')assert.equal(calls.some(c=>c[0].startsWith('mouse')),false,mode);
  }
});
test('native text is independently observed before any Save input',async()=>{
  const {error,calls}=await scenario('text-dropped');assert.match(error?.message??'',/native selected text differs/);
  assert.equal(calls.some(c=>c[0].startsWith('mouse')),false);
});

const renameStart=source.indexOf("    renameStage='snapshot-original';"),renameEnd=source.indexOf("  }else if(command==='before'){",renameStart);
assert.ok(renameStart>=0&&renameEnd>renameStart,'complete ordinary rename action required');
const renameAction=new AsyncFunction('ui','c','state','snapshot','privateSave','join','pointer','sleep','preservedRename','retainedSnapshots','retainSelectedSnapshot','let renameStage;'+source.slice(renameStart,renameEnd)+';return renameStage;');
const pointerStart=source.indexOf('async function pointer('),pointerEnd=source.indexOf('\nasync function exactBytes(',pointerStart);
const nativePointer=new AsyncFunction('ui','c',source.slice(pointerStart,pointerEnd)+';return pointer;');
async function renameScenario(mode='normal'){
  const f=fixture(),calls=[];let focused=false,clicked=false,up=false,inline=false,committed=false,clock=0,selected=null;
  const tree={},foreign={getBoundingClientRect:()=>({width:10,height:10})},files={isConnected:mode!=='detached-view',contains:e=>e===tree||e===title,querySelectorAll:()=>mode==='foreign-selection'?[foreign]:[]};
  const leaf={view:{containerEl:mode==='wrong-view'?foreign:files}};f.main.body={};
  const title={getBoundingClientRect:()=>({x:20,y:30,width:80,height:20}),textContent:'Team docs',isContentEditable:false,scrollIntoView(){},getAttribute:()=>mode==='wrong-focus'?'Other':'Team docs',closest:()=>files,focus(){f.main.activeElement=this;}};
  f.app.workspace={getLeavesOfType:()=>[leaf],revealLeaf:async()=>{},setActiveLeaf(value,options){assert.equal(options.focus,true);this.activeLeaf=mode==='wrong-leaf'?{}:value;}};
  f.main.querySelectorAll=selector=>selector==='.nav-folder-title[data-path="Team docs"]'?[title]:selector==='.nav-folder-title.has-focus'&&focused&&mode!=='missing-focus'?[title]:[];
  f.main.querySelector=selector=>selector==='.nav-folder-title[data-path="Team docs"]'?title:selector==='.nav-folder-title.is-being-renamed .nav-folder-title-content'&&inline?title:null;
  f.main.createRange=()=>({selectNodeContents:e=>{selected=e;}});f.main.getSelection=()=>({removeAllRanges(){selected=null;},addRange(){selected=title;},toString:()=>selected?.textContent??''});
  const wait=async(read,stage,ms=30000)=>{const end=clock+ms;while(clock<end){const value=await read();if(value)return value;clock+=100;}throw Error(stage);};
  const ui=(body,P={})=>new AsyncFunction('app','document','P','wait',prelude+body)(f.app,f.main,{url:'owned-url',...P},wait);
  const c={async mouseEvent(type,x,y,button){calls.push([type,button]);if(type==='mouseReleased'&&button==='left'){clicked=true;focused=false;f.main.activeElement=mode==='foreign-active'?foreign:mode==='body-active'?f.main.body:tree;}},async keyEvent(type,key){calls.push([type,key]);if(type==='keyDown'&&key==='ArrowUp'&&clicked)up=true;if(type==='keyDown'&&key==='ArrowDown'&&up&&mode!=='missing-focus')focused=true;if(type==='keyDown'&&key==='F2'&&mode!=='no-rename-event'){assert.ok(focused);inline=true;title.isContentEditable=true;}if(type==='keyDown'&&key==='Enter'&&mode!=='commit-dropped')committed=title.textContent==='team docs';},async insertText(text){calls.push(['text',text]);if(f.main.activeElement===title&&mode!=='text-dropped')title.textContent=text;}};
  const pointer=await nativePointer(ui,c),snapshots=[];
  const snapshot=async folder=>{snapshots.push(folder);if(folder==='team docs')assert.ok(committed,'independent renamed snapshot must exist');return {folder};};
  // This fixture isolates UI delivery; selected-retention.test exercises real files.
  const retained=[],retain=(run,label,value)=>{assert.equal(run,'owned-run');assert.equal(label,'original');assert.equal(value.folder,'Team docs');return {label};};
  try{await renameAction(ui,c,{run:'owned-run',secrets:'owned-private'},snapshot,()=>{},(...p)=>p.join('/'),pointer,async()=>{},(before,after)=>{assert.equal(before.folder,'Team docs');assert.equal(after.folder,'team docs');},retained,retain);assert.deepEqual(retained,[{label:'original'}]);return {calls,clock,snapshots};}
  catch(error){return {calls,clock,snapshots,error};}
}
test('ordinary Files rename focuses the exact folder and uses trusted F2/text/Enter before independent snapshots',async()=>{
  const {calls,snapshots,error}=await renameScenario();assert.equal(error,undefined);
  assert.equal((await renameScenario('body-active')).error,undefined,'official Files need no DOM descendant focus');
  assert.deepEqual(calls,[['mousePressed','left'],['mouseReleased','left'],['keyDown','ArrowUp'],['keyUp','ArrowUp'],['keyDown','ArrowDown'],['keyUp','ArrowDown'],['keyDown','F2'],['keyUp','F2'],['text','team docs'],['keyDown','Enter'],['keyUp','Enter']]);
  assert.deepEqual(snapshots,['Team docs','team docs']);
});
test('missing/wrong folder focus or foreign active element refuses before the rename key',async()=>{
  for(const mode of ['missing-focus','wrong-focus','foreign-active','wrong-leaf','wrong-view','detached-view','foreign-selection']){const {calls,error}=await renameScenario(mode);assert.ok(error,mode);assert.equal(calls.some(c=>c[1]==='F2'),false,mode);}
});
test('a missing native rename event retains the original 30s wait and cannot pass',async()=>{
  const {calls,error,clock}=await renameScenario('no-rename-event');assert.match(error?.message??'',/native inline folder rename/);assert.equal(clock,30000);assert.equal(calls.some(c=>c[0]==='text'),false);
});
test('dropped native text or Enter cannot claim a persisted ordinary rename',async()=>{
  for(const mode of ['text-dropped','commit-dropped']){const {error}=await renameScenario(mode);assert.match(error?.message??'',/independent renamed snapshot must exist/,mode);}
});
