"""Fake-clock whole-attempt admission; no native process/device is started."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace,ModuleType
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('timing_acceptance',Path(__file__).with_name('mobile-acceptance.py'))
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)
HEAD='a'*40


def timed(wall,monotonic):
    with patch.object(M.time,'time',return_value=1000+wall),patch.object(M.time,'monotonic',return_value=100+monotonic):
        return M.attempt_timing(1000,100,HEAD)


def outer_fixture(module,wall_elapsed,monotonic_elapsed,child_failure=False):
    with tempfile.TemporaryDirectory(prefix='obsync-attempt-timing-') as tmp:
        root=Path(tmp).resolve();source=root/'source';source.mkdir();config=root/'config.json';out=root/'result'
        module.save(config,{'schema':1,'source':str(source),'sourceHead':HEAD,'seconds':600,'android':{'sourceHead':HEAD}})
        # Port availability and route provenance have independent focused suites.
        # This fixture exercises whole-attempt timing without host socket/device calls.
        route_proof={'schema':1,'sourceHead':HEAD,'result':'PASS','scope':'OFFLINE_TIMING_FIXTURE'}
        args=SimpleNamespace(config=config,out=out,runs=1,mode='core');clocks={'wall':1000.,'mono':100.};marker_bytes=None
        def command(argv,**kwargs):
            nonlocal marker_bytes
            attempt=out/'attempt-01';evidence=attempt/'desktop/evidence';evidence.mkdir(parents=True)
            module.save(evidence/'peer-result.json',{'sourceHead':HEAD,'result':'FAIL' if child_failure else 'CORE_ONLY',
                'cleanup':'PASS','ownedGroupsRemaining':0,'runtimeAbsent':True,'privateAbsent':True,'manifestAbsent':True})
            module.save(evidence/'core-result.json',{'result':'CORE_ONLY','fullAcceptance':'NOT_RUN'})
            module.save(attempt/'evidence/isolated-tcp-admission.json',route_proof)
            if child_failure:
                first=attempt/'evidence/first-failure.json';module.save(first,{'firstFailure':'synthetic_child_refusal','failureClass':'PRODUCT_REFUSAL'});marker_bytes=first.read_bytes()
            clocks['wall']+=wall_elapsed;clocks['mono']+=monotonic_elapsed
            return SimpleNamespace(returncode=1 if child_failure else 0)
        def git(argv,**kwargs):return str(root/'common/.git')+'\n' if '--git-common-dir' in argv else HEAD+'\n'
        with patch.object(module.subprocess,'check_output',side_effect=git),patch.object(module.subprocess,'run',side_effect=command),\
             patch.object(module,'helper',return_value='/unused-offline-helper'),patch.object(module,'driver_inventory',return_value={}),\
             patch.object(module,'fixed_port_preflight',return_value={'schema':1,'sourceHead':HEAD,'result':'PASS','checks':[{'role':'tls','port':18473,'status':'AVAILABLE'}]}) as preflight,\
             patch.object(module,'isolated_tcp_evidence',return_value=route_proof) as route_evidence,\
             patch.object(module.socket,'socket',side_effect=AssertionError('timing fixture must not bind host sockets')),\
             patch.object(module,'recheck_drivers'),patch.object(module.shutil,'disk_usage',return_value=SimpleNamespace(free=30*1024**3)),\
             patch.object(module.time,'time',side_effect=lambda:clocks['wall']),patch.object(module.time,'monotonic',side_effect=lambda:clocks['mono']),contextlib.redirect_stdout(io.StringIO()):
            code=module.outer(args)
        preflight.assert_called_once()
        route_evidence.assert_called_once_with(out/'attempt-01/android',HEAD,'core')
        row=json.loads((out/'attempt-01/evidence/attempt-result.json').read_text());result=json.loads((out/'result.json').read_text())
        path=out/'attempt-01/evidence/attempt-timing.json';proof=json.loads(path.read_text())
        assert row['hostTiming']==proof and row['hostTimingSha256']==hashlib.sha256(path.read_bytes()).hexdigest()
        if child_failure:assert marker_bytes==(out/'attempt-01/evidence/first-failure.json').read_bytes()
        return code,row,result,proof


class AttemptTiming(unittest.TestCase):
    def test_fake_clock_ordinary_elapsed_and_fixed_tolerance_boundary(self):
        for wall,mono in [(100,100),(105,100),(95,100),(0,0)]:
            value=timed(wall,mono);self.assertTrue(M.valid_attempt_timing(value,HEAD));self.assertEqual(value['uncertainty'],'NONE')
            self.assertEqual(value['wallElapsedMs'],round(wall*1000));self.assertEqual(value['monotonicElapsedMs'],round(mono*1000))
        for wall,mono in [(105.001,100),(94.999,100),(700,100),(100,700),(-1,0),(0,-1)]:
            value=timed(wall,mono);self.assertFalse(M.valid_attempt_timing(value,HEAD));self.assertEqual(value['result'],'FAIL');self.assertEqual(value['uncertainty'],'HOST_SUSPEND_OR_CLOCK_CHANGE')

    def test_terminal_summary_requires_source_bound_consistent_measured_timing(self):
        timing=timed(100,100);row={'attempt':'one','result':'CORE_ONLY','cleanup':'PASS','hostTiming':timing,'hostTimingSha256':'b'*64}
        self.assertEqual(M.summary([row],1,'core',HEAD)['result'],'CORE_ONLY')
        broken=[None,timing|{'sourceHead':'b'*40},timing|{'differenceMs':6000},timing|{'wallElapsedMs':True},timing|{'toleranceMs':600000},timed(700,100)]
        for value in broken:self.assertEqual(M.summary([row|{'hostTiming':value}],1,'core',HEAD)['result'],'FAIL')
        self.assertEqual(M.summary([{k:v for k,v in row.items() if k!='hostTimingSha256'}],1,'core',HEAD)['result'],'FAIL')
        full=[row|{'attempt':str(i),'result':'FULL_PASS'} for i in range(3)];self.assertEqual(M.summary(full,3,'full',HEAD)['result'],'PASS')
        full[1]=full[1]|{'hostTiming':timed(700,100)};self.assertEqual(M.summary(full,3,'full',HEAD)['result'],'FAIL')

    def test_actual_outer_refuses_host_gap_or_backward_wall_and_retains_both_elapsed_values(self):
        for wall,mono,accepted in [(100,100,True),(700,100,False),(100,700,False),(-1,100,False)]:
            code,row,result,proof=outer_fixture(M,wall,mono)
            self.assertEqual(code,0 if accepted else 1);self.assertEqual(row['result'],'CORE_ONLY' if accepted else 'FAIL')
            self.assertEqual(proof['wallElapsedMs'],round(wall*1000));self.assertEqual(proof['monotonicElapsedMs'],round(mono*1000))
            self.assertEqual(row['cleanup'],'PASS');self.assertEqual(result['result'],'CORE_ONLY' if accepted else 'FAIL')
            if not accepted:self.assertEqual(row['firstFailure'],'host_timing_discontinuity');self.assertEqual(row['timingRefusal'],'HOST_SUSPEND_OR_CLOCK_CHANGE')

    def test_timing_refusal_never_overwrites_original_child_failure_or_failed_receipt(self):
        _,row,result,proof=outer_fixture(M,700,100,True)
        self.assertEqual(row['firstFailure'],'synthetic_child_refusal');self.assertEqual(row['failureClass'],'PRODUCT_REFUSAL')
        self.assertEqual(row['timingRefusal'],'HOST_SUSPEND_OR_CLOCK_CHANGE');self.assertEqual(proof['result'],'FAIL');self.assertEqual(result['result'],'FAIL')

    def test_actual_guard_removal_is_killed_by_the_same_outer_sleep_control(self):
        # Compile the actual source with only the admission predicate removed.
        source=Path(M.__file__).read_text();start=source.index('def valid_attempt_timing(');end=source.index('\ndef load_controller():',start)
        changed=source[:start]+"def valid_attempt_timing(proof, source_head):\n    return True\n\n"+source[end:]
        mutant=ModuleType('offline_timing_mutant');mutant.__file__=M.__file__
        exec(compile(changed,M.__file__,'exec'),mutant.__dict__)
        code,row,result,proof=outer_fixture(mutant,700,100)
        self.assertEqual(proof['result'],'FAIL');self.assertEqual(row['result'],'CORE_ONLY');self.assertEqual(result['result'],'CORE_ONLY');self.assertEqual(code,0)
        with self.assertRaises(AssertionError):self.assertEqual(row['result'],'FAIL','actual outer sleep-control kills guard removal')


if __name__=='__main__':unittest.main()
