import sys
import json,subprocess
from pathlib import Path
root=Path(sys.argv[1]).resolve()
files=['crates/obsyncd/src/api/files.rs','crates/obsyncd/src/storage/mod.rs']
original={name:(root/name).read_text() for name in files};results=[]
mutations={
 'duplicate-files':(files[0],'if !distinct.insert(file) {','if distinct.insert(file) && false {'),
 'empty-batch':(files[0],'items.is_empty() || items.len() > 32','items.len() > 32'),
 'item-count':(files[0],'items.len() > 32','items.len() > 64'),
 'response-identities':(files[0],'.into_iter()\n        .zip(outcomes)','.into_iter().rev()\n        .zip(outcomes)'),
 'version-integrity':(files[1],'if expected != v.version_id {','if false {'),
 'batch-enqueue':(files[1],'''        let pending: Vec<_> = {
            let mut queue = self.versions();''','''        return posts.into_iter().map(|(v, accept_existing)| self.post_version(v, accept_existing, edit.clone())).collect();
        #[allow(unreachable_code)]
        let pending: Vec<_> = {
            let mut queue = self.versions();'''),
}
try:
 for name,(file,before,after) in mutations.items():
  assert original[file].count(before)==1,(name,original[file].count(before))
  (root/file).write_text(original[file].replace(before,after));runs=[]
  for _ in range(2):
   r=subprocess.run(['cargo','test','-p','obsyncd','--lib','version_batch','--','--test-threads=4'],cwd=root,capture_output=True,text=True,timeout=60)
   output=r.stdout+r.stderr
   assert r.returncode!=0 and 'panicked at' in output and 'could not compile' not in output,(name,output[-3500:])
   runs.append(r.returncode)
  results.append({'mutation':name,'runs':runs,'decision':'killed'});print(name,flush=True)
  (root/file).write_text(original[file])
  (Path(sys.argv[2]).resolve() / 'server-mutations-progress.json').write_text(json.dumps(results,indent=2)+'\n')
finally:
 for name,text in original.items():(root/name).write_text(text)
r=subprocess.run(['cargo','test','-p','obsyncd','--lib','version_batch','--','--test-threads=4'],cwd=root,capture_output=True,text=True,timeout=60);assert r.returncode==0,r.stdout+r.stderr
(Path(sys.argv[2]).resolve() / 'server-mutations.json').write_text(json.dumps({'results':results,'sourceRestored':all((root/name).read_text()==text for name,text in original.items()),'restoredTests':'PASS'},indent=2)+'\n')
