from pathlib import Path
import argparse,tempfile,subprocess,json

def main(argv=None):
 parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);args=parser.parse_args(argv)
 b=Path(__file__).parent;source=(b/'android-journey.mjs').read_text()
 mutants={
  'restore-premature-default-vault-guard':[("      `,{vaultPath:ownedVault(input.vaultPath)},false);","      `,{vaultPath:ownedVault(input.vaultPath)},true);")],
  'omit-foreign-refusal':[("          if(binding.pathPresent&&!binding.ownedVault)throw Error('foreign vault');",'')],
  'omit-malformed-refusal':[("          if(binding.pathPresent&&typeof path!=='string')throw Error('native vault path malformed');",'')],
  'start-budget-after-firstread':[("const started=Date.now(),end=started+20000;","let started,end;"),("const before=read();let after=before,polls=1,route=null;","const before=read();started=Date.now();end=started+20000;let after=before,polls=1,route=null;")],
  'omit-final-deadline':[("if(finished>end)route=null;",'')],
  'increase-freshentry-budget':[("const started=Date.now(),end=started+20000;","const started=Date.now(),end=started+21000;")],
  'bypass-trust-refusal':[("route=after.ownedVault?(${freshTrustRoute.toString()})(after):null;","route=after.ownedVault?'INITIAL_TRUST_MODAL':null;")],
  'disable-later-default-binding':[("${requireVault ? `if(window.app?.vault?.adapter?.basePath!==","${false ? `if(window.app?.vault?.adapter?.basePath!==")]
 }
 results=[]
 for name,edits in mutants.items():
  altered=source
  for needle,replacement in edits:assert altered.count(needle)==1,(name,needle,altered.count(needle));altered=altered.replace(needle,replacement)
  with tempfile.TemporaryDirectory(prefix='obsync-fresh-entry-mutant-') as tmp:
   p=Path(tmp);(p/'mobile').mkdir();(p/'android-journey.mjs').write_text(altered.replace("from './mobile/cdp.mjs'",f"from '{(b/'mobile/cdp.mjs').as_uri()}'"));(p/'mobile/fresh-trust-entry.test.mjs').write_bytes((b/'mobile/fresh-trust-entry.test.mjs').read_bytes())
   r=subprocess.run([args.node,'--test',str(p/'mobile/fresh-trust-entry.test.mjs')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=10)
   assert r.returncode and ('ERR_ASSERTION' in r.stdout or 'AssertionError' in r.stdout),(name,r.stdout)
   results.append({'mutation':name,'assertionKilled':True})
 print(json.dumps({'result':'PASS','count':len(results),'mutations':results}));return 0

if __name__=='__main__':raise SystemExit(main())
