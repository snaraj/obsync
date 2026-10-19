// Actual serialized connection + wait-vault blocks. No app/device/network calls.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {waitOwnedPage,waitOwnedSocketOpen} from '../android-journey.mjs';
const source=readFileSync(new URL('../android-journey.mjs',import.meta.url),'utf8'),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const a=source.indexOf('  async function connect('),z=source.indexOf('  async function releaseConnection()',a);assert.ok(a>0&&z>a);
const b=source.indexOf("    if(command==='wait-vault'){"),e=source.indexOf("    if(command==='unpaired-server-ready'){",b);assert.ok(b>0&&e>b);
const connectBody=source.slice(a,z),block=source.slice(b,e);
const execute=new AsyncFunction('deviceBudget','fetch','WebSocket','AbortSignal','Date','setTimeout','clearTimeout','digest','remainingState','requestedCommand',`const state=remainingState;let connectReadiness,forward,ws,stage;const pending=new Map(),networkFailures=[],blockedReasons=[],command=requestedCommand,startupReadiness={ready:true};let registryReads=0,receiptValue;const readyNativeStartup=async()=>{registryReads++;},receipt=value=>receiptValue=value;const waitOwnedPage=(${waitOwnedPage.toString()}),waitOwnedSocketOpen=(${waitOwnedSocketOpen.toString()});${connectBody}try{await(async()=>{let appPid;${block}})();return {result:'PASS',connectReadiness,stage,registryReads,receiptValue};}catch(error){return {result:'FAIL',connectReadiness,stage,registryReads,error};}`);
async function scenario(mode='empty-page'){
 const model={clock:0,adb:[],http:[],websockets:0,timers:0},limit=mode==='normal-default'?1000000:45000;const date={now:()=>model.clock};
 const deviceBudget=(budget,...args)=>{assert.ok(budget>0&&budget<=limit-model.clock);model.adb.push({budget,args});
  if(mode==='pid-failure')throw Object.assign(Error('private ADB stderr'),{status:1});
  if(args[0]==='shell'){if(mode==='late-pid')model.clock=45001;else if(mode==='forward-near-end')model.clock=41000;else if(['nearly-expired','normal-default'].includes(mode))model.clock+=19000;return Buffer.from('2123');}
  assert.equal(args[0],'forward');if(['nearly-expired','normal-default'].includes(mode))model.clock+=19000;return Buffer.from('40123');};
 const fetch=async(_address,{signal})=>{model.http.push(signal.budget);if(mode==='page-timeout'&&model.http.length===1)model.clock+=50;assert.ok(signal.budget<=5000&&signal.budget<=limit-model.clock);
  if(mode==='http-timeout')throw Object.assign(Error('private endpoint http://secret.invalid'),{name:'TimeoutError',cause:{code:'UND_ERR_HEADERS_TIMEOUT'}});
  if(mode==='http-network')throw Object.assign(TypeError('private network detail'),{cause:{code:'ECONNRESET'}});
  return {status:mode==='http-status'?503:200,json:async()=>{
   if(mode==='normal-default')model.clock+=4000;
   if(mode==='http-body')throw SyntaxError('private malformed response');
   if(mode==='late-body')model.clock=45001;
   return mode==='page-timeout'||mode==='empty-page'&&model.http.length===1?[]:[{type:'page',id:'owned',webSocketDebuggerUrl:'ws://127.0.0.1:40123/devtools/page/owned'}];
  }};};
 class Socket extends EventTarget{constructor(){super();model.websockets++;this.readyState=0;queueMicrotask(()=>{if(mode==='normal-default')model.clock+=10000;if(mode==='late-open'||mode==='nearly-expired')model.clock=45001;this.readyState=mode==='ws-error'?3:1;this.dispatchEvent(new Event(mode==='ws-error'?'error':'open'));});}}
 const setTimeout=(callback,ms)=>{model.timers++;if(ms<=100){model.clock+=ms;queueMicrotask(callback);}return model.timers;};
 const result=await execute(deviceBudget,fetch,Socket,{timeout:budget=>({budget})},date,setTimeout,()=>{},value=>createHash('sha256').update(value).digest('hex'),{expiresAtEpoch:1000},mode==='normal-default'?'status':'wait-vault');
 return {...result,model};
}
test('actual startup polls only successful empty page lists then uses one owned forward and one WS',async()=>{
 const r=await scenario();assert.equal(r.result,'PASS');assert.equal(r.model.adb.length,2);assert.equal(r.model.http.length,2);assert.equal(r.model.websockets,1);assert.equal(r.registryReads,1);
 assert.equal(r.connectReadiness.beforePageCount,0);assert.equal(r.connectReadiness.afterPageCount,1);assert.equal(r.connectReadiness.polls,2);assert.equal(r.connectReadiness.httpRequests,2);assert.equal(r.connectReadiness.firstHttpRequest.result,'COMPLETE');assert.equal(r.connectReadiness.socketConnected,true);
 assert.equal(r.connectReadiness.connectionBudgetMs,45000);assert.equal(r.connectReadiness.handshake.budgetMs,15000);
});
test('first HTTP timeout/network/status/body failure is terminal and retains the first failed request',async()=>{
 for(const mode of ['http-timeout','http-network','http-status','http-body']){const r=await scenario(mode);assert.equal(r.result,'FAIL',mode);assert.equal(r.model.adb.length,2);assert.equal(r.model.http.length,1);assert.equal(r.model.websockets,0);assert.equal(r.registryReads,0);
  const facts=r.connectReadiness;assert.equal(facts.httpRequests,1);assert.equal(facts.firstHttpFailure,facts.firstHttpRequest);assert.equal(facts.firstHttpFailure.result,'FAIL');assert.equal(facts.firstHttpFailure.headersReceived,['http-status','http-body'].includes(mode));assert.equal(facts.firstHttpFailure.bodyCompleted,false);
  assert.equal(JSON.stringify(facts).includes('private'),false);assert.equal(JSON.stringify(facts).includes('secret.invalid'),false);
 }
 const timeout=await scenario('http-timeout');assert.equal(timeout.error.name,'TimeoutError');assert.equal(timeout.connectReadiness.firstHttpFailure.errorCode,'UND_ERR_HEADERS_TIMEOUT');
});
test('failed scoped PID operation and WS error are terminal without inferred readiness or another connection',async()=>{
 const pid=await scenario('pid-failure');assert.equal(pid.result,'FAIL');assert.equal(pid.model.adb.length,1);assert.equal(pid.model.http.length,0);assert.equal(pid.registryReads,0);
 const ws=await scenario('ws-error');assert.equal(ws.result,'FAIL');assert.equal(ws.model.websockets,1);assert.equal(ws.model.http.length,1);assert.equal(ws.registryReads,0);assert.equal(ws.connectReadiness.handshake.errorEvents,1);
});
test('PID/forward/page-body/WS all retain the same absolute45s connection deadline',async()=>{
 const pid=await scenario('late-pid');assert.equal(pid.result,'FAIL');assert.equal(pid.model.adb.length,1);assert.equal(pid.model.http.length,0);assert.equal(pid.error.message,'owned Android connection deadline');
 const body=await scenario('late-body');assert.equal(body.result,'FAIL');assert.equal(body.registryReads,0);assert.equal(body.model.websockets,0);assert.equal(body.connectReadiness.firstHttpFailure.bodyCompleted,true);
 const late=await scenario('late-open');assert.equal(late.result,'FAIL');assert.equal(late.registryReads,0);assert.match(late.error.message,/handshake deadline/);
 const bounded=await scenario('forward-near-end');assert.equal(bounded.result,'PASS');assert.equal(bounded.model.adb[1].budget,4000);assert.equal(bounded.model.http[0],4000);assert.equal(bounded.connectReadiness.handshake.budgetMs,4000);
 const near=await scenario('nearly-expired');assert.equal(near.result,'FAIL');assert.deepEqual(near.model.adb.map(c=>c.budget),[45000,26000]);assert.equal(near.connectReadiness.handshake.budgetMs,7000);assert.equal(near.registryReads,0);
});
test('actual wait-vault block independently refuses a stubbed connect returning after its deadline',async()=>{
 const action=new AsyncFunction('connect','Date','readyNativeStartup','receipt','let appPid,stage,startupReadiness;const command="wait-vault";'+block);
 let clock=0,reads=0,receipts=0;
 await assert.rejects(action(async deadline=>{assert.equal(deadline,45000);clock=45001;return 2123;},{now:()=>clock},async()=>{reads++;},()=>{receipts++;}),/owned vault WebView startup deadline/);
 assert.equal(reads,0);assert.equal(receipts,0);
});

test('successful empty-page observations retain the original20s phase and last read/pause use only its remainder',async()=>{
 const r=await scenario('page-timeout');assert.equal(r.result,'FAIL');assert.equal(r.error.message,'owned initial Android page readiness deadline');assert.equal(r.model.adb.length,2);assert.equal(r.model.websockets,0);assert.equal(r.registryReads,0);assert.equal(r.model.clock,20000);assert.equal(r.model.http.at(-1),50);assert.equal(r.connectReadiness.firstHttpRequest.result,'COMPLETE');assert.equal(r.connectReadiness.lastHttpRequest.result,'COMPLETE');
});

test('normal connect retains session allowance and original per-phase caps rather than a new45s aggregate limit',async()=>{
 const r=await scenario('normal-default');assert.equal(r.result,'PASS');assert.equal(r.model.clock,52000);assert.equal(r.registryReads,0);assert.equal(r.connectReadiness.connectionBudgetMs,1000000);assert.equal(r.connectReadiness.handshake.budgetMs,15000);assert.equal(r.model.http[0],5000);
});
