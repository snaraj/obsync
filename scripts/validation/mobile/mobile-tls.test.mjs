import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,chmodSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const moduleUrl=process.env.OBSYNC_MOBILE_TLS_MODULE??new URL('../mobile-tls.mjs',import.meta.url).href;
const {androidRouteGate,routeRequests,startMobileTls,recorderEofState}=await import(moduleUrl);
import {readCapture} from '../../ci/observer.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){const run=realpathSync(mkdtempSync(join(tmpdir(),'obsync-tls-gate-')));for(const name of ['private','evidence'])mkdirSync(join(run,name),{mode:0o700});writeFileSync(join(run,'lab.json'),JSON.stringify({source_head:'a'.repeat(40)}),{mode:0o600});return run;}
function get(url,options={}){return new Promise((resolve,reject)=>{const req=(url.startsWith('https:')?https:http).get(url,options,res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));res.on('error',reject);});req.on('error',reject);});}

test('owned TLS drain preserves in-flight HTTP, gates new TLS, keeps desktop recorder live, resumes and closes complete capture',async()=>{
  const run=fixture();let transport,upstream,release;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(run,'private/tls.key'),'-out',join(run,'private/tls.crt'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-days','1'],{stdio:'ignore'});
    chmodSync(join(run,'private/tls.key'),0o600);chmodSync(join(run,'private/tls.crt'),0o600);
    let started;const began=new Promise(r=>{started=r;});
    upstream=http.createServer((req,res)=>{res.setHeader('Connection','close');if(req.url==='/hold'){res.writeHead(200,{'content-length':2});res.write('a');release=()=>res.end('b');started();}else{res.end('synthetic bytes');}});
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    transport=await startMobileTls({run,observerPath:fileURLToPath(new URL('../../ci/observer.mjs',import.meta.url)),upstream:upstream.address().port,tlsPort:0});
    const tlsUrl='https://localhost:'+transport.tls.address().port;
    const ca=readFileSync(join(run,'private/tls.crt'));const options={ca,agent:false};
    const held=get(tlsUrl+'/hold',options);await began;
    let done=false;const draining=transport.gate.drain().then(value=>{done=true;return value;});
    await pause(30);assert.equal(done,false);assert.ok(transport.gate.activeSockets>0,'cannot claim offline while active TLS request exists');
    await assert.rejects(get(tlsUrl+'/blocked-during-drain',options),error=>{assert.notEqual(error.code,'ERR_TLS_CERT_ALTNAME_INVALID');assert.notEqual(error.code,'DEPTH_ZERO_SELF_SIGNED_CERT');return true;});
    assert.deepEqual(await get('http://127.0.0.1:'+transport.recorder.port+'/desktop-during-drain'),{status:200,body:'synthetic bytes'});
    release();assert.deepEqual(await held,{status:200,body:'ab'});
    const proof=await draining;assert.equal(proof.activeSockets,0);assert.equal(proof.gateClosed,true);assert.equal(proof.forcedActiveSocketCloses,0);assert.ok(proof.drainMs<=70000);
    await assert.rejects(get(tlsUrl+'/blocked-offline',options));
    assert.deepEqual(await get('http://127.0.0.1:'+transport.recorder.port+'/desktop-offline'),{status:200,body:'synthetic bytes'});
    assert.equal(transport.gate.resume().gateOpen,true);
    assert.deepEqual(await get(tlsUrl+'/resumed',options),{status:200,body:'synthetic bytes'});
    await transport.stop();transport=null;
    const complete=JSON.parse(readFileSync(join(run,'private/traffic/complete.json')));assert.deepEqual(complete.errors,[]);assert.equal(complete.connections,4);
    const capture=readCapture(join(run,'private/traffic'));assert.ok(capture);
  }finally{release?.();if(transport)await transport.stop();if(upstream)await new Promise(r=>upstream.close(r));rmSync(run,{recursive:true,force:true});}
});

