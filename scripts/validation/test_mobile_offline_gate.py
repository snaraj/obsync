"""Execute the production offline block with owned-route fakes, without devices."""
import ast
import json
from pathlib import Path
import re
from types import SimpleNamespace
import tempfile
import unittest

HERE=Path(__file__).resolve().parent


class OfflineOrder(unittest.TestCase):
    def exercise(self,changes=None,resume_bad=False):
        tree=ast.parse((HERE/'mobile-full.py').read_text())
        run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        first=next(i for i,n in enumerate(run.body) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='life' and n.value.args[0].value=='android-home-before-offline')
        last=next(i for i,n in enumerate(run.body) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='receipt' and n.value.args[0].value=='background-offline')
        calls=[];route={'removed':False,'drained':False,'resumed':False};notes=[]
        def require(ok,stage):
            if not ok:raise ValueError(stage)
        def adb(state,argv):
            if argv==['reverse','--remove','tcp:18473']:route['removed']=True;calls.append('remove')
            elif argv==['reverse','--list']:calls.append('list');return ''
            elif argv==['reverse','tcp:18473','tcp:18473']:
                self.assertTrue(route['resumed']);calls.append('restore')
            elif 'resolve-activity' in argv:return 'md.obsidian/.MainActivity'
            return ''
        controller=SimpleNamespace(live_state=lambda android:{'reversePorts':[18473]},check_reverse=lambda state:None,adb_command=adb)
        def request(name,label,payload,expected):
            self.assertEqual(name,'android-route')
            action=payload['action'];calls.append(action)
            if action=='drain':
                self.assertTrue(route['removed']);route['drained']=True
                return dict({'sourceHead':'a'*40,'activeSockets':0,'gateClosed':True,'forcedActiveSocketCloses':0,'drainDeadlineMs':70000,'drainMs':100,'desktopRecorderListenerUnchanged':True},**(changes or {}))
            route['resumed']=True;return {'sourceHead':'a'*40,'gateOpen':not resume_bad,'priorDrainProven':True}
        def new_desktop(label):
            self.assertTrue(route['drained']);calls.append('desktop-note');return {'path':'Desktop-offline.md','text':'fixture'}
        def phone(stage,command,data):
            if command=='note-absent':self.assertTrue(route['drained']);calls.append('phone-absence')
        def note_from_phone(label,text,paired=True):
            self.assertTrue(route['drained']);self.assertFalse(paired);calls.append('phone-note');return {'path':'Android-offline.md','text':text}
        with tempfile.TemporaryDirectory(prefix='obsync-offline-order-') as temp:
            scope=locals()|{'re':re,'desktop':Path(temp),'android':Path(temp)/'android','c':{'tlsPort':18473,'sourceHead':'a'*40},
                'life':lambda *args:None,'phone_reads':lambda *args:None,'desk':lambda *args:None,'both_bytes':lambda *args:None,'receipt':lambda *args,**kwargs:calls.append('receipt')}
            exec(compile(ast.Module(body=run.body[first:last+1],type_ignores=[]),str(HERE/'mobile-full.py'),'exec'),scope)
        return calls

    def test_drain_before_notes_and_gate_resume_before_reverse_restore(self):
        calls=self.exercise()
        self.assertEqual(calls,['remove','list','drain','desktop-note','phone-absence','phone-note','resume','restore','receipt'])

    def test_incomplete_drain_never_advances_to_notes(self):
        for field,value in [('sourceHead','b'*40),('activeSockets',1),('gateClosed',False),('forcedActiveSocketCloses',1),('drainDeadlineMs',80000),('drainMs',70001),('desktopRecorderListenerUnchanged',False)]:
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'gracefully_drained'):self.exercise({field:value})

    def test_failed_resume_never_restores_reverse(self):
        with self.assertRaisesRegex(ValueError,'gate_resumed'):self.exercise(resume_bad=True)


    def test_route_timeout_error_is_preserved_and_request_published_atomically(self):
        tree=ast.parse((HERE/'mobile-full.py').read_text())
        node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='request')
        with tempfile.TemporaryDirectory(prefix='obsync-offline-request-') as temp:
            desktop=Path(temp);(desktop/'private').mkdir()
            def save(path,body):
                self.assertEqual(path.name,'android-route.pending.json')
                path.write_text(json.dumps(body))
                (desktop/'private/android-route-result.json').write_text(json.dumps({'schema':1,'requestId':'full-offline-drain','result':'FAIL','errorCode':'route_drain_timeout'}))
            def require(ok,stage):
                if not ok:raise ValueError(stage)
            scope={'desktop':desktop,'private':lambda path:json.loads(path.read_text()),'save':save,'require':require,
                   'time':SimpleNamespace(monotonic=lambda:0,sleep=lambda seconds:None)}
            exec(compile(ast.Module(body=[node],type_ignores=[]),str(HERE/'mobile-full.py'),'exec'),scope)
            with self.assertRaisesRegex(ValueError,'owned_android_route_route_drain_timeout'):
                scope['request']('android-route','offline-drain',{'action':'drain'},'DRAINED')
            self.assertTrue((desktop/'private/android-route.json').exists())
            self.assertFalse((desktop/'private/android-route.pending.json').exists())


if __name__=='__main__':unittest.main()
