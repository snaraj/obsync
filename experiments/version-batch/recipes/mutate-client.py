import sys
import json,shutil,subprocess,tempfile
from pathlib import Path
source=Path(sys.argv[1]).resolve() / 'plugin'
root=Path(tempfile.mkdtemp(prefix='obsync-version-batch-mutant-'));results=[]
try:
 for name in ['src','vendor']:shutil.copytree(source/name,root/name)
 (root/'test').mkdir();shutil.copy2(source/'test/version-batch.test.mjs',root/'test/version-batch.test.mjs');shutil.copy2(source/'tsconfig.json',root/'tsconfig.json')
 file=root/'src/transport.ts';original=file.read_text()
 mutations={
 'no-scope-fence':('if (this.versionScope() !== scope) throw new SessionEnded();','if (false) throw new SessionEnded();'),
 'wrong-inner-id':('|| (status === 201 || !post.version.accept_existing) && fields.version_id !== post.version.version_id',''),
 'wrong-posted-id':('|| posted_version_id !== post.version.version_id',''),
 'wrong-file-id':('file_id !== post.fileId ||',''),
 'partial-ack':('value.results.length !== group.posts.length','false'),
 'all-errors-fallback':('error.status === 404 && error.code === "not_found"','error.status >= 400'),
 'no-group-cap':('if (group.posts.length === 32)','if (group.posts.length === 64)'),
 'large-body-grouped':('utf8(snapshot).length > 16 * 1024','false'),
 'same-file-grouped':('this.versionGroup.posts.some((post) => post.fileId === fileId)','false'),
 'no-immutable-snapshot':('const frozen = JSON.parse(snapshot) as VersionPost;','const frozen = version;'),
 'timer-strands-members':('for (const post of group.posts) post.reject(error);\n        };','reject(error);\n        };'),
 'queued-abort-ignored':('group.signal.addEventListener("abort", aborted, { once: true });',''),
 'signal-fence-removed':('if (signal?.aborted) throw new ApiError(0, "cancelled", "the sync push ended before sending");',''),
 'forget-keeps-generation':('this.versionEpoch++;',''),
 'same-shape-conflict':('|| fields.conflicted !== (fields.heads.length > 1)',''),
 'empty-heads':('fields.heads.length === 0 ||',''),
 }
 tsc=source/'node_modules/typescript/bin/tsc'
 def build():subprocess.run(['node',str(tsc),'-p',str(root/'tsconfig.json')],check=True,capture_output=True,text=True)
 build();subprocess.run(['node','--test',str(root/'test/version-batch.test.mjs')],check=True,capture_output=True,text=True)
 for name,(before,after) in mutations.items():
  assert original.count(before)==1,(name,original.count(before))
  file.write_text(original.replace(before,after));build();runs=[]
  for _ in range(2):
   r=subprocess.run(['node','--test',str(root/'test/version-batch.test.mjs')],capture_output=True,text=True,timeout=20)
   assert r.returncode!=0 and ('AssertionError' in r.stdout+r.stderr or 'cancelledByParent' in r.stdout+r.stderr),(name,r.stdout[-1000:],r.stderr)
   runs.append(r.returncode)
  results.append({'mutation':name,'runs':runs,'decision':'killed'});print(name,flush=True)
  (Path(sys.argv[2]).resolve() / 'client-mutations-progress.json').write_text(json.dumps(results,indent=2)+'\n')
 file.write_text(original);build();subprocess.run(['node','--test',str(root/'test/version-batch.test.mjs')],check=True,capture_output=True,text=True)
finally:shutil.rmtree(root)
(Path(sys.argv[2]).resolve() / 'client-mutations.json').write_text(json.dumps({'results':results,'scratchRemoved':not root.exists()},indent=2)+'\n')