test('70s timeout never cuts a live socket, reports failure, and cannot resume without successful drain',async t=>{
  const server=new EventEmitter();server.closeIdleConnections=()=>{};const gate=androidRouteGate(server);
  assert.throws(()=>gate.resume(),/without_drain/);
  const socket=new EventEmitter();let destroyed=false;socket.destroy=()=>{destroyed=true;};server.emit('connection',socket);
  t.mock.timers.enable({apis:['setTimeout']});
  const draining=gate.drain(),rejected=assert.rejects(draining,/route_drain_timeout/);
  t.mock.timers.tick(70000);await rejected;
  let blockedRequest=false;assert.equal(gate.allowRequest({destroy(){blockedRequest=true;}}),false);assert.equal(blockedRequest,true);
  assert.equal(destroyed,false);assert.equal(gate.activeSockets,1);assert.equal(gate.state,'FAILED');assert.throws(()=>gate.resume(),/without_drain/);
  let denied=false;server.emit('connection',{destroy(){denied=true;}});assert.equal(denied,true);
});

test('private finite request protocol retains separate fault evidence, rejects reuse, and reopens the gate',async()=>{
  const run=fixture();const server=new EventEmitter();server.closeIdleConnections=()=>{};const gate=androidRouteGate(server),control=routeRequests(run,gate);
  const input=join(run,'private/android-route.json'),output=join(run,'private/android-route-result.json');
  const write=value=>writeFileSync(input,JSON.stringify(value),{mode:0o600});
  try{
    write({schema:1,requestId:'drain-1',action:'drain'});const drained=await control();assert.equal(drained.result,'DRAINED');assert.equal(drained.sourceHead,'a'.repeat(40));assert.equal(drained.certificateValidation,'NOT_TESTED_BY_ROUTE_GATE');assert.equal(drained.faultClass,'OWNED_ANDROID_ROUTE_OFFLINE');
    assert.equal(await control(),undefined,'unchanged request is not replayed');
    renameSync(output,output+'.previous');write({schema:1,requestId:'resume-1',action:'resume'});assert.equal((await control()).gateOpen,true);assert.equal(gate.state,'OPEN');
    renameSync(output,output+'.resumed');write({schema:1,requestId:'drain-1',action:'resume'});await assert.rejects(control(),/route_request_reused/);assert.equal(JSON.parse(readFileSync(output)).result,'FAIL');
  }finally{rmSync(run,{recursive:true,force:true});}
});

test('world-readable, symlink, unexpected fields and wrong source refuse before gate mutation',async()=>{
  for(const kind of ['mode','symlink','shape','source']){
    const run=fixture();let mutated=false;const input=join(run,'private/android-route.json');
    try{
      const value={schema:1,requestId:'bad-1',action:'drain',...(kind==='shape'?{extra:true}:{})};
      writeFileSync(input,JSON.stringify(value),{mode:kind==='mode'?0o644:0o600});
      if(kind==='symlink'){renameSync(input,input+'.original');symlinkSync(input+'.original',input);}
      if(kind==='source')writeFileSync(join(run,'lab.json'),JSON.stringify({source_head:'wrong'}));
      await assert.rejects(routeRequests(run,{async drain(){mutated=true;},resume(){mutated=true;}})());
      assert.equal(mutated,false);assert.equal(JSON.parse(readFileSync(join(run,'private/android-route-result.json'))).result,'FAIL');
    }finally{rmSync(run,{recursive:true,force:true});}
  }
});

test('only the fixed drain/resume request pair is accepted',async()=>{
  const run=fixture();const server=new EventEmitter();server.closeIdleConnections=()=>{};const gate=androidRouteGate(server),control=routeRequests(run,gate);
  const file=join(run,'private/android-route.json'),output=join(run,'private/android-route-result.json');
  try{
    for(const [requestId,action] of [['one','drain'],['two','resume']]){
      writeFileSync(file,JSON.stringify({schema:1,requestId,action}),{mode:0o600});await control();renameSync(output,output+'.'+requestId);
    }
    writeFileSync(file,JSON.stringify({schema:1,requestId:'three',action:'drain'}),{mode:0o600});
    await assert.rejects(control(),/route_request_budget/);assert.equal(gate.state,'OPEN');
  }finally{rmSync(run,{recursive:true,force:true});}
});

