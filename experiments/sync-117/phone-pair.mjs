// Native creator half of the disposable phone rehearsal. Secret values stay in private files.
import { readFileSync, writeFileSync, lstatSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [tooling, run, command] = process.argv.slice(2);
const { manifest, connect } = await import(pathToFileURL(resolve(tooling, 'scripts/validation/lab/cdp.mjs')));
const state = manifest(run), c = await connect(state, 'A');
const privatePath = name => join(state.run, 'runtime', name);
function record(value) {
  const receipt = { at: new Date().toISOString(), command, ...value };
  writeFileSync(join(state.run, 'evidence', `phone-creator-${command}-${Date.now()}.json`), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
function privateValue(name, shape) {
  const path = privatePath(name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw Error('private input custody');
  const value = readFileSync(path, 'utf8').trim();
  if (!shape.test(value)) throw Error('private input shape');
  return value;
}
try {
  if (command === 'generate' || command === 'regenerate') {
    if (command === 'regenerate') {
      const dialogs = await c.evaluate(`const modals=[...document.querySelectorAll('.modal-container')].filter(m=>!m.querySelector('.mod-settings'));
        return {count:modals.length,creatorTitles:modals.filter(m=>m.querySelector('.modal-title')?.textContent.trim()==='Pair a new device').length};`);
      if(dialogs.count>1 || dialogs.count!==dialogs.creatorTitles){record({result:'REFUSED',stage:'creator-dialog-identity',dialogs});throw Error('creator dialog identity');}
      if(dialogs.count===1){await c.keyEvent('keyDown','Escape','Escape');await c.keyEvent('keyUp','Escape','Escape');}
      await c.evaluate(`
        await wait(()=>![...document.querySelectorAll('.modal-container')].some(m=>!m.querySelector('.mod-settings')),'creator dialog closed');return true;`);
      for (const name of ['phone-pair-code.txt','phone-creator-match.txt','phone-observed-match.txt']) {
        if (!existsSync(privatePath(name))) continue;
        privateValue(name, name==='phone-pair-code.txt'?/^[A-Z2-7]{128}$/:/^[0-9]{3} [0-9]{3}$/);
        unlinkSync(privatePath(name));
      }
    }
    const code = await c.evaluate(`
      const p=app.plugins.plugins['obsync-private-sync'];
      if(!p.state.paired || p.state.data.serverUrl!==P.url || [...document.querySelectorAll('.modal-container')].some(m=>!m.querySelector('.mod-settings'))) throw Error('creator not ready');
      app.setting.close(); window.labPairing=[];
      if(window.labPairingTap!==p) { window.labPairingTap=p; const previous=p.log.bind(p); p.log=line=>{ if(/^pairing role=creator decision=/.test(line)) window.labPairing.push({at:Date.now(),decision:/decision=([^ ]+)/.exec(line)?.[1]}); return previous(line); }; }
      app.commands.executeCommandById('obsync-private-sync:pair-device');
      return await wait(()=>document.querySelector('.modal pre.obsync-code')?.textContent.trim(),'native creator code');`);
    if(!/^[A-Z2-7]{128}$/.test(code))throw Error('private code shape');
    writeFileSync(privatePath('phone-pair-code.txt'), code, {mode:0o600,flag:'wx'});
    record({result:'READY',privateCodeFileWritten:true});
  } else if(command === 'match') {
    const code=await c.evaluate(`return await wait(()=>/the code ([0-9]{3} [0-9]{3})/.exec([...document.querySelectorAll('.modal:not(.mod-settings)')].map(m=>m.textContent).join(' '))?.[1]??null,'native creator comparison');`);
    if(!/^[0-9]{3} [0-9]{3}$/.test(code))throw Error('private match shape');
    writeFileSync(privatePath('phone-creator-match.txt'),code,{mode:0o600,flag:'wx'});
    record({result:'READY',privateMatchFileWritten:true});
  } else if(command === 'approve') {
    const expected=privateValue('phone-observed-match.txt',/^[0-9]{3} [0-9]{3}$/);
    const approved=await c.evaluate(`const modal=[...document.querySelectorAll('.modal:not(.mod-settings)')].find(m=>/the code ([0-9]{3} [0-9]{3})/.test(m.textContent)); const actual=/the code ([0-9]{3} [0-9]{3})/.exec(modal?.textContent??'')?.[1]; const approve=[...modal?.querySelectorAll('button')??[]].find(b=>b.textContent.trim()==='Approve'); if(actual!==P.expected||!approve||approve.disabled)throw Error('native comparison refused');approve.click();return true;`,{expected});
    record({result:'APPROVED',comparedIndependentPhoneCode:true,approved});
  } else if(command === 'status') {
    record(await c.evaluate(`const p=app.plugins.plugins['obsync-private-sync'],s=p.currentStatus();return {paired:p.state.paired,status:s.kind,pending:s.pending,files:Object.keys(p.state.data.files).length,creatorDecisions:window.labPairing??[],pairingCodeVisible:!!document.querySelector('.obsync-code'),matchCodeVisible:/the code [0-9]{3} [0-9]{3}/.test([...document.querySelectorAll('.modal')].map(m=>m.textContent).join(' ')),approveVisible:!!button('Approve')};`));
  } else throw Error('unknown command');
} catch {
  record({result:'FAIL',reason:'native creator step refused or timed out; secret-bearing details withheld'});
  process.exitCode=1;
} finally { c.close(); }
