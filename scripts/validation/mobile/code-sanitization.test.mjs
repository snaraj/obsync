// Code construction/entity controls only; no browser, native app or device.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const {scriptJson}=await import(process.env.OBSYNC_SANITIZE_CDP_MODULE??new URL('./cdp.mjs',import.meta.url).href);
const {nativeScreen}=await import(process.env.OBSYNC_SANITIZE_ANDROID_MODULE??new URL('../android-journey.mjs',import.meta.url).href);

test('JSON parameters cannot break script delimiters and preserve repeated Unicode/control/quote data',()=>{
  const attack='</script><script>globalThis.injected=true</script><SCRIPT>globalThis.injected=true</SCRIPT>';
  const text=attack+' <>\u2028\u2029 <>\u2028\u2029 " \' \\ \\u003C \n\r\t\b\f\0 🔒';
  const value={text,nested:[text,1,true,false,null,{key:text}]};
  const literal=scriptJson(value);
  assert.doesNotMatch(literal,/[<>\u2028\u2029]/);
  assert.deepEqual(JSON.parse(literal),value);
  const sandbox={};
  vm.runInNewContext('globalThis.observed='+literal,sandbox,{timeout:1000});
  assert.equal(sandbox.injected,undefined);
  assert.equal(JSON.stringify(sandbox.observed),JSON.stringify(value));
  // A script-element parser must see exactly its intended closing delimiter.
  const html='<script>globalThis.observed='+literal+';</script>';
  assert.equal((html.match(/<\/script>/gi)??[]).length,1);
  assert.equal((html.match(/<script>/gi)??[]).length,1);
});

test('JSON serialization preserves data types and refuses absent, cyclic or unserializable values',()=>{
  for(const value of [null,false,0,42,'plain','\\u003C','</script>','\u2028\u2029',[],{}])assert.deepEqual(JSON.parse(scriptJson(value)),value);
  const cycle={};cycle.self=cycle;
  for(const value of [undefined,()=>0,Symbol('absent'),cycle,1n])assert.throws(()=>scriptJson(value));
});

function screen(text){
  return '<hierarchy><node package="com.android.settings" enabled="true" text="Allow file access"/>'+
    '<node package="com.android.settings" enabled="true" clickable="true" resource-id="com.android.settings:id/action" text="'+text+'"/></hierarchy>';
}
const input=nativeText=>({nativeResourceId:'com.android.settings:id/action',nativeText,nativeRequiredText:'Allow file access'});
test('native XML entities decode once; literal nested entities never select a different ordinary control',()=>{
  const entities={quot:'"',apos:"'",amp:'&',lt:'<',gt:'>'};
  for(const [name,decoded] of Object.entries(entities)){
    const literal='&'+name+';';
    assert.equal(nativeScreen(screen(literal),input(decoded)).ready,true,name+' single decode');
    const escaped='&amp;'+name+';';
    assert.equal(nativeScreen(screen(escaped),input(literal)).ready,true,name+' nested entity remains literal');
    assert.equal(nativeScreen(screen(escaped),input(decoded)).ready,false,name+' nested entity must not match decoded control');
  }
  const repeated='&amp;lt;&amp;gt;&lt;&gt;&amp;lt;';
  const result=nativeScreen(screen(repeated),input('&lt;&gt;<>&lt;'));
  assert.equal(result.ready,true);assert.equal(result.matches.length,1);
  assert.equal(nativeScreen(screen('&amp;lt;node package=&quot;com.android.settings&quot;&amp;gt;'),input('<node package="com.android.settings">')).ready,false);
});
