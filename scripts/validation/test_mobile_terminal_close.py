"""Production terminal-close contracts with fake children/clocks; no native app."""
import ast
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
HEAD='a'*40


def extract(name,file,namespace):
    tree=ast.parse((HERE/file).read_text())
    node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name==name)
    exec(compile(ast.Module(body=[node],type_ignores=[]),str(HERE/file),'exec'),namespace)
    return namespace[name]


class Clock:
    def __init__(self):self.now=0
    def monotonic(self):return self.now
    def sleep(self,seconds):self.now+=seconds


class TerminalClose(unittest.TestCase):
    def exercise(self,*,slot='A',mode='core',exit_code=0,delay=0,live_group=False,android_bad=False,tls_code=0,diagnostic_bad=None,complete_bad=None):
        clock=Clock();calls=[];desktop=SimpleNamespace(pid=123);tls=SimpleNamespace(pid=456)
        owner=SimpleNamespace(run=Path('/synthetic/desktop'),children={slot:desktop,'tls':tls})
        def stop_one(name,term_seconds):
            self.assertEqual((name,term_seconds),('tls',90));self.assertIs(owner.children[slot],desktop);calls.append('tls-stop');return tls_code
        owner.stop_one=stop_one
        android={'result':'PASS','sourceHead':HEAD,'cleanup':'PASS','ownedGroupsRemaining':0,'runtimeAbsent':True,'privateAbsent':True,'manifestAbsent':True}
        if android_bad:android['cleanup']='FAIL'
        diagnostic={'result':'CLOSED','sourceHead':HEAD,'tlsPid':456,'recorderNaturalEof':True,'tlsActiveSockets':0,'recorderPendingConnections':0,
                    'recorderConnectionsWithoutUpstreamEof':0,'indexPartialRow':False,'drainDeadlineMs':70000,'drainMs':200,'recorderErrors':[],
                    'recorderConnections':2,'completedRecorderConnections':2,'code':'recorder_drain_deadline'}
        diagnostic.update(diagnostic_bad or {})
        complete={'connections':2,'errors':[]};complete.update(complete_bad or {})
        def private(path):return android if path.name=='result.json' else diagnostic
        def capture(run,c):calls.append('capture-manifest');return complete,'hash'
        common=SimpleNamespace(exit_code=lambda child:exit_code if clock.now>=delay else None,
                               group_members=lambda pid:[(pid,'S' if live_group else 'Z')])
        operation=extract('terminal_transport_close','mobile-session.py',{'COMMON':common,'time':clock,'private_json':private,'capture_manifest':capture})
        result=operation(owner,{'mode':mode,'sourceHead':HEAD},slot,'terminal',100)
        self.assertEqual(calls,['tls-stop','capture-manifest']);self.assertIs(owner.children[slot],desktop)
        return result,clock

    def test_natural_quit_is_observed_unreaped_then_only_tls_gets90s_grace(self):
        result,clock=self.exercise(delay=.2)
        self.assertGreaterEqual(clock.now,.2);self.assertLess(clock.now,15)
        self.assertEqual(result['naturalDesktopQuitExitCode'],0);self.assertTrue(result['desktopGroupNaturallyAbsent']);self.assertTrue(result['recorderNaturalEof'])
        self.assertEqual(result['closeProtocol'],'NATURAL_EOF_90S')
        self.assertEqual(self.exercise(slot='C',mode='acceptance')[0]['desktopSlot'],'C')

    def test_nonzero_live_or_missing_android_cleanup_cannot_close_transport(self):
        for changes,error in [({'exit_code':1},RuntimeError),({'live_group':True},TimeoutError),({'delay':20},TimeoutError),({'android_bad':True},ValueError),({'slot':'B'},ValueError)]:
            with self.subTest(changes=changes),self.assertRaises(error):self.exercise(**changes)

    def test_actual_recorder_failure_enum_survives_before_parent_signals_child(self):
        with self.assertRaisesRegex(RuntimeError,'recorder close failed: recorder_drain_deadline; exit=1'):
            self.exercise(tls_code=1)

    def test_complete_rows_eof_source_pid_deadline_and_error_proof_all_required(self):
        for field,value in [('sourceHead','b'*40),('tlsPid',999),('recorderNaturalEof',False),('tlsActiveSockets',1),('recorderPendingConnections',1),
                            ('recorderConnectionsWithoutUpstreamEof',1),('indexPartialRow',True),('drainDeadlineMs',80000),('drainMs',70001),
                            ('recorderErrors',['recorder_truncated']),('recorderConnections',3),('completedRecorderConnections',1)]:
            with self.subTest(field=field),self.assertRaisesRegex(RuntimeError,'drain proof refused'):self.exercise(diagnostic_bad={field:value})
        for complete in ({'errors':['recorder_truncated']},{'connections':0}):
            with self.assertRaises(RuntimeError):self.exercise(complete_bad=complete)


