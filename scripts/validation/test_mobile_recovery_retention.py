"""Offline fresh-C persisted evidence admission; no native applications/devices."""
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import shutil
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
FULL=Path(os.environ.get('OBSYNC_RECOVERY_FULL_SOURCE',HERE/'mobile-full.py'))
SPEC=importlib.util.spec_from_file_location('recovery_retained_full',FULL)
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)
HEAD='a'*40

def save(path,value):
    path.write_text(json.dumps(value,indent=2)+'\n');path.chmod(0o600)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

class RecoveryRetention(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='obsync-recovery-retained-');self.addCleanup(self.tmp.cleanup)
        self.run=Path(self.tmp.name).resolve();self.evidence=self.run/'evidence';self.folder=self.evidence/'recovery-C-readback';self.folder.mkdir(parents=True,mode=0o700)
        self.notes=[{'path':path,'sha256':hashlib.sha256(text).hexdigest(),'generation':generation} for path,text,generation in
                    [('Retained.md',b'# Retained\n\nSynthetic old content.\n','retained'),('Current.md',b'# Current\n\nSynthetic new content.\n','current')]]
        self.manifest={'schema':1,'sourceHead':HEAD,'generationHash':'b'*64,'notes':self.notes}
        save(self.folder/'expectations.json',self.manifest)
        exports=[]
        for i,data in enumerate((b'# Retained\n\nSynthetic old content.\n',b'# Current\n\nSynthetic new content.\n')):
            path=self.folder/(str(i)+'-desktop.bin');path.write_bytes(data);path.chmod(0o600)
            exports.append({'index':i,'path':'evidence/recovery-C-readback/'+path.name,'generation':self.notes[i]['generation'],
                            'expectedSha256':self.notes[i]['sha256'],'actualSha256':sha(path),'bytes':len(data),'exactHashMatched':True})
        self.result={'schema':1,'sourceHead':HEAD,'result':'PASS','expectationsSha256':sha(self.folder/'expectations.json'),'expectedCount':2,'exportedCount':2,'exports':exports}
        save(self.folder/'result.json',self.result)

    def refused(self):
        with self.assertRaises((ValueError,FileNotFoundError)):M.recovery_evidence(self.run,HEAD)

    def rebind_manifest(self):
        save(self.folder/'expectations.json',self.manifest);self.result['expectationsSha256']=sha(self.folder/'expectations.json');save(self.folder/'result.json',self.result)

    def test_actual_files_remain_admissible_after_private_and_runtime_cleanup(self):
        for name in ('private','runtime'):
            (self.run/name).mkdir();(self.run/name/'synthetic-input').write_text('disposable');shutil.rmtree(self.run/name)
        self.assertTrue(M.recovery_evidence(self.run,HEAD))

    def test_each_missing_empty_corrupt_export_or_manifest_result_refuses(self):
        for path in list(self.folder.iterdir()):
            original=path.read_bytes()
            for changed in (None,b'',original+b'!',b'X'+original[1:]):
                if changed is None:path.unlink()
                else:path.write_bytes(changed)
                self.refused();path.write_bytes(original);path.chmod(0o600)

    def test_every_manifest_and_export_result_field_is_required(self):
        for obj,path in ((self.manifest,self.folder/'expectations.json'),(self.result,self.folder/'result.json')):
            for key in obj:
                altered=dict(obj);del altered[key];save(path,altered);self.refused();save(path,obj)
        for index,note in enumerate(self.notes):
            for key in note:
                original=note[key];del note[key];self.rebind_manifest();self.refused();note[key]=original;self.rebind_manifest()
        for row in self.result['exports']:
            for key in tuple(row):
                value=row.pop(key);save(self.folder/'result.json',self.result);self.refused();row[key]=value;save(self.folder/'result.json',self.result)

    def test_source_manifest_hash_generation_paths_and_count_cannot_be_rebound_away(self):
        for field,value in [('sourceHead','f'*40),('generationHash','not-a-hash')]:
            original=self.manifest[field];self.manifest[field]=value;self.rebind_manifest();self.refused();self.manifest[field]=original;self.rebind_manifest()
        for field,value in [('sourceHead','f'*40),('expectationsSha256','0'*64),('result','FAIL'),('expectedCount',1),('exportedCount',1)]:
            old=self.result[field];self.result[field]=value;save(self.folder/'result.json',self.result);self.refused();self.result[field]=old;save(self.folder/'result.json',self.result)
        for field,value in [('path','../Retained.md'),('generation','current'),('sha256',self.notes[1]['sha256'])]:
            old=self.notes[0][field];self.notes[0][field]=value;self.rebind_manifest();self.refused();self.notes[0][field]=old;self.rebind_manifest()
        for field,value in [('index',1),('path','private/unowned.bin'),('generation','current'),('expectedSha256','0'*64),('actualSha256','0'*64),('bytes',1),('exactHashMatched',False)]:
            row=self.result['exports'][0];old=row[field];row[field]=value;save(self.folder/'result.json',self.result);self.refused();row[field]=old;save(self.folder/'result.json',self.result)
        self.result['exports'].pop();save(self.folder/'result.json',self.result);self.refused()

    def test_manifest_exact_bytes_are_bound_even_when_JSON_meaning_is_unchanged(self):
        path=self.folder/'expectations.json';path.write_bytes(path.read_bytes()+b'\n');self.refused()

    def test_actual_terminal_admission_requires_the_retained_fresh_C_bytes(self):
        save(self.evidence/'full-native-journeys.json',{'schema':1,'sourceHead':HEAD,'result':'PASS','journeys':['fresh-recovery-J11']})
        save(self.evidence/'full-fresh-recovery-J11.json',{'schema':1,'sourceHead':HEAD,'result':'PASS'})
        source=Path(os.environ.get('OBSYNC_RECOVERY_ADMISSION_SOURCE',HERE/'mobile-acceptance.py')).read_text()
        node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='full_journey_receipt')
        # Selected retention has a separate real-export admission integration test.
        loader=SimpleNamespace(exec_module=lambda module:None)
        imports=SimpleNamespace(util=SimpleNamespace(spec_from_file_location=lambda *a:SimpleNamespace(loader=loader),
            module_from_spec=lambda spec:SimpleNamespace(selected_evidence=lambda *a:True,recovery_evidence=M.recovery_evidence)))
        def need(ok,*_):
            if not ok:raise ValueError('phase refused')
        env=dict(private_json=lambda p:json.loads(p.read_text()),require=need,FULL_NATIVE_PHASES=('fresh-recovery-J11',),FULL_PHASE_FACTS={'fresh-recovery-J11':{}},FULL_PHASE_BOUNDS={},importlib=imports,helper=lambda n:str(HERE/n))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'actual-terminal-admission','exec'),env)
        self.assertEqual(env['full_journey_receipt'](self.run,HEAD)['result'],'PASS')
        (self.folder/'1-desktop.bin').unlink()
        with self.assertRaises((ValueError,FileNotFoundError)):env['full_journey_receipt'](self.run,HEAD)

if __name__=='__main__':unittest.main()
