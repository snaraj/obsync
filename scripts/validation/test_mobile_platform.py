"""Metadata parser/custody tests; no native app, host command or ADB calls."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('mobile_platform',Path(__file__).with_name('mobile-platform.py'))
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)
PACKAGE='Packages:\n  Package [md.obsidian] (abc):\n    versionCode=134 minSdk=24 targetSdk=35\n    versionName=1.13.4\n    unrelated-private-text-never-exported\n'
WEBVIEW='Current WebView package (name, version): (com.google.android.webview, 130.0.6723.59)\nOther candidates are not exported\n'


class Parsers(unittest.TestCase):
    def test_only_requested_package_and_active_webview_fields_exported(self):
        self.assertEqual(M.package_metadata(PACKAGE),{'package':'md.obsidian','versionName':'1.13.4','versionCode':134})
        self.assertEqual(M.webview_metadata(WEBVIEW),{'package':'com.google.android.webview','versionName':'130.0.6723.59'})
        for body in (PACKAGE.replace('md.obsidian','foreign.app'),PACKAGE+' versionCode=999\n',PACKAGE.replace('versionName=1.13.4','')):
            with self.assertRaises(ValueError):M.package_metadata(body)
        for body in ('Current WebView package is null',WEBVIEW+WEBVIEW,WEBVIEW.replace('130.0.6723.59','bad\tvalue')):
            with self.assertRaises(ValueError):M.webview_metadata(body)

    def test_empty_control_char_and_long_metadata_rejected(self):
        for value in ('','hello\nprivate','hello\tprivate','a'*102):
            with self.assertRaises(ValueError):M.scalar(value)


class Binding(unittest.TestCase):
    def fixture(self,root):
        desktop=root/'desktop';android=root/'android'
        for run in (desktop,android):
            (run/'evidence').mkdir(parents=True);(run/'private').mkdir()
        contents=root/'official/Obsidian.app/Contents';(contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
        app=contents/'MacOS/Obsidian';app.write_bytes(b'official executable');asar=contents/'Resources/app.asar';asar.write_bytes(b'official JS')
        (contents/'Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'1.8.10'}))
        artifacts={}
        for name in ('obsyncd','plugin/main.js','plugin/manifest.json','plugin/styles.css'):
            path=desktop/'runtime/build'/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(name);artifacts[name]=M.ANDROID.digest(path)
            if name.startswith('plugin/'):
                installed=desktop/'runtime/A/Lab-A/.obsidian/plugins/obsync-private-sync'/name[7:];installed.parent.mkdir(parents=True,exist_ok=True);installed.write_text(name)
        device={'vault':str(desktop/'runtime/A/Lab-A'),'userdata':str(desktop/'runtime/A/userdata'),'port':29345}
        argv=[str(app),'--user-data-dir='+device['userdata'],'--remote-debugging-port=29345','--remote-debugging-address=127.0.0.1']
        state={'format':1,'run':str(desktop),'source_dirty':False,'source_head':'a'*40,'expiresAtEpoch':time.time()+60,'devices':{'A':device},'artifacts':artifacts,
               'holder':{'pid':10,'identity':'owned'},'processes':{'A':{'pid':11,'identity':'owned '+' '.join(argv),'argv':argv},'server':{'pid':12,'identity':'owned '+str(desktop/'runtime/build/obsyncd')+' serve','argv':[str(desktop/'runtime/build/obsyncd'),'serve']}}}
        ready={'sourceHead':'a'*40,'artifacts':artifacts,'obsidianExecutableSha256':M.ANDROID.digest(app),'obsidianAsarSha256':M.ANDROID.digest(asar)}
        facts=dict(zip(M.PROPERTIES,('15','35','2024-09-05','arm64-v8a','userdebug','1')))
        for path,value in ((desktop/'lab.json',state),(desktop/'evidence/peer-ready.json',ready),(android/'evidence/android-ready.json',{'sourceHead':'a'*40,'installedApkVerified':True,'apkSha256':'b'*64,'facts':{key:facts[key] for key in M.PROPERTIES[:4]}}),(android/'evidence/assets.json',{'apkSha256':'b'*64,'apkUrl':'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.4/Obsidian-1.13.4.apk'})):
            M.ANDROID.save(path,value)
        return desktop,android,facts,asar

    def identities(self,desktop):
        state=M.SESSION.private_json(desktop/'lab.json')
        return {record['pid']:record['identity'] for record in (state['holder'],*state['processes'].values())}

    def test_collect_fixed_queries_pins_app_and_states_limits_without_raw_output(self):
        with tempfile.TemporaryDirectory(prefix='obsync-platform-') as tmp:
            desktop,android,facts,asar=self.fixture(Path(tmp).resolve());queries=[]
            identities=self.identities(desktop)
            def adb(state,args,**kwargs):
                queries.append(args)
                if args==['shell','dumpsys','package','md.obsidian']:return PACKAGE
                if args==['shell','dumpsys','webviewupdate']:return WEBVIEW
                if args[:2]==['shell','getprop'] and args[2] in facts:return facts[args[2]]
                raise AssertionError('foreign query')
            with patch.object(M.ANDROID,'identity',side_effect=identities.get),patch.object(M.ANDROID,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M.ANDROID,'app_pid',return_value=321),patch.object(M.ANDROID,'adb_command',side_effect=adb),patch.object(M,'host_value',return_value='bounded-host-metadata'):
                value=M.collect(desktop,android)
            self.assertEqual(value['result'],'OBSERVED');self.assertEqual(value['macAcquisition']['result'],'UNKNOWN')
            self.assertEqual(value['physicalPhone'],'NOT_RUN');self.assertEqual(value['hardwareBackedCustody'],'NOT_MEASURED')
            self.assertEqual(len(queries),8);self.assertNotIn('unrelated-private-text',json.dumps(value))
            asar.write_text('modified application JS')
            with patch.object(M.ANDROID,'identity',side_effect=identities.get),patch.object(M.ANDROID,'adb_command') as command:
                with self.assertRaisesRegex(ValueError,'pinned artifact'):M.collect(desktop,android)
                command.assert_not_called()

    def test_changed_source_os_or_app_pid_cannot_emit_observed(self):
        with tempfile.TemporaryDirectory(prefix='obsync-platform-') as tmp:
            desktop,android,facts,_=self.fixture(Path(tmp).resolve())
            identities=self.identities(desktop)
            with patch.object(M.ANDROID,'identity',side_effect=identities.get),patch.object(M.ANDROID,'live_state',return_value={'sourceHead':'c'*40}),patch.object(M.ANDROID,'adb_command') as command:
                with self.assertRaisesRegex(ValueError,'same-candidate'):M.collect(desktop,android)
                command.assert_not_called()
            def adb(state,args,**kwargs):
                return PACKAGE if args[1]=='dumpsys' and args[2]=='package' else WEBVIEW if args[1]=='dumpsys' else facts[args[2]]
            with patch.object(M.ANDROID,'identity',side_effect=identities.get),patch.object(M.ANDROID,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M.ANDROID,'app_pid',side_effect=[321,322]),patch.object(M.ANDROID,'adb_command',side_effect=adb):
                with self.assertRaisesRegex(ValueError,'restarted'):M.collect(desktop,android)
            self.assertFalse((desktop/'evidence/mobile-platform.json').exists())


if __name__=='__main__':unittest.main()
