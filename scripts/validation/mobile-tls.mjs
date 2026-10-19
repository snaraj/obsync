// Local test TLS termination. Certificate checking stays in the mobile OS.
import https from 'node:https';
import http from 'node:http';
import {readFileSync,writeFileSync,lstatSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// Only the Android TLS hop is gated. The desktop's recorder listener stays live.
export function androidRouteGate(server){
  const sockets=new Set();let state='OPEN',rejectedConnections=0,finishDrain;
  server.prependListener('connection',socket=>{
    if(state!=='OPEN'){rejectedConnections++;socket.destroy();return;}
    sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);if(!sockets.size)finishDrain?.();});
  });
  return {
    allowRequest(req){if(state==='OPEN')return true;req.destroy();return false;},
    get state(){return state;},
    get activeSockets(){return sockets.size;},
    async drain(){
      if(state!=='OPEN')throw Error('route_gate_state');
      state='DRAINING';const started=performance.now();let timer;
      try{
        await new Promise((resolve,reject)=>{
          finishDrain=resolve;
          timer=setTimeout(()=>reject(Error('route_drain_timeout')),70000);
          server.closeIdleConnections();
          if(!sockets.size)resolve();
        });
        if(sockets.size)throw Error('route_drain_incomplete');
        state='DRAINED';
        return {result:'DRAINED',activeSockets:0,gateClosed:true,drainMs:Math.ceil(performance.now()-started),
          drainDeadlineMs:70000,forcedActiveSocketCloses:0,rejectedConnections};
      }catch(error){state='FAILED';throw error;}
      finally{clearTimeout(timer);finishDrain=null;}
    },
    resume(){
      if(state!=='DRAINED'||sockets.size)throw Error('route_resume_without_drain');
      state='OPEN';return {result:'RESUMED',gateOpen:true,priorDrainProven:true,rejectedConnections};
    },
  };
}

export function routeRequests(run,gate){
  const seen=new Map();
  const publish=receipt=>{const file=join(run,'private/android-route-result.json');writeFileSync(file+'.pending',JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});renameSync(file+'.pending',file);};
  return async()=>{
    const file=join(run,'private/android-route.json');let input;
    try{
      const info=lstatSync(file);
      if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077||info.nlink!==1||info.size>1024)throw Error('route_request_private');
      input=JSON.parse(readFileSync(file,'utf8'));
      if(input.schema!==1||!['drain','resume'].includes(input.action)||!/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId??'')||Object.keys(input).sort().join(',')!=='action,requestId,schema')throw Error('route_request_shape');
      const body=JSON.stringify(input);
      if(seen.has(input.requestId)){if(seen.get(input.requestId)!==body)throw Error('route_request_reused');return;}
      if(seen.size>=2)throw Error('route_request_budget');
      seen.set(input.requestId,body);
      const sourceHead=JSON.parse(readFileSync(join(run,'lab.json'),'utf8')).source_head;
      if(!/^[a-f0-9]{40}$/.test(sourceHead??''))throw Error('route_source_binding');
      const proof=input.action==='drain'?await gate.drain():gate.resume();
      const receipt={schema:1,requestId:input.requestId,sourceHead,tlsPid:process.pid,...proof,faultClass:'OWNED_ANDROID_ROUTE_OFFLINE',
        certificateValidation:'NOT_TESTED_BY_ROUTE_GATE',desktopRecorderListenerUnchanged:true};
      writeFileSync(join(run,'evidence','android-route-'+input.requestId+'.json'),JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
      publish(receipt);
      return receipt;
    }catch(error){
      if(error.code==='ENOENT'&&input===undefined)return;
      const receipt={schema:1,requestId:input?.requestId,result:'FAIL',failureClass:'UNCLASSIFIED',
        faultClass:'OWNED_ANDROID_ROUTE_OFFLINE',errorCode:['route_request_private','route_request_shape','route_request_reused','route_request_budget','route_source_binding','route_gate_state','route_drain_timeout','route_drain_incomplete','route_resume_without_drain'].includes(error.message)?error.message:'route_control_refused'};
      writeFileSync(join(run,'evidence/android-route-control-failure.json'),JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
      publish(receipt);
      throw Error(receipt.errorCode);
    }
  };
}

// The candidate recorder exposes completed connections through its append-only
// index. Read counts only; neither request bytes nor credentials enter receipts.
export function recorderEofState(run,recorder){
  const file=join(run,'private/traffic/index.jsonl'),info=lstatSync(file),connections=recorder.connections();
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.mode&0o077||info.size>16*1024*1024||!Number.isSafeInteger(connections)||connections<0||connections>200000)throw Error('recorder_index_invalid');
  const lines=readFileSync(file,'utf8').split('\n'),partial=lines.pop()!=='';const seen=new Set();let eof=0;
  for(const line of lines){
    let row;try{row=JSON.parse(line);}catch{throw Error('recorder_index_invalid');}
    if(Object.keys(row).sort().join(',')!=='down,n,up,upstreamEnded'||!Number.isSafeInteger(row.n)||row.n<1||row.n>connections||seen.has(row.n)||!['up','down'].every(k=>Number.isSafeInteger(row[k])&&row[k]>=0)||typeof row.upstreamEnded!=='boolean')throw Error('recorder_index_invalid');
    seen.add(row.n);if(row.upstreamEnded)eof++;
  }
  return {recorderConnections:connections,completedRecorderConnections:seen.size,recorderConnectionsWithoutUpstreamEof:seen.size-eof,
    recorderPendingConnections:connections-seen.size,indexPartialRow:partial,recorderNaturalEof:connections===seen.size&&eof===connections&&!partial};
}

