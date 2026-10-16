#!/usr/bin/env python3
"""Finite offline trust-APK readback mutations in a temporary helper copy."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root=Path(__file__).resolve().parent
mutations=[
 ('failure_class',"else:category=next((name for name,needles in markers if any(marker in sample for marker in needles)),'OTHER')","else:category='OTHER'"),
 ('stdout_count',"'stdoutBytes':len(stdout)","'stdoutBytes':0"),
 ('stderr_count',"'stderrBytes':len(stderr)","'stderrBytes':0"),
 ('bounded_stderr',"stderr[:2048]+b'\\n'+stdout[:2048]","stderr+b'\\n'+stdout[:2048]"),
 ('bounded_stdout',"stderr[:2048]+b'\\n'+stdout[:2048]","stderr[:2048]+b'\\n'+stdout"),
 ('allowlisted_reason',"self.reason=reason if reason in APK_REASONS else 'apk_readback_refused'","self.reason=reason"),
 ('allowlisted_stage',"self.stage=stage if stage in APK_STAGES else None","self.stage=stage"),
 ('preserved_failure_stage',"failure=ApkReadbackError(reason,stage)","failure=ApkReadbackError(reason)"),
 ('cli_reason',"'detail':error.reason if isinstance(error,ApkReadbackError) else SESSION.sanitized_diagnostic(str(error))[:400]","'detail':SESSION.sanitized_diagnostic(str(error))[:400]"),
 ('cli_stage',"'apkStage':error.stage if isinstance(error,ApkReadbackError) else None","'apkStage':None"),
 ('remote_before_after', "if before!=after:raise ApkReadbackError('apk_remote_file_changed')", 'if False:pass'),
 ('complete_host_bytes', "if local!=before:raise ApkReadbackError('apk_pull_integrity_mismatch')", 'if False:pass'),
 ('same_official_pin', "if local['sha256']!=expected:raise ApkReadbackError('apk_official_pin_mismatch')", 'if False:pass'),
 ('same_package_path', "if apk_path(state,adb_command,timeout=remaining())!=path:raise ApkReadbackError('apk_package_path_changed')", 'if False:pass'),
 ('late_success', "        remaining()\n        diagnostic.update(result='VERIFIED'", "        diagnostic.update(result='VERIFIED'"),
 ('pull_remaining_budget', "adb_command(state,['pull',path,str(destination)],timeout=remaining())", "adb_command(state,['pull',path,str(destination)],timeout=60)"),
 ('initial_complete_readback', "APK.apk_hash(state,a.run,proof['apkSha256'],'initial-install',adb_command,save)", "proof['apkSha256']"),
 ('terminal_before_root', "if apk_hash(state,run,ready['apkSha256'],'before-reapply' if reapply else 'before-trust')!=ready['apkSha256']:", 'if False:'),
]
with tempfile.TemporaryDirectory(prefix='obsync-trust-apk-mutations-') as tmp:
 work=Path(tmp)
 for name in ('android-trust.py','android-session.py','android-apk.py','test_android_trust.py','test_android_session.py'):shutil.copyfile(root/name,work/name)
 target=work/'android-apk.py';baseline=target.read_text();trust=work/'android-trust.py';trust_baseline=trust.read_text();session=work/'android-session.py';session_baseline=session.read_text()
 def check():
  return subprocess.run([sys.executable,'-B','-m','unittest','test_android_trust.ApkIntegrity','test_android_trust.Control','test_android_session.InitialApkGate'],cwd=work,
                        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30).returncode
 if check()!=0:raise SystemExit('APK readback controls baseline must pass')
 killed=[]
 for name,old,new in mutations:
  selected,original=(trust,trust_baseline) if name in ('terminal_before_root','cli_reason','cli_stage') else (session,session_baseline) if name=='initial_complete_readback' else (target,baseline)
  if original.count(old)!=1:raise SystemExit('mutation target mismatch: '+name)
  selected.write_text(original.replace(old,new))
  if check()==0:raise SystemExit('APK readback mutation survived: '+name)
  killed.append(name);selected.write_text(original)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_APK_READBACK_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
