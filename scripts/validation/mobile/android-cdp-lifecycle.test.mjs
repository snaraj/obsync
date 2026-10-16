// Offline socket fixtures only. No ADB server, emulator or application calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { waitOwnedSocketOpen, releaseOwnedConnection } from '../android-journey.mjs';
class Socket extends EventTarget {
 constructor(){super();this.readyState=0;this.closes=0;this.onClose=null;}
 event(type,fields={}){if(type==='open')this.readyState=1;if(type==='close')this.readyState=3;const e=new Event(type);Object.assign(e,fields);this.dispatchEvent(e);}
 close(){this.closes++;this.readyState=2;this.onClose?.();}
}
test('one handshake records open or rejects early-close/error without waiting for the unchanged15s ceiling',async()=>{
 const good=new Socket(),facts={};const opened=waitOwnedSocketOpen(good,facts,Date.now()+60000);good.event('open');await opened;assert.equal(facts.handshake.budgetMs,15000);assert.equal(facts.handshake.openEvents,1);assert.equal(facts.handshake.readyStateAfter,1);
 for(const [event,reason]of [['close',/closed before handshake/],['error',/unavailable/]]){
  const s=new Socket(),d={};const waiting=waitOwnedSocketOpen(s,d,Date.now()+15000);s.event(event,{code:1006,wasClean:false,reason:'private unexpected server text'});await assert.rejects(waiting,reason);assert.equal(d.handshake[event==='close'?'closeEvents':'errorEvents'],1);assert.equal(JSON.stringify(d).includes('private'),false);assert.equal(s.closes,0);
 }
 const absent=new Socket(),d={};setTimeout(()=>absent.event('open'),30);await assert.rejects(waitOwnedSocketOpen(absent,d,Date.now()+10),/handshake deadline/);assert.ok(d.handshake.elapsedMs<1000);assert.equal(d.handshake.openEvents,0);assert.equal(d.handshake.budgetMs,10);
 let clock=0;const late=new Socket();const lateOpen=waitOwnedSocketOpen(late,{},200,()=>clock);clock=201;late.event('open');await assert.rejects(lateOpen,/handshake deadline/);
});
test('one close is completed before scoped forward removal and release receives only its remaining original20s budget',async()=>{
 const s=new Socket();s.readyState=1;let clock=1000,removed=0,remaining;const facts={};
 s.onClose=()=>setTimeout(()=>{clock=1250;s.event('close',{code:1000,wasClean:true});},5);
 await releaseOwnedConnection(s,async budget=>{removed++;remaining=budget;assert.equal(s.readyState,3);assert.equal(facts.release.closeObserved,true);},facts,90000,()=>clock);
 assert.equal(s.closes,1);assert.equal(removed,1);assert.equal(remaining,19750);assert.equal(facts.release.closeBudgetMs,2000);assert.equal(facts.release.closeElapsedMs,250);assert.equal(facts.release.wasClean,true);assert.equal(facts.release.forwardRemoved,true);
 const closing=new Socket();closing.readyState=2;setTimeout(()=>closing.event('close',{code:1000,wasClean:true}),5);await releaseOwnedConnection(closing,async()=>{}, {},Date.now()+1000);assert.equal(closing.closes,0,'must not dispatch another close while already closing');
});
test('missing close fails finitely while removing only its owned transport, and a late close cannot pass',async()=>{
 const s=new Socket();s.readyState=1;const facts={};let removed=0;const start=Date.now();
 await assert.rejects(releaseOwnedConnection(s,async()=>{removed++;},facts,start+15),/close deadline/);assert.ok(Date.now()-start<1000);assert.equal(s.closes,1);assert.equal(facts.release.closeObserved,false);assert.ok(removed<=1);
 let clock=0;const late=new Socket();late.readyState=1;late.onClose=()=>{clock=2001;late.event('close',{code:1000,wasClean:true});};
 await assert.rejects(releaseOwnedConnection(late,async()=>{}, {},20000,()=>clock),/close deadline/);
 clock=0;const lateRemoval=new Socket();lateRemoval.readyState=3;const lateFacts={};await assert.rejects(releaseOwnedConnection(lateRemoval,async()=>{clock=20001;},lateFacts,60000,()=>clock),/release deadline/);assert.equal(lateFacts.release.forwardRemoved,true);
 const thrown=new Socket();thrown.readyState=1;thrown.close=()=>{throw Error('private synchronous socket exception');};let listenerBalance=0;const add=thrown.addEventListener.bind(thrown),remove=thrown.removeEventListener.bind(thrown);thrown.addEventListener=(...args)=>{listenerBalance++;return add(...args);};thrown.removeEventListener=(...args)=>{listenerBalance--;return remove(...args);};await assert.rejects(releaseOwnedConnection(thrown,async()=>{},{},Date.now()+20000),/owned CDP close refused/);assert.equal(listenerBalance,0);
 const removedFailure=new Socket();removedFailure.readyState=3;await assert.rejects(releaseOwnedConnection(removedFailure,async()=>{throw Error('private adb stderr');},{},Date.now()+20000),/forward removal refused/);
});
test('actual driver routes normal cleanup through the same observed release',()=>{
 const source=readFileSync(new URL('../android-journey.mjs',import.meta.url),'utf8');
 const cleanup=source.slice(source.lastIndexOf('  } finally {'));
 assert.ok(cleanup.indexOf('await releaseConnection();')<cleanup.indexOf('for(const result of receipts)'));
 const release=source.slice(source.indexOf('  async function releaseConnection()'),source.indexOf('  async function trustedPointerClick('));
 const execute=new Function('ws','forward','connectReadiness','releaseOwnedConnection','deviceBudget','state',`return (async()=>{${release};await releaseConnection();return {ws,forward};})()`);
 let closeComplete=false,removeCalls=0;const s=new Socket();s.readyState=1;s.onClose=()=>setTimeout(()=>{closeComplete=true;s.event('close');},5);
 return execute(s,1234,{},releaseOwnedConnection,(_budget,...args)=>{assert.equal(closeComplete,true);assert.deepEqual(args,['forward','--remove','tcp:1234']);removeCalls++;},{expiresAtEpoch:Date.now()/1000+30}).then(result=>{assert.equal(removeCalls,1);assert.equal(result.ws,undefined);assert.equal(result.forward,undefined);});
});

