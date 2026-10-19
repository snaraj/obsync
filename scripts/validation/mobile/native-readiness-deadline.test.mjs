// Deterministic actual-source first/final read boundary; no native operations.
import test from 'node:test';import assert from 'node:assert/strict';
import {waitNativeReadiness} from '../android-journey.mjs';
test('native readiness includes first and final observations in the same original20s deadline',async()=>{
 for(const phase of ['initial','final'])for(const [returnedAt,expected] of [[100,true],[20000,true],[20001,false]]){
  let clock=0,reads=0,pauses=0;
  const result=await waitNativeReadiness(()=>{reads++;if(phase==='final'&&reads===1)return {vaultPresent:true,ownedVault:true,ready:false};clock=returnedAt;return {vaultPresent:true,ownedVault:true,ready:true};},async ms=>{assert.equal(ms,100);clock+=ms;pauses++;},()=>clock,20000);
  assert.equal(result.ready,expected,phase+' read returned at '+returnedAt);assert.equal(result.after.ready,true);assert.equal(result.polls,phase==='initial'?1:2);assert.equal(reads,result.polls);assert.equal(pauses,phase==='initial'?0:1);
 }
 let clock=0,reads=0;const expired=await waitNativeReadiness(()=>{reads++;clock=20001;return {vaultPresent:true,ownedVault:true,ready:false};},async()=>assert.fail('late first read cannot start another poll'),()=>clock,20000);assert.equal(expired.ready,false);assert.equal(reads,1);
 clock=0;reads=0;await assert.rejects(waitNativeReadiness(()=>{if(++reads===1)return {vaultPresent:true,ownedVault:true,ready:false};clock=20001;return {vaultPresent:true,ownedVault:false,ready:true};},async ms=>{clock+=ms;},()=>clock,20000),/foreign vault/);
});
