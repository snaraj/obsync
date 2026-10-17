"""Execute the actual small orchestration functions with bounded fake clocks.

No native process, server, controller, app, or credential is accessed.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest

HERE=Path(__file__).resolve().parent


def function(path,name,namespace):
    tree=ast.parse(path.read_text())
    nodes=[node for node in ast.walk(tree) if isinstance(node,ast.FunctionDef) and node.name==name]
    if len(nodes)!=1:raise AssertionError('one actual production function required')
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(path),'exec'),namespace)
    return namespace[name]


class Clock:
    def __init__(self):self.now=0
    def monotonic(self):return self.now
    def sleep(self,seconds):self.now+=seconds


class Child:
    def __init__(self):self.reaped=False
    def wait(self):self.reaped=True;return 0


class QuitCustody(unittest.TestCase):
    def owner(self,slots):
        owner=SimpleNamespace(state={'processes':{slot:{} for slot in slots}},children={slot:Child() for slot in slots},stopped=[])
        def stop(slot):owner.stopped.append(slot);owner.children.pop(slot);owner.state['processes'].pop(slot)
        owner.stop_one=stop
        return owner

    def load(self,clock,exit_code):
        return function(HERE/'mobile-recovery.py','settle_desktops',{'time':clock,'COMMON':SimpleNamespace(exit_code=exit_code)})

    def test_delayed_natural_quit_is_observed_before_settling_original_child(self):
        clock=Clock();owner=self.owner(['A']);reads=[];child=owner.children['A']
        def observed(child):
            self.assertIs(child,owner.children['A']);reads.append(child)
            return 0 if clock.now>=.2 else None
        self.load(clock,observed)(owner)
        self.assertEqual(owner.stopped,['A']);self.assertGreaterEqual(len(reads),3)
        self.assertGreaterEqual(clock.now,.2);self.assertLess(clock.now,15)
        self.assertFalse(child.reaped)

    def test_timeout_and_nonzero_exit_preserve_children_without_any_stop_or_reap(self):
        for result,error in [(None,TimeoutError),(-15,RuntimeError),(1,RuntimeError)]:
            clock=Clock();owner=self.owner(['A']);child=owner.children['A']
            with self.assertRaises(error):self.load(clock,lambda current:result)(owner)
            self.assertEqual(owner.stopped,[]);self.assertIs(owner.children['A'],child)
            self.assertLessEqual(clock.now,15)

    def test_all_prior_peers_share_one15second_deadline(self):
        clock=Clock();owner=self.owner(['A','B'])
        def observed(child):return 0 if child is owner.children['A'] and clock.now>=14 else None
        with self.assertRaises(TimeoutError):self.load(clock,observed)(owner)
        self.assertEqual(owner.stopped,[]);self.assertLessEqual(clock.now,15)

    def test_missing_retained_popen_refuses_before_settling(self):
        clock=Clock();owner=self.owner(['A']);owner.children.pop('A')
        with self.assertRaises(ValueError):self.load(clock,lambda child:0)(owner)
        self.assertEqual(owner.stopped,[])


class PendingOrder(unittest.TestCase):
    def exercise(self,fail_readiness=False,invalid_before=False):
        calls=[]
        def require(value,stage):
            if not value:raise AssertionError(stage)
        def desk(stage,command):
            calls.append(command)
            return {'phase':'prepared','rotationPending':True,'pendingCheckpointMatches':not invalid_before,'generationHash':'a'*64,'credentialHash':'b'*64}
        def request(name,label,values,result):
            calls.append('owner-restart');return {'oldGroupAbsent':True,'profileReset':False,'naturalQuitExitCode':0,'launchStartedAtEpochMs':1000}
        def native(stage,file,*arguments,**kwargs):
            calls.append('passive-readiness');self.assertEqual(arguments,('prepared-restart','a'*64,'b'*64,'1000'))
            if fail_readiness:raise RuntimeError('actual passive refusal')
            return {'result':'PASS'}
        operation=function(HERE/'mobile-full.py','restart_desktop',{'desk':desk,'request':request,'native':native,'require':require})
        if invalid_before:
            with self.assertRaisesRegex(AssertionError,'pending_checkpoint_before_normal_quit'):operation('prepared','prepared')
        elif fail_readiness:
            with self.assertRaisesRegex(RuntimeError,'actual passive refusal'):operation('prepared','prepared')
        else:operation('prepared','prepared')
        return calls

    def test_pending_readiness_precedes_first_postlaunch_status(self):
        self.assertEqual(self.exercise(),['status','quit','owner-restart','passive-readiness','status'])

    def test_readiness_failure_stops_before_status_instead_of_retrying_it(self):
        self.assertEqual(self.exercise(True),['status','quit','owner-restart','passive-readiness'])

    def test_bad_checkpoint_stops_before_quit(self):
        self.assertEqual(self.exercise(invalid_before=True),['status'])


if __name__=='__main__':unittest.main()