class RunnerProtocol(unittest.TestCase):
    def test_close_request_has_explicit90s_protocol_and_requires_natural_eof_receipt(self):
        for bad in (None,'recorderNaturalEof','naturalDesktopQuitExitCode','closeProtocol'):
            with tempfile.TemporaryDirectory(prefix='obsync-terminal-protocol-') as tmp:
                run=Path(tmp);(run/'private').mkdir();clock=Clock()
                proof={'requestId':'core-close-transport','result':'CLOSED','ownedGroupAbsent':True,'naturalDesktopQuitExitCode':0,
                       'desktopGroupNaturallyAbsent':True,'recorderNaturalEof':True,'drainDeadlineMs':70000,'closeProtocol':'NATURAL_EOF_90S'}
                if bad:proof[bad]='wrong'
                def save(path,body):
                    self.assertEqual(body['protocol'],'NATURAL_EOF_90S');path.write_text(json.dumps(body))
                    (run/'private/close-transport-result.json').write_text(json.dumps(proof))
                def require(ok,stage):
                    if not ok:raise ValueError(stage)
                operation=extract('lifecycle_request','mobile-acceptance.py',{'save':save,'private_json':lambda path:json.loads(path.read_text()),'time':clock,'require':require,'StageFailure':ValueError})
                if bad:
                    with self.assertRaisesRegex(ValueError,'transport_close_receipt'):operation(run,'close-transport.json','CLOSED')
                else:operation(run,'close-transport.json','CLOSED')

    def test_terminal_protocol_deadline_is90_without_changing_journey_waiters(self):
        with tempfile.TemporaryDirectory(prefix='obsync-terminal-deadline-') as tmp:
            run=Path(tmp);(run/'private').mkdir();clock=Clock()
            operation=extract('lifecycle_request','mobile-acceptance.py',{'save':lambda path,body:None,'private_json':None,'time':clock,'require':lambda ok,stage:None,'StageFailure':ValueError})
            with self.assertRaisesRegex(ValueError,'transport_close_deadline'):operation(run,'close-transport.json','CLOSED')
            self.assertGreaterEqual(clock.now,90);self.assertLess(clock.now,90.11)

    def test_ordinary_quit_targets_A_core_or_C_full_before_close_request(self):
        tree=ast.parse((HERE/'mobile-acceptance.py').read_text());function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='desktop_child')
        start=next(i for i,n in enumerate(function.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='quit_command' for t in n.targets))
        for mode,expected in [('core',['node','mobile/desktop.mjs','/synthetic','quit','terminal-close','--source','source']),('full',['node','mobile/recovery.mjs','/synthetic','source','C','quit'])]:
            calls=[]
            scope={'node':'node','source':'source','desktop':Path('/synthetic'),'helper':lambda name:name,'args':SimpleNamespace(mode=mode),
                   'steps':SimpleNamespace(run=lambda stage,argv,result:calls.append(('quit',argv,result))),
                   'lifecycle_request':lambda *args:calls.append(('close',))}
            exec(compile(ast.Module(body=function.body[start:start+3],type_ignores=[]),str(HERE/'mobile-acceptance.py'),'exec'),scope)
            self.assertEqual(calls,[('quit',expected,('QUIT_REQUESTED',)),('close',)])


if __name__=='__main__':unittest.main()
