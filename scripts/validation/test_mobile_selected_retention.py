"""Offline retained-evidence controls; no native apps, ports, or devices."""
import ast
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FULL_PATH = Path(os.environ.get('OBSYNC_SELECTED_FULL_SOURCE', HERE / 'mobile-full.py'))
spec = importlib.util.spec_from_file_location('selected_full', FULL_PATH)
full = importlib.util.module_from_spec(spec); spec.loader.exec_module(full)
spec = importlib.util.spec_from_file_location('selected_bytes', HERE / 'mobile-evidence.py')
byte_oracle = importlib.util.module_from_spec(spec); spec.loader.exec_module(byte_oracle)
SOURCE = FULL_PATH.read_text()
HEAD = 'a' * 40

def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n'); path.chmod(0o600)

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def nested(name):
    tree = ast.parse(SOURCE)
    run = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
    node = next(n for n in run.body if isinstance(n, ast.FunctionDef) and n.name == name)
    return compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(FULL_PATH), 'exec')

class Retention(unittest.TestCase):
    def setUp(self):
        previous_umask = os.umask(0o077); self.addCleanup(os.umask, previous_umask)
        self.tmp = tempfile.TemporaryDirectory(prefix='obsync-selected-offline-'); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve(); self.desktop = self.root / 'desktop'; self.android = self.root / 'android'
        for p in (self.desktop / 'evidence', self.desktop / 'runtime/A/Lab-A', self.android / 'private'): p.mkdir(parents=True, mode=0o700)
        self.vault = self.desktop / 'runtime/A/Lab-A'
        save(self.desktop / 'lab.json', {'run': str(self.desktop), 'devices': {'A': {'vault': str(self.vault)}}, 'source_head': HEAD})
        self.notes = [{'path': 'Team docs/One.md', 'text': '# One\n\nSynthetic one.\n'}, {'path': 'Team docs/Two.md', 'text': '# Two\n\nSynthetic two.\n'}]
        class Controller:
            def live_state(inner, _run): return {'sourceHead': HEAD}
            def adb_command(inner, _state, argv, binary=False):
                if argv[:2] == ['exec-out', 'cat']: return b'broken synthetic bytes' if getattr(self,'android_corrupt',False) else (self.vault / argv[2].split('/Documents/Obsync-Selected/', 1)[1]).read_bytes()
                return b''
        self.original_loader = byte_oracle.load_controller; byte_oracle.load_controller = lambda _: Controller()
        self.addCleanup(setattr, byte_oracle, 'load_controller', self.original_loader)
        def steps(stage, argv, **kwargs):
            opts = {argv[i][2:].replace('-', '_'): argv[i+1] for i in range(3, len(argv), 2)}
            args = SimpleNamespace(**{k: Path(v) if k != 'android_vault' else v for k, v in opts.items()})
            with contextlib.redirect_stdout(io.StringIO()): code = byte_oracle.observe(args)
            if code: raise RuntimeError('actual byte helper refused')
            return json.loads((args.output / 'result.json').read_text())
        self.env = dict(notes=self.notes, android=self.android, desktop=self.desktop, save=save,
                        steps=SimpleNamespace(run=steps), sys=SimpleNamespace(executable='python3'), helper=lambda n: str(HERE/n),
                        vault='/storage/emulated/0/Documents/Obsync-Selected', require=lambda ok,*_: self.assertTrue(ok), hashlib=hashlib, c={'sourceHead': HEAD})
        exec(nested('both_bytes'), self.env)

    def fixture(self):
        exports=[]
        for label in ('seed', 'down', 'down-quiet', 'up', 'up-quiet'):
            folder='team docs' if label in ('down','down-quiet') else 'Team docs'
            notes=[{**n,'path':folder+'/'+n['path'].split('/')[-1]} for n in self.notes]
            for n in notes:
                p=self.vault/n['path']; p.parent.mkdir(exist_ok=True); p.write_text(n['text'])
            exports.append(self.env['both_bytes']('selected-'+label, notes))
        snapshots=[]
        for label,command in zip(('original','down','quiet-down','up','quiet-up'),('rename','before','watch-down','returned','watch-up')):
            folder='team docs' if label in ('down','quiet-down') else 'Team docs'
            notes=[{'suffix':n['path'].split('/')[-1], 'fileId':str(i+1)*32, 'versionId':str(i+3)*64, 'sha256':hashlib.sha256(n['text'].encode()).hexdigest()} for i,n in enumerate(self.notes)]
            records=[{'fileId':n['fileId'],'heads':[n['versionId']],'versions':[{'id':n['versionId'],'parents':[],'deleted':False}]} for n in notes]
            records.append({'fileId':'d'*32,'heads':['d'*64],'versions':[{'id':'d'*64,'parents':[],'deleted':False}]})
            path=self.desktop/'evidence'/('selected-snapshot-'+label+'.json');save(path,{'schema':1,'sourceHead':HEAD,'generation':'b'*32,'folder':folder,'notes':notes,'records':records})
            entry={'label':label,'path':str(path.relative_to(self.desktop)),'sha256':sha(path),'bytes':path.stat().st_size};snapshots.append(entry)
            save(self.desktop/'evidence'/('selected-desktop-'+command+'.json'), {'result':'PASS','sourceHead':HEAD,'retainedSnapshots':[entry]})
        phase={'retainedByteExports':exports,'retainedServerSnapshots':snapshots}; save(self.desktop/'evidence/full-selected-rename.json',phase)
        return phase

    def test_real_byte_helper_and_retained_manifest_survive_private_deletion(self):
        phase=self.fixture()
        import shutil
        shutil.rmtree(self.android/'private'); (self.desktop/'lab.json').unlink()
        self.assertTrue(full.selected_evidence(self.desktop, HEAD))
        self.assertEqual(len(phase['retainedByteExports']),5)

    def test_failed_actual_byte_helper_retains_mapping_and_failed_bytes_before_cleanup(self):
        for n in self.notes:
            p=self.vault/n['path'];p.parent.mkdir(exist_ok=True);p.write_text(n['text'])
        self.android_corrupt=True
        with self.assertRaises(RuntimeError):self.env['both_bytes']('selected-failed',self.notes)
        import shutil
        shutil.rmtree(self.android/'private');shutil.rmtree(self.desktop/'runtime');(self.desktop/'lab.json').unlink()
        manifest=self.desktop/'evidence/independent-bytes-selected-failed-fixtures.json'
        output=self.desktop/'evidence/independent-bytes-selected-failed'
        self.assertEqual(json.loads(manifest.read_text()),self.notes)
        self.assertEqual((output/'0-android.bin').read_bytes(),b'broken synthetic bytes')
        self.assertEqual((output/'0-desktop.bin').read_bytes(),self.notes[0]['text'].encode())
        result=json.loads((output/'result.json').read_text());self.assertEqual(result['result'],'FAIL')
        self.assertEqual(result['fixtureManifestSha256'],sha(manifest))

    def test_each_missing_empty_or_tampered_actual_export_refuses(self):
        self.fixture()
        paths=[self.desktop/'evidence/independent-bytes-selected-down'/name for name in ('0-android.bin','0-desktop.bin','1-android.bin','1-desktop.bin','result.json')]
        paths.append(self.desktop/'evidence/independent-bytes-selected-down-fixtures.json')
        for path in paths:
            original=path.read_bytes()
            for value in (None,b'',original+b'!'):
                if value is None:path.unlink()
                else:path.write_bytes(value)
                with self.assertRaises((ValueError, FileNotFoundError)):full.selected_evidence(self.desktop, HEAD)
                path.write_bytes(original)

    def test_every_snapshot_and_command_binding_is_required(self):
        self.fixture()
        for label,command in zip(('original','down','quiet-down','up','quiet-up'),('rename','before','watch-down','returned','watch-up')):
            for filename in ('selected-snapshot-'+label+'.json','selected-desktop-'+command+'.json'):
                path=self.desktop/'evidence'/filename; original=path.read_bytes();path.unlink()
                with self.assertRaises((ValueError,FileNotFoundError)):full.selected_evidence(self.desktop,HEAD)
                path.write_bytes(original+b'!')
                with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD)
                path.write_bytes(original)

    def test_source_path_count_and_manifest_bindings_refuse(self):
        phase=self.fixture()
        for mutate in (lambda p:p['retainedByteExports'].pop(),lambda p:p['retainedServerSnapshots'].pop(),lambda p:p['retainedByteExports'][0].update(fixtureManifestPath='private/elsewhere.json'),lambda p:p['retainedByteExports'][0].update(resultSha256='0'*64),lambda p:p['retainedServerSnapshots'][0].update(sha256='0'*64)):
            p=json.loads(json.dumps(phase));mutate(p)
            with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD,p)
        with self.assertRaises(ValueError):full.selected_evidence(self.desktop,'f'*40)
        # Rebinding the byte digest cannot disguise a wrong-source helper result.
        entry=phase['retainedByteExports'][0]; path=self.desktop/entry['resultPath']; result=json.loads(path.read_text());result['sourceHead']='f'*40;save(path,result);entry['resultSha256']=sha(path)
        with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD,phase)

    def test_valid_json_tampering_requires_exact_digest_bindings(self):
        phase=self.fixture()
        for path in (self.desktop/'evidence/independent-bytes-selected-down-fixtures.json', self.desktop/'evidence/independent-bytes-selected-down/result.json', self.desktop/'evidence/selected-snapshot-down.json'):
            original=path.read_bytes(); value=json.loads(original)
            if isinstance(value,list): value[0]['untrustedExtra']=True
            else: value['untrustedExtra']=True
            save(path,value)
            with self.assertRaises(ValueError): full.selected_evidence(self.desktop,HEAD,phase)
            path.write_bytes(original)
        for key in ('bytes','sha256'):
            p=json.loads(json.dumps(phase));p['retainedServerSnapshots'][0][key]=1 if key=='bytes' else '0'*64
            with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD,p)
        # Source mismatch must refuse even when its snapshot digest is rebound.
        entry=phase['retainedServerSnapshots'][0];path=self.desktop/entry['path'];value=json.loads(path.read_text());value['sourceHead']='f'*40;save(path,value);entry.update(sha256=sha(path),bytes=path.stat().st_size)
        emitted=self.desktop/'evidence/selected-desktop-rename.json';save(emitted,{'result':'PASS','sourceHead':HEAD,'retainedSnapshots':[entry]})
        with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD,phase)

    def test_snapshot_digest_and_length_are_independently_enforced(self):
        phase=self.fixture()
        entry=phase['retainedServerSnapshots'][0];path=self.desktop/entry['path'];original=path.read_bytes()
        changed=original.replace(('"fileId": "'+'d'*32+'"').encode(), ('"fileId": "'+'e'*32+'"').encode())
        self.assertNotEqual(changed,original);self.assertEqual(len(changed),len(original));path.write_bytes(changed)
        with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD,phase)
        path.write_bytes(original);entry['bytes']=1
        save(self.desktop/'evidence/selected-desktop-rename.json',{'result':'PASS','sourceHead':HEAD,'retainedSnapshots':[entry]})
        with self.assertRaises(ValueError):full.selected_evidence(self.desktop,HEAD,phase)

    def test_actual_terminal_admission_requires_persisted_selected_files(self):
        phase=self.fixture();phase.update(schema=1,result='PASS',sourceHead=HEAD)
        save(self.desktop/'evidence/full-selected-rename.json',phase)
        save(self.desktop/'evidence/full-native-journeys.json',{'schema':1,'result':'PASS','sourceHead':HEAD,'journeys':['selected-rename']})
        source=Path(os.environ.get('OBSYNC_SELECTED_ADMISSION_SOURCE',HERE/'mobile-acceptance.py')).read_text()
        node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='full_journey_receipt')
        def need(ok,*_):
            if not ok:raise ValueError('phase refused')
        # The adjacent recovery validator has its own real-export terminal test.
        loader=SimpleNamespace(exec_module=lambda module:None)
        imports=SimpleNamespace(util=SimpleNamespace(spec_from_file_location=lambda *a:SimpleNamespace(loader=loader),
            module_from_spec=lambda spec:SimpleNamespace(selected_evidence=full.selected_evidence,recovery_evidence=lambda *a:True)))
        env=dict(private_json=lambda p:json.loads(p.read_text()), require=need,FULL_NATIVE_PHASES=('selected-rename',),
                 FULL_PHASE_FACTS={'selected-rename':{}},FULL_PHASE_BOUNDS={},importlib=imports,helper=lambda n:str(FULL_PATH if n=='mobile-full.py' else HERE/n))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'actual-admission','exec'),env)
        self.assertEqual(env['full_journey_receipt'](self.desktop,HEAD)['result'],'PASS')
        (self.desktop/'evidence/independent-bytes-selected-up/0-android.bin').unlink()
        with self.assertRaises((ValueError,FileNotFoundError)):env['full_journey_receipt'](self.desktop,HEAD)

    def test_actual_selected_phase_exports_all_five_exact_cases(self):
        begin=SOURCE.index("    native('selected-folder-seed'");end=SOURCE.index('\n    # Fresh B/D/C recovery:',begin)
        block=SOURCE[begin:end]
        calls=[]
        def native(stage,file,command,**kwargs):
            role={'rename':'original','before':'down','returned':'up','watch-down':'quiet-down','watch-up':'quiet-up'}.get(command)
            return {'retainedSnapshots':[{'label':role}] if role else [],'watchMs':300000}
        env=dict(native=native, private=lambda p:self.notes[0] if 'one' in str(p) else self.notes[1], desktop=self.desktop, android=self.android,
                 phone_reads=lambda *a:None, both_bytes=lambda label,notes:(calls.append((label,[n['path'] for n in notes])) or {'label':label}),
                 phone=lambda *a: {'descendants':2},require=lambda *a:None,android_case_rename=lambda *a:1,
                 selected_evidence=lambda *a:None, receipt=lambda *a,**k:None, metadata=lambda *a:None,c={'sourceHead':HEAD})
        exec('def action():\n'+block,env);env['action']()
        self.assertEqual(calls, [('selected-'+label,[folder+'/One.md',folder+'/Two.md']) for label,folder in [('seed','Team docs'),('down','team docs'),('down-quiet','team docs'),('up','Team docs'),('up-quiet','Team docs')]])

if __name__=='__main__': unittest.main()
