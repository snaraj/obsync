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
const begin=source.indexOf('async function selectedScope() {'),end=source.indexOf('\nasync function pointer(',begin);
assert.ok(begin>=0&&end>begin,'actual complete scope action required');
const fullAction=new AsyncFunction('ui','c','state','targets','connect','randomUUID','Date','setTimeout','clearTimeout',source.slice(begin,end)+';return selectedScope();');
function fixture({detached=true,closed=false,duplicate=false,missing=false}={}){
  const counters={focus:0,select:0,change:0,globalRows:0,save:0};
  const availability={missing},attrs=new Map();
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
  const pane={...visible,isConnected:true,matches:selector=>selector==='.mod-settings .vertical-tab-content',hasAttribute:k=>attrs.has(k),getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),querySelectorAll:selector=>selector==='.setting-item'?rows:[]};
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
