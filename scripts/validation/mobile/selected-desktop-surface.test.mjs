import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('./selected-desktop.mjs',import.meta.url),'utf8');
const prelude=/const uiPrelude = `([\s\S]*?)`;/.exec(source)?.[1];
const scope=/await ui\(`(app\.setting\.open\(\);[\s\S]*?return true;)`\);/.exec(source)?.[1];
assert.ok(prelude&&scope,'actual selected Settings action must be present');
const execute=new Function('app','document','P','wait','return (async()=>{'+prelude+'\n'+scope+'})()');
function fixture({detached=true,closed=false,duplicate=false,missing=false}={}){
  const counters={focus:0,select:0,change:0,globalRows:0};
  const availability={missing};
  const visible={getBoundingClientRect:()=>({width:10,height:10})};
  const main={defaultView:{closed:false},querySelectorAll(selector){if(selector==='.setting-item'){counters.globalRows++;return [];}return !detached&&selector==='.mod-settings .vertical-tab-content'&&!availability.missing?[pane]:[];}};
  class SettingsEvent{constructor(type,options){this.type=type;this.bubbles=options.bubbles;}}
  const owner={defaultView:{closed,Event:SettingsEvent},querySelectorAll:selector=>selector==='.mod-settings .vertical-tab-content'&&!availability.missing?(duplicate?[pane,pane]:[pane]):[]};
  const dropdown={options:[{textContent:'Selected folders only',value:'selected'}],ownerDocument:owner,dispatchEvent(event){assert.ok(event instanceof SettingsEvent,'dropdown change must use the Settings document realm');assert.equal(event.type,'change');assert.equal(event.bubbles,true);counters.change++;}};
  const textarea={disabled:false,focus(){counters.focus++;},select(){counters.select++;}};
  const rows=[['Folder selection','select',dropdown],['Selected folders','textarea',textarea]].map(([name,selector,input])=>({...visible,querySelector:s=>s==='.setting-item-name'?{textContent:name}:s===selector?input:null}));
  const pane={...visible,querySelectorAll:selector=>selector==='.setting-item'?rows:[]};
  if(!detached){main.defaultView.Event=SettingsEvent;dropdown.ownerDocument=main;}
  const app={plugins:{plugins:{'obsync-private-sync':{state:{paired:true,custody2:()=>({phase:'active'}),data:{serverUrl:'owned-url'}}}}},setting:{modalEl:{isConnected:true,ownerDocument:detached?owner:main},open(){},openTabById(id){assert.equal(id,'obsync-private-sync');}}};
  return {app,main,counters,dropdown,availability};
}
test('actual selected Settings action uses live owned pane in either document and owner-realm change',async()=>{
  for(const detached of [true,false]){
    const f=fixture({detached});assert.equal(await execute(f.app,f.main,{url:'owned-url'},async read=>read()),true);
    assert.equal(f.dropdown.value,'selected');assert.deepEqual(f.counters,{focus:1,select:1,change:1,globalRows:0});
  }
});
test('actual selected Settings action refuses absent, closed or ambiguous owned pane before input',async()=>{
  for(const options of [{missing:true},{closed:true},{duplicate:true}]){
    const f=fixture(options);await assert.rejects(execute(f.app,f.main,{url:'owned-url'},async read=>read()),/selected settings pane identity/);
    assert.deepEqual(f.counters,{focus:0,select:0,change:0,globalRows:0});
  }
});

// Match cdp.mjs's bounded passive wait: zero panes is startup, never an action retry.
test('scope waits for an absent owned pane to appear and fails at the original deadline if absent',async()=>{
  const f=fixture({missing:true});let clock=0,polls=0;
  const wait=async(read,stage,ms=30000)=>{const end=clock+ms;while(clock<end){polls++;if(clock===200)f.availability.missing=false;const value=read();if(value)return value;assert.equal(f.counters.change,0);clock+=100;}throw Error(stage);};
  await execute(f.app,f.main,{url:'owned-url'},wait);assert.equal(clock,200);assert.equal(polls,3);assert.equal(f.counters.change,1);
  const absent=fixture({missing:true});clock=0;polls=0;
  const never=async(read,stage,ms=30000)=>{const end=clock+ms;while(clock<end){polls++;const value=read();if(value)return value;clock+=100;}throw Error(stage);};
  await assert.rejects(execute(absent.app,absent.main,{url:'owned-url'},never),/folder settings/);assert.equal(clock,30000);assert.equal(polls,300);assert.equal(absent.counters.change,0);assert.equal(absent.counters.focus,0);
});