test('terminal close naturally drains the proxy request left by a disconnected TLS client before closing the unchanged recorder',async()=>{
  const run=fixture();let transport,upstream,release;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(run,'private/tls.key'),'-out',join(run,'private/tls.crt'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-days','1'],{stdio:'ignore'});
    chmodSync(join(run,'private/tls.key'),0o600);chmodSync(join(run,'private/tls.crt'),0o600);
    let began;const started=new Promise(r=>{began=r;});
    upstream=http.createServer((req,res)=>{release=()=>res.end('synthetic completed reply');began();});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    transport=await startMobileTls({run,observerPath:fileURLToPath(new URL('../../ci/observer.mjs',import.meta.url)),upstream:upstream.address().port,tlsPort:0});
    const req=https.get('https://localhost:'+transport.tls.address().port+'/pending-before-client-stop',{ca:readFileSync(join(run,'private/tls.crt')),agent:false});
    const failed=new Promise(r=>req.once('error',r));await started;req.destroy();await failed;
    for(let i=0;i<100&&transport.gate.activeSockets;i++)await pause(10);
    assert.equal(transport.gate.activeSockets,0);assert.equal(transport.recorder.connections(),1);
    assert.equal(readFileSync(join(run,'private/traffic/index.jsonl'),'utf8'),'','upstream request remains alive after TLS socket is gone');
    let stopped=false;const closing=transport.stop().then(proof=>{stopped=true;return proof;});
    await pause(350);assert.equal(stopped,false,'250ms recorder close grace cannot replace natural EOF');
    release();const proof=await closing;transport=null;
    assert.equal(proof.result,'CLOSED');assert.equal(proof.recorderNaturalEof,true);assert.equal(proof.completedRecorderConnections,1);assert.equal(proof.recorderPendingConnections,0);assert.deepEqual(proof.recorderErrors,[]);
    assert.deepEqual(JSON.parse(readFileSync(join(run,'private/traffic/complete.json'))).errors,[]);readCapture(join(run,'private/traffic'));
    assert.deepEqual(JSON.parse(readFileSync(join(run,'evidence/transport-close.json'))),proof);
  }finally{release?.();if(transport)try{await transport.stop();}catch{}if(upstream)await new Promise(r=>upstream.close(r));rmSync(run,{recursive:true,force:true});}
});

test('recorder EOF counts reject malformed, duplicate, missing EOF and partial index without reporting completed drain',()=>{
  const run=fixture();mkdirSync(join(run,'private/traffic'),{mode:0o700});const file=join(run,'private/traffic/index.jsonl');
  const good={n:1,up:100,down:200,upstreamEnded:true};
  try{
    writeFileSync(file,JSON.stringify(good)+'\n',{mode:0o600});assert.equal(recorderEofState(run,{connections:()=>1}).recorderNaturalEof,true);
    writeFileSync(file,JSON.stringify({...good,upstreamEnded:false})+'\n');const bad=recorderEofState(run,{connections:()=>1});assert.equal(bad.recorderNaturalEof,false);assert.equal(bad.recorderConnectionsWithoutUpstreamEof,1);
    writeFileSync(file,JSON.stringify(good));assert.equal(recorderEofState(run,{connections:()=>1}).recorderNaturalEof,false);
    writeFileSync(file,JSON.stringify(good)+'\n'+'{');assert.equal(recorderEofState(run,{connections:()=>1}).recorderNaturalEof,false);
    for(const body of [JSON.stringify(good)+'\n'+JSON.stringify(good)+'\n','{"unexpected":true}\n','bad-json\n']){writeFileSync(file,body);assert.throws(()=>recorderEofState(run,{connections:()=>1}));}
  }finally{rmSync(run,{recursive:true,force:true});}
});

test('terminal index refusal retains a bounded failure receipt and cannot report successful close',async()=>{
  const run=fixture();let transport;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(run,'private/tls.key'),'-out',join(run,'private/tls.crt'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-days','1'],{stdio:'ignore'});
    chmodSync(join(run,'private/tls.key'),0o600);chmodSync(join(run,'private/tls.crt'),0o600);
    transport=await startMobileTls({run,observerPath:fileURLToPath(new URL('../../ci/observer.mjs',import.meta.url)),upstream:65534,tlsPort:0});
    writeFileSync(join(run,'private/traffic/index.jsonl'),'not-json\n');
    await assert.rejects(transport.stop(),/recorder_index_invalid/);transport=null;
    const proof=JSON.parse(readFileSync(join(run,'evidence/transport-close.json')));
    assert.equal(proof.result,'FAIL');assert.equal(proof.code,'recorder_index_invalid');assert.equal(proof.stage,'recorder-natural-eof');assert.equal(proof.recorderConnections,0);assert.equal(proof.completedRecorderConnections,null);
    assert.deepEqual(proof.recorderErrors,[],'parser refusal must remain a failure even when recorder reports no socket error');
  }finally{if(transport)try{await transport.stop();}catch{}rmSync(run,{recursive:true,force:true});}
});
