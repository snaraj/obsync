"""Offline recovery ownership and complete-journal negative controls."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import time
import unittest
from unittest.mock import patch
import zlib

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
M=load('mobile-recovery');J=load('mobile-journal')
def frame(kind='suite2_setup',sequence=1):
    body=json.dumps({'t':kind,'s':sequence}).encode();return struct.pack('<II',len(body),zlib.crc32(body))+body


class Ownership(unittest.TestCase):
    def test_provision_registers_only_fresh_slot_and_three_verified_assets(self):
        with tempfile.TemporaryDirectory(prefix='obsync-recovery-provision-') as tmp:
            root=Path(tmp).resolve();run=root/'run';source=root/'source';run.mkdir();(run/'runtime/build/plugin').mkdir(parents=True)
            (run/'private').mkdir();(run/'evidence').mkdir();(source/'plugin/dist').mkdir(parents=True)
            config={'source':source,'sourceHead':'a'*40};artifacts={}
            for key in ('obsidianExecutable','obsidianAsar'):
                config[key]=root/key;config[key].write_text('official-'+key)
                config['obsidianSha256' if key=='obsidianExecutable' else 'obsidianAsarSha256']=M.COMMON.digest(config[key])
            for name in M.SESSION.PLUGIN:
                for path in (run/'runtime/build/plugin'/name,source/'plugin/dist'/name):path.write_text('candidate-'+name)
                artifacts['plugin/'+name]=M.COMMON.digest(run/'runtime/build/plugin'/name)
            class Owner:
                children={}
                def require(self,*roles):pass
                def stop_one(self,name):raise AssertionError('no prior child')
                def launch(self,name,argv):
                    self.children[name]=type('Child',(),{'pid':123})()
                    self.state['processes'][name]={'pid':123,'identity':'app','argv':argv}
                    return self.children[name]
            owner=Owner();owner.run=run;owner.state={'source_dirty':False,'source_head':'a'*40,'expiresAtEpoch':time.time()+60,
                'devices':{},'artifacts':artifacts,'processes':{'server':{'pid':10,'identity':'server'},'tls':{'pid':11,'identity':'tls'}}}
            with patch.object(M.subprocess,'check_output',side_effect=['a'*40+'\n',b'']),patch.object(M.COMMON,'identity',side_effect=['server','tls']),patch.object(M.COMMON,'free_port',return_value=29345),patch.object(M,'android_absent',return_value={'packageAbsent':True}),patch.object(M.SESSION,'wait_http'),patch.object(M.SESSION,'listener'):
                result=M.provision(owner,config,'B','/explicit-owned-android',321,'fresh-B')
            plugin=run/'runtime/B/Lab-B/.obsidian/plugins/obsync-private-sync'
            self.assertEqual(sorted(p.name for p in plugin.iterdir()),sorted(M.SESSION.PLUGIN))
            self.assertIn('B',owner.children);self.assertTrue(result['registeredForOwnedCleanup']);self.assertFalse(result['copiedPairedState'])
            self.assertEqual(json.loads((run/'runtime/B/userdata/obsidian.json').read_text()),{'updateDisabled':True})

    def test_absence_requires_same_candidate_no_app_no_old_socket(self):
        for head,app,socket in [('b'*40,None,False),('a'*40,456,False),('a'*40,None,True)]:
            with patch.object(M.COMMON,'live_state',return_value={'sourceHead':head}),patch.object(M.COMMON,'app_pid',return_value=app),patch.object(M.COMMON,'devtools_present',return_value=socket):
                with self.assertRaises(ValueError):M.android_absent('/unused','a'*40,321)
        with patch.object(M.COMMON,'live_state') as read:
            with self.assertRaises(ValueError):M.android_absent('/unused','a'*40,True)
            read.assert_not_called()

    def test_no_live_paired_desktop_stopped_or_reaped(self):
        class Owner:
            children={'A':object(),'B':object()}
            state={'processes':{'A':{},'B':{}}}
            def stop_one(self,name):raise AssertionError('must not stop any before proving all exited')
        owner=Owner();children=dict(owner.children);clock=[0.0]
        def sleep(seconds):clock[0]+=seconds
        def exit_code(child):return 0 if child is children['A'] else None
        with patch.object(M.COMMON,'exit_code',side_effect=exit_code),patch.object(M.time,'monotonic',side_effect=lambda:clock[0]),patch.object(M.time,'sleep',side_effect=sleep):
            with self.assertRaisesRegex(TimeoutError,'Quit deadline for B'):M.settle_desktops(owner)
        self.assertEqual(owner.children,children)
        self.assertEqual(clock[0],15)


class Journal(unittest.TestCase):
    def test_crc_partial_unknown_duplicate_and_boolean_sequence_rejected(self):
        self.assertEqual(J.frames(frame()),{'suite2_setup':1})
        payload=b'{"t":"suite2_setup","t":"device","s":1}'
        duplicate=struct.pack('<II',len(payload),zlib.crc32(payload))+payload
        for body in (frame()[:-1],frame()[:7],frame()[:-1]+b'x',frame('unknown'),frame(sequence=True),duplicate):
            with self.assertRaises((ValueError,json.JSONDecodeError)):J.frames(body)

    def test_complete_segments_required_not_just_final_frame(self):
        with tempfile.TemporaryDirectory(prefix='obsync-journal-') as tmp:
            root=Path(tmp).resolve();first=root/'000000.log';second=root/'000001.log'
            first.write_bytes(frame());first.chmod(0o600);second.write_bytes(frame('device',2));second.chmod(0o600)
            original=J.read_segments(root)
            self.assertEqual(original['frameCounts'],{'suite2_setup':1,'device':1})
            first.write_bytes(frame()+frame('seen',3));self.assertNotEqual(original,J.read_segments(root))
            first.unlink()
            with self.assertRaisesRegex(ValueError,'initial suite2'):J.read_segments(root)
            first.symlink_to(second)
            with self.assertRaises(ValueError):J.read_segments(root)

    def test_changed_journal_yields_unknown_never_pass(self):
        with tempfile.TemporaryDirectory(prefix='obsync-journal-compare-') as tmp:
            run=Path(tmp).resolve();(run/'private').mkdir();(run/'evidence').mkdir()
            baseline={'sourceHead':'a'*40,'frameCounts':{'suite2_setup':1},'bytes':20}
            with patch.object(J,'snapshot',return_value=baseline):J.compare(run,'B','old-backup','before')
            with patch.object(J,'snapshot',return_value=baseline|{'bytes':21}):
                with self.assertRaisesRegex(RuntimeError,'UNKNOWN'):J.compare(run,'B','old-backup','after')
            receipt=json.loads(next((run/'evidence').iterdir()).read_text())
            self.assertEqual(receipt['result'],'UNKNOWN');self.assertFalse(receipt['durableAccountStateUnchanged'])


if __name__=='__main__':unittest.main()
