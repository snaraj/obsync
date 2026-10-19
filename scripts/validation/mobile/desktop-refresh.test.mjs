import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(process.env.OBSYNC_DESKTOP_REFRESH_SOURCE??new URL('./desktop.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function freshRevokeTarget(deadline) {');
const first=source.indexOf('ui(`',start)+3,last=source.indexOf('`,{deadline});',first)+1;
assert.ok(start>=0&&first>start&&last>first,'actual production renderer required');
const body=Function('return '+source.slice(first,last))();
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const render=new AsyncFunction('P','pane','settingRow','activeOthers','listReady','press','visible','p','Date','setTimeout','clearTimeout',body);
const self='11'.repeat(16),phone='22'.repeat(16);
function device(name='Android fixture',id=phone){return {device_id:id,name,platform:'android',app_version:'1.1.8',revoked:false,state:'active'};}
function row(name='Android fixture',desc='android, plugin 1.1.8'){return {visible:true,querySelector(selector){return {textContent:selector==='.setting-item-name'?name:desc};}};}
async function scenario(mode='fresh'){
  const m={now:0,description:'1 device on this account, and 1 revoked.',rows:mode==='stale-matching'?[row()]:[],clicks:0,reads:0,disconnected:0,records:[],observer:null};
  const root={isConnected:true,ownerDocument:{defaultView:{MutationObserver:class{
    constructor(callback){m.observer=callback;}observe(target,options){assert.equal(target,root);assert.equal(options.subtree,true);assert.equal(options.characterDataOldValue,true);}takeRecords(){const records=m.records;m.records=[];return records;}disconnect(){m.disconnected++;}
  }}}};
  const pane=()=>({closest:()=>root});
  const settingRow=()=>({querySelector:()=>({textContent:m.description})});
  const listReady=()=>/^[0-9]+ devices? on this account(?:,.*)?\.$/.test(m.description);
  function update(){
    if(m.now<100||mode==='never'||mode.startsWith('stale'))return;
    m.description=mode==='failed'?'The device list is unavailable: private refusal sentinel':'2 devices on this account, and 1 revoked.';
    if(m.now>=(mode==='late'?500:100))m.rows=mode==='ambiguous'?[row(),row('Other device')]:mode==='wrong'?[row('Wrong device')]:mode==='wrong-suffix'?[row('Android fixture · 33333333')]:[row()];
  }
  function press(root,label){
    assert.equal(label,'Refresh');m.clicks++;
    if(mode.startsWith('stale'))return;
    m.description='Reading the device list…';m.records.push({addedNodes:[{textContent:m.description}]});
    if(mode==='sync'||mode==='sync-nested'){m.description='2 devices on this account.';m.rows=[row()];if(mode==='sync-nested')m.records=[{removedNodes:[{textContent:'Device list + refresh controls',querySelectorAll:()=>[{textContent:'Reading the device list…'}]}]}];}
  }
  let next=0;const timers=new Map();
  function setTimeout(fn,ms){const id=++next;timers.set(id,true);if(ms<=50||mode==='inventory-timeout')queueMicrotask(()=>{if(!timers.has(id))return;m.now+=ms;update();m.observer?.(m.records.splice(0));fn();});return id;}
  const clearTimeout=id=>timers.delete(id);
  const p={state:{data:{deviceId:self}},listDevices:async()=>{m.reads++;if(mode==='inventory-timeout')return new Promise(()=>{});if(mode==='inventory-failed')throw Error('credential-bearing refusal must not escape');return mode==='inventory-empty'?[]:mode==='inventory-ambiguous'?[device(),device('Other','33'.repeat(16))]:[device()];}};
  const result=await render({deadline:30000},pane,settingRow,()=>m.rows,listReady,press,r=>r.visible,p,{now:()=>m.now},setTimeout,clearTimeout);
  assert.equal(m.clicks,1,'one ordinary refresh only');assert.equal(m.disconnected,1,'owned observer always disconnected');assert.ok(m.now<=30000,'original total budget');
  return {result,m};
}

test('stale count/zero rows are refreshed once; ready count can precede actual target rows',async()=>{
  for(const mode of ['fresh','late','sync','sync-nested']){
    const {result,m}=await scenario(mode);assert.equal(result.result,'READY');assert.equal(result.diagnostics.before.activeOtherRows,0);assert.equal(result.diagnostics.after.activeOtherRows,1);
    assert.equal(result.diagnostics.refreshLoadingObserved,true);assert.equal(result.diagnostics.rowsMatchInventory,true);assert.equal(result.diagnostics.authenticatedActiveOtherCount,1);assert.equal(m.reads,1);
    if(mode==='late')assert.ok(m.now>=500);if(mode.startsWith('sync'))assert.equal(m.now,0,'transition recorded before waiter even for synchronous completion');
  }
});
test('stale unchanged text, failed refresh and missing completion cannot select a target',async()=>{
  for(const [mode,reason] of [['stale','refresh_deadline'],['stale-matching','refresh_deadline'],['failed','refresh_failed'],['never','refresh_deadline'],['inventory-timeout','inventory_deadline'],['inventory-failed','refresh_read_refused']]){
    const {result}=await scenario(mode);assert.equal(result.result,'REFUSED');assert.equal(result.reason,reason);assert.equal(result.selected,undefined);
    assert.equal(JSON.stringify(result).includes('credential-bearing'),false,'safe reduced diagnostics only');
  }
});
test('ambiguous authenticated inventory or a wrong/ambiguous existing rendered target refuse without waiting out deadline',async()=>{
  for(const [mode,reason] of [['ambiguous','rendered_target_ambiguous'],['wrong','rendered_target_mismatch'],['wrong-suffix','rendered_target_mismatch'],['inventory-empty','authenticated_target_not_sole'],['inventory-ambiguous','authenticated_target_not_sole']]){
    const {result,m}=await scenario(mode);assert.equal(result.result,'REFUSED');assert.equal(result.reason,reason);assert.ok(m.now<30000);
  }
});
test('a fresh sole row still cannot replace the private previously observed phone identity',async()=>{
  const begin=source.indexOf('async function openRevoke() {'),end=source.indexOf('\nasync function backupFromDialog',begin);
  const fn=source.slice(begin,end),body=fn.slice(fn.indexOf('{')+1,fn.lastIndexOf('}'));
  const operation=new AsyncFunction('settings','freshRevokeTarget','existsSync','join','runtime','targetName','privateRead','privateSave','ui','Date','stage',body);
  let pressed=false;
  await assert.rejects(operation(async()=>{},async()=>({name:'Wrong device',rowTitle:'Wrong device'}),()=>true,(...p)=>p.join('/'),'/owned','target.json',()=>JSON.stringify({name:'Android fixture'}),()=>{},async()=>{pressed=true;},{now:()=>0},''),/selected phone name changed/);
  assert.equal(pressed,false);
});