test('actual finally waits for release before persisting receipts, retaining a separate close failure',async()=>{
 const source=readFileSync(new URL('../android-journey.mjs',import.meta.url),'utf8');
 const body=/  } finally {\n([\s\S]*?)\n  }\n}\nif \(/.exec(source)?.[1];assert.ok(body);
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const action=new AsyncFunction('releaseConnection','receipt','process','Date','receipts','connectReadiness','writeFileSync','join','run','command','console',body);
 for(const failure of [false,true]){
  let completed=false;const writes=[],receipts=[{result:'ACTION_COMPLETED'}],process={};const connection={release:{closeObserved:!failure}};
  await action(async()=>{await new Promise(r=>setTimeout(r,5));completed=true;if(failure)throw Error('owned CDP close deadline');},value=>receipts.push(value),process,Date,receipts,connection,(_path,text)=>{assert.equal(completed,true);writes.push(JSON.parse(text));},(...args)=>args.join('/'),'/synthetic','control',{log:()=>{}});
  assert.equal(writes[0].connectReadiness.release.closeObserved,!failure);assert.equal(writes.length,failure?2:1);assert.equal(process.exitCode,failure?1:undefined);
  if(failure){assert.equal(writes[1].result,'FAIL');assert.equal(writes[1].stage,'release_owned_android_websocket');assert.equal(writes[1].reason,'owned CDP close deadline');}
 }
});
test('actual Node WebSocket closure must finish before local transport teardown',async()=>{
 const sockets=new Set(),events=[];const server=createServer();
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.on('data',data=>{if((data[0]&15)===8){events.push('close-frame');setTimeout(()=>{events.push('close-reply');if(!socket.destroyed)socket.end(Buffer.from([0x88,0x02,0x03,0xe8]));},20);}});
 });
 await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 let ws;
 try{
  ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/owned-fixture`);const d={};await waitOwnedSocketOpen(ws,d,Date.now()+15000);
  await releaseOwnedConnection(ws,async()=>{events.push('remove-transport');for(const s of sockets)s.destroy();},d,Date.now()+20000);
  assert.deepEqual(events,['close-frame','close-reply','remove-transport']);assert.equal(d.release.closeObserved,true);assert.equal(d.release.wasClean,true);assert.equal(d.release.closeCalls,1);
 }finally{if(ws?.readyState===1)ws.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}
});