export async function startMobileTls({run,observerPath,upstream,tlsPort}){
  const {startRecorder}=await import(pathToFileURL(observerPath));
  const recorder=await startRecorder({listen:'127.0.0.1:0',upstream:`127.0.0.1:${upstream}`,out:join(run,'private/traffic')});
  let gate;
  const tls=https.createServer({key:readFileSync(join(run,'private/tls.key')),cert:readFileSync(join(run,'private/tls.crt'))},(req,res)=>{
    if(!gate.allowRequest(req))return;
    const upstreamRequest=http.request({hostname:'127.0.0.1',port:recorder.port,path:req.url,method:req.method,
      headers:{...req.headers,connection:'close'},agent:false},answer=>{
      res.writeHead(answer.statusCode,{...answer.headers,connection:'close'});answer.pipe(res);
    });
    upstreamRequest.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.on('aborted',()=>upstreamRequest.destroy());req.pipe(upstreamRequest);
  });
  gate=androidRouteGate(tls);tls.requestTimeout=30000;tls.headersTimeout=10000;
  await new Promise((resolve,reject)=>{tls.once('error',reject);tls.listen(tlsPort,'127.0.0.1',resolve);});
  writeFileSync(join(run,'private/tls-ready.json'),JSON.stringify({port:tls.address().port,recorderPort:recorder.port,bind:'127.0.0.1'})+'\n',{mode:0o600});
  let stopping=false;
  return {tls,recorder,gate,async stop(){
    if(stopping)return;stopping=true;
    const started=performance.now(),deadline=started+70000;let stage='tls-inbound-drain',snapshot,code,timer;
    try{
      tls.closeIdleConnections();
      await Promise.race([new Promise(r=>tls.close(r)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('tls_drain_deadline')),Math.max(0,deadline-performance.now()));})]);
      clearTimeout(timer);stage='recorder-natural-eof';
      while(true){
        snapshot=recorderEofState(run,recorder);
        if(snapshot.recorderConnectionsWithoutUpstreamEof)throw Error('recorder_upstream_eof_missing');
        if(snapshot.recorderNaturalEof)break;
        if(performance.now()>=deadline)throw Error('recorder_drain_deadline');
        await new Promise(r=>setTimeout(r,Math.min(100,Math.max(0,deadline-performance.now()))));
      }
      if(performance.now()>deadline)throw Error('recorder_drain_deadline');
      stage='candidate-recorder-close';await recorder.close();
    }catch(error){
      const known=['tls_drain_deadline','recorder_index_invalid','recorder_upstream_eof_missing','recorder_drain_deadline','recorder_failed'];
      code=known.includes(error.message)?error.message:'transport_close_refused';
      // Preserve the candidate recorder's actual failure output. Its close still
      // rejects truncation; no incomplete frame is silently accepted.
      try{await recorder.close();}catch{}
    }finally{clearTimeout(timer);}
    let complete,sourceHead=null;
    try{complete=JSON.parse(readFileSync(join(run,'private/traffic/complete.json'),'utf8'));}catch{}
    try{const head=JSON.parse(readFileSync(join(run,'lab.json'),'utf8')).source_head;if(/^[a-f0-9]{40}$/.test(head??''))sourceHead=head;}catch{}
    const errors=['recorder_open','recorder_truncated','recorder_flush','recorder_close','recorder_index','recorder_write','recorder_socket'];
    const receipt={schema:1,result:code?'FAIL':'CLOSED',sourceHead,tlsPid:process.pid,stage,code:code??null,drainDeadlineMs:70000,
      drainMs:Math.ceil(performance.now()-started),tlsActiveSockets:gate.activeSockets,recorderConnections:recorder.connections(),
      completedRecorderConnections:snapshot?.completedRecorderConnections??null,...snapshot,
      recorderCompletion:complete?'PRESENT':'MISSING',recorderErrors:Array.isArray(complete?.errors)?complete.errors.map(e=>errors.includes(e)?e:'UNKNOWN'):['UNKNOWN']};
    writeFileSync(join(run,'evidence/transport-close.json'),JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
    if(code)throw Error(code);
    return receipt;
  }};
}

async function main(){
  const [run,observerPath,upstreamArg,tlsArg,...extra]=process.argv.slice(2),upstream=Number(upstreamArg),tlsPort=Number(tlsArg);
  if(!run||extra.length||![upstream,tlsPort].every(p=>Number.isInteger(p)&&p>1023&&p<65536))throw Error('explicit local ports required');
  const transport=await startMobileTls({run,observerPath,upstream,tlsPort}),control=routeRequests(run,transport.gate);let busy=false;
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await control();}catch{process.exitCode=1;}finally{busy=false;}},100);
  async function stop(){clearInterval(timer);try{await transport.stop();process.exit(process.exitCode??0);}catch{process.exit(1);}}
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
