// Manufactured retention controls only; these tests claim no native crypto proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,lstatSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainedBytes,retainCapture} from './ciphertext-retention.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
function fixture(){
  const sourceHead='1'.repeat(40),bundleSha256='2'.repeat(64),decoderHash='3'.repeat(64);
  const name='Phone-core-desktop-1800000000000',text=`# ${name}\n\nSynthetic native desktop sentinel.\n`,chunk=Buffer.alloc(Buffer.byteLength(text)+16,77);
  const version=(map)=>({version_id:(map?'4':'5').repeat(64),parents:[],sids:map?[]:[hash(chunk)],bytes:map?0:Buffer.byteLength(text),
    device_id:'6'.repeat(32),ts:1800000000000,deleted:false,manifest_ct:Buffer.alloc(48,map?88:99).toString('base64'),seal_suite:2,
    file_id:(map?'7':'8').repeat(32),domain_id:'9'.repeat(32),generation:'7'.repeat(32)});
  const capture={schema:1,origin:'native-authenticated-read',sourceHead,bundleSha256,decoderHash,capturedAt:'2027-01-15T08:00:00.000Z',
    expected:{path:name+'.md',text,sha256:hash(text)},expectationSha256:'a'.repeat(64),ordinaryNoteDiskMatches:true,
    note:version(false),map:version(true),chunks:[{sid:hash(chunk),cid:'b'.repeat(64),ciphertext:chunk.toString('base64')}],headProof:null};
  const witness=()=>({generation:capture.note.generation,observedAt:capture.capturedAt,...Object.fromEntries(['note','map'].map(kind=>{
    const record=capture[kind],clean=Object.fromEntries(Object.entries(record).filter(([key])=>!['file_id','domain_id','generation'].includes(key)));
    return [kind,{fileId:record.file_id,domainId:record.domain_id,heads:[record.version_id],recordSha256:hash(JSON.stringify(sorted(clean)))}];}))});
  capture.headProof={schema:1,sourceHead,bundleSha256,before:witness(),after:witness()};return capture;
}
const binding=capture=>({sourceHead:capture.sourceHead,bundleSha256:capture.bundleSha256,decoderHash:capture.decoderHash,sourceCaptureSha256:hash(JSON.stringify(capture)+'\n')});
test('exact ciphertext bytes survive later failed-attempt private cleanup and receipt hashes stay distinct',()=>{
  const run=mkdtempSync(join(tmpdir(),'obsync-retention-unit-'));
  try{
    mkdirSync(join(run,'evidence'),{mode:0o700});mkdirSync(join(run,'private'),{mode:0o700});
    const capture=fixture(),bound=binding(capture),receipt=retainCapture(run,capture,'before',bound);
    rmSync(join(run,'private'),{recursive:true});
    assert.equal(existsSync(join(run,'private')),false);
    const bytes=readFileSync(join(run,receipt.path));assert.deepEqual(JSON.parse(bytes),capture);
    assert.equal(bytes.toString(),JSON.stringify(capture)+'\n');assert.equal(receipt.sha256,bound.sourceCaptureSha256);
    assert.equal(receipt.sourceCaptureSha256,receipt.sha256);assert.notEqual(hash(JSON.stringify(receipt)),receipt.sha256);
    assert.equal(receipt.representation,'exact-validated-synthetic-capture');assert.equal(receipt.rawHttpIncluded,false);assert.equal(receipt.keysIncluded,false);
    assert.equal(lstatSync(join(run,receipt.path)).mode&0o777,0o600);
    assert.throws(()=>retainCapture(run,capture,'before',bound),{code:'EEXIST'});
  }finally{rmSync(run,{recursive:true,force:true});}
});
test('unknown fields and credential/root/backup values cannot enter retained schema',()=>{
  for(const change of [
    c=>{c.deviceSecret='a'.repeat(64);},c=>{c.root='a'.repeat(64);},c=>{c.backup='private recovery phrase';},
    c=>{c.note.device_secret='a'.repeat(64);},c=>{c.map.authorization='Bearer private';},c=>{c.chunks[0].privateKey='private';},
    c=>{c.headProof.before.note.token='private';},c=>{c.expected.root='a'.repeat(64);},
    c=>{c.expected.text='# device_secret '+ 'a'.repeat(64);c.expected.sha256=hash(c.expected.text);},
    c=>{c.note.manifest_ct='device_secret='+'a'.repeat(64);},c=>{c.chunks[0].ciphertext='private API credential';}
  ]){const capture=fixture();change(capture);assert.throws(()=>retainedBytes(capture,'before',binding(capture)),/ciphertext_retention_/);}
});
test('missing, truncated, changed or oversized ciphertext and changed current-head proof refuse retention',()=>{
  for(const change of [c=>{delete c.note.manifest_ct;},c=>{c.chunks=[];},c=>{c.chunks[0].ciphertext=c.chunks[0].ciphertext.slice(0,-4);},
    c=>{c.chunks[0].ciphertext=Buffer.alloc(15).toString('base64');},c=>{c.note.manifest_ct=Buffer.alloc(100000).toString('base64');},
    c=>{c.map.manifest_ct='';},c=>{c.chunks[0].sid='0'.repeat(64);},c=>{c.headProof.after.note.heads=['0'.repeat(64)];},
    c=>{c.note.ts++;},c=>{c.headProof.after.observedAt='2027-01-15T08:03:00.000Z';}]){
    const capture=fixture();change(capture);assert.throws(()=>retainedBytes(capture,'before',binding(capture)),/ciphertext_retention_/);
  }
});
test('source, decoder, original-byte binding and fixed labels cannot be substituted or projected silently',()=>{
  const capture=fixture(),bound=binding(capture);assert.doesNotThrow(()=>retainedBytes(capture,'before',bound));
  for(const changed of [{...bound,sourceHead:'0'.repeat(40)},{...bound,bundleSha256:'0'.repeat(64)},
    {...bound,decoderHash:'0'.repeat(64)},{...bound,sourceCaptureSha256:'0'.repeat(64)}])assert.throws(()=>retainedBytes(capture,'before',changed));
  assert.throws(()=>retainedBytes(capture,'unrelated',bound));assert.throws(()=>retainedBytes(capture,'access',bound));
});
