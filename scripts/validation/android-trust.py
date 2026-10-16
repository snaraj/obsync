#!/usr/bin/env python3
"""Synthetic one-day system CA in one already-owned userdebug Android lab."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

SPEC = importlib.util.spec_from_file_location('android_session', Path(__file__).with_name('android-session.py'))
SESSION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SESSION)
STORE = '/apex/com.android.conscrypt/cacerts'
LABEL = 'u:object_r:system_security_cacerts_file:s0'


def cert_info(path, expected):
    SESSION.checked_file(path)
    if not re.fullmatch('[a-f0-9]{64}', expected) or SESSION.digest(path) != expected:
        raise ValueError('synthetic CA SHA-256 mismatch')
    def x509(*args):
        return subprocess.check_output(['openssl','x509','-in',str(path),'-noout',*args],text=True)
    text=x509('-text')
    if 'CA:TRUE' not in text or 'Certificate Sign' not in text:
        raise ValueError('synthetic certificate-signing CA required')
    dates={key:datetime.strptime(value,'%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
           for key,value in (line.split('=',1) for line in x509('-startdate','-enddate').splitlines())}
    now=datetime.now(timezone.utc)
    if not dates['notBefore'] <= now < dates['notAfter'] or (dates['notAfter']-dates['notBefore']).total_seconds()>86460:
        raise ValueError('currently valid CA with at most one-day lifetime required')
    name=x509('-subject_hash_old').strip()+'.0'
    if not re.fullmatch(r'[a-f0-9]{8}\.0',name):
        raise ValueError('unexpected synthetic CA subject hash')
    subprocess.run(['openssl','verify','-CAfile',str(path),str(path)],capture_output=True,check=True)
    return {'sha256':expected,'name':name,'notAfter':dates['notAfter'].isoformat()}


def untrusted_receipt(path, source_head):
    proof=json.loads(SESSION.checked_file(path).read_text())
    if proof.get('result')!='PASS' or proof.get('untrustedRejected') is not True or proof.get('sourceHead')!=source_head:
        raise ValueError('actual untrusted WebView rejection receipt for this source required')
    return SESSION.digest(path)


def shell(state, *args, timeout=30):
    return SESSION.adb_command(state,['shell',*args],timeout=timeout).strip()


def preflight(run):
    state=SESSION.live_state(run)
    if state.get('targetKind')=='usb':raise ValueError('synthetic trust operations are forbidden on USB devices')
    SESSION.check_reverse(state)
    ready=json.loads((run/'evidence/android-ready.json').read_text())
    if ready.get('freshProfile') is not True or ready.get('installedApkVerified') is not True:
        raise ValueError('fresh verified official Obsidian emulator required')
    if shell(state,'getprop','ro.build.type')!='userdebug' or shell(state,'getprop','ro.debuggable')!='1':
        raise ValueError('owned userdebug AVD required')
    if shell(state,'getenforce')!='Enforcing':
        raise ValueError('SELinux Enforcing required')
    if 'usage: nsenter' not in shell(state,'toybox','nsenter','--help'):
        raise ValueError('official image namespace-entry applet unavailable')
    return state, ready


def inventory(state, pid=None):
    args=['sh','-c',shlex.quote('sha256sum '+STORE+'/*')]
    if pid is not None:
        args=['toybox','nsenter','-t',str(pid),'-m','--',*args]
    rows=shell(state,*args).splitlines()
    result={}
    for row in rows:
        digest,path=row.split()
        name=path.removeprefix(STORE+'/')
        if not re.fullmatch('[a-f0-9]{64}',digest) or not re.fullmatch(r'[a-f0-9]{8}\.\d+',name) or name in result:
            raise ValueError('unexpected Android system CA inventory')
        result[name]=digest
    if not result:
        raise ValueError('empty Android system CA inventory')
    return result


ApkReadbackError = SESSION.APK.ApkReadbackError


def apk_path(state,timeout=30):
    return SESSION.APK.apk_path(state,SESSION.adb_command,timeout)


def apk_hash(state,run,expected,phase):
    return SESSION.APK.apk_hash(state,run,expected,phase,SESSION.adb_command,SESSION.save)


def namespaces(state, require_app=True):
    rows=[]
    # Exact named framework and owned application processes only; no global list.
    for name in ('zygote64','zygote','webview_zygote','md.obsidian'):
        try: pids=shell(state,'pidof',name).split()
        except subprocess.CalledProcessError: pids=[]
        if name=='md.obsidian' and require_app and len(pids)!=1:
            raise ValueError('one running owned Obsidian process required')
        for raw in pids:
            if not raw.isdigit() or int(raw)<=1:
                raise ValueError('invalid owned namespace process')
            pid=int(raw)
            ns=shell(state,'readlink',f'/proc/{pid}/ns/mnt')
            stat=shell(state,'cat',f'/proc/{pid}/stat')
            if not re.fullmatch(r'mnt:\[\d+\]',ns):
                raise ValueError('Android mount namespace unavailable')
            rows.append({'role':name,'pid':pid,'namespace':ns,'startTicks':stat.rsplit(')',1)[1].split()[19]})
    return rows


def install(run, ca, expected, before, reapply=False):
    state,ready=preflight(run)
    ca_proof=cert_info(ca,expected)
    before_hash=untrusted_receipt(before,state['sourceHead'])
    if reapply:
        prior=json.loads((run/'evidence/android-trust.json').read_text())
        if prior['sourceHead']!=state['sourceHead'] or prior['ca']['sha256']!=expected:
            raise ValueError("reapply requires this run's original pinned trust receipt")
    if apk_hash(state,run,ready['apkSha256'],'before-reapply' if reapply else 'before-trust')!=ready['apkSha256']:
        raise ValueError('official APK changed before trust setup')
    # This restarts only adbd. No app, framework or zygote restart is performed.
    SESSION.adb_command(state,['root'])
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        try:
            SESSION.register_emulator(state,int(state['serial'].split('-')[1])+1)
            if shell(state,'id','-u')=='0': break
        except (OSError,subprocess.SubprocessError): pass
        time.sleep(.2)
    else: raise TimeoutError('owned userdebug adbd root deadline')
    for port in state['reversePorts']:
        SESSION.adb_command(state,['reverse',f'tcp:{port}',f'tcp:{port}'])
    SESSION.check_reverse(state)
    original=inventory(state)
    if ca_proof['name'] in original:
        raise ValueError('synthetic CA subject already exists; refusing replacement')
    guest='/data/local/tmp/obsync-ca-'+expected[:16]
    # A fresh directory is mandatory. Every interpolation below is fixed text
    # or validated hex/numeric data; no owner path or private key enters a shell.
    expected_inventory=original|{ca_proof['name']:expected}
    if reapply:
        raw=shell(state,'sh','-c',shlex.quote('sha256sum '+guest+'/cacerts/*'))
        copied={row.split()[1].rsplit('/',1)[1]:row.split()[0] for row in raw.splitlines()}
        if copied!=expected_inventory:
            raise ValueError('owned persisted CA union differs from original roots plus pinned CA')
    else:
        shell(state,'mkdir',guest)
        shell(state,'mkdir',guest+'/cacerts')
        shell(state,'sh','-c',shlex.quote(f'cp -p {STORE}/* {guest}/cacerts/'))
        SESSION.adb_command(state,['push',str(ca),guest+'/cacerts/'+ca_proof['name']])
        shell(state,'sh','-c',shlex.quote(f'chown -R 0:0 {guest} && chmod 755 {guest} {guest}/cacerts && chmod 644 {guest}/cacerts/* && chcon -R {LABEL} {guest}'))
    targets=namespaces(state, require_app=not reapply)
    seen=set()
    for target in targets:
        if target['namespace'] in seen: continue
        seen.add(target['namespace'])
        pid=target['pid']
        current=shell(state,'cat',f'/proc/{pid}/stat').rsplit(')',1)[1].split()[19]
        if current!=target['startTicks']:
            raise RuntimeError('target namespace process changed before mount')
        prefix=['toybox','nsenter','-t',str(pid),'-m','--']
        shell(state,*prefix,'mount','-t','tmpfs','-o','private','none','/apex/com.android.conscrypt')
        shell(state,*prefix,'mount','--bind',guest+'/cacerts',STORE)
        if inventory(state,pid)!=expected_inventory:
            raise RuntimeError('namespace CA inventory differs from original roots plus synthetic CA')
    if shell(state,'getenforce')!='Enforcing' or apk_hash(state,run,ready['apkSha256'],'after-reapply' if reapply else 'after-trust')!=ready['apkSha256']:
        raise RuntimeError('enforcement or original official APK changed during trust setup')
    proof={'result':'INSTALLED','sourceHead':state['sourceHead'],'ca':ca_proof,
        'untrustedProbeSha256':before_hash,'originalRootCount':len(original),
        'resultingRootCount':len(expected_inventory),'originalRootsPreserved':True,
        'namespaces':targets,'selinux':'Enforcing','apkSha256':ready['apkSha256'],
        'appRestarted':False,'zygoteRestarted':False,'reversePortsVerified':state['reversePorts'],
        'bootId':shell(state,'cat','/proc/sys/kernel/random/boot_id'), 'reapplied':reapply,
        'acceptanceScope':'rooted disposable userdebug emulator with synthetic system CA; physical phone NOT_RUN',
        'webViewTrustedProbe':'REQUIRED','wrongHostnameProbe':'REQUIRED','removedWithAVD':True}
    path=run/'evidence'/('android-trust-reapply-'+str(time.time_ns())+'.json' if reapply else 'android-trust.json')
    SESSION.save(path,proof)
    SESSION.save(run/'evidence/android-trust-current.json',proof)
    return proof


def verify(run):
    state,ready=preflight(run)
    prior=json.loads((run/'evidence/android-trust.json').read_text())
    original=inventory(state)
    expected=original|{prior['ca']['name']:prior['ca']['sha256']}
    targets=namespaces(state)
    for target in targets:
        if inventory(state,target['pid'])!=expected:
            raise RuntimeError('current app/framework namespace lacks the verified CA union')
    if apk_hash(state,run,ready['apkSha256'],'verify')!=ready['apkSha256']:
        raise RuntimeError('official Obsidian APK changed')
    proof=prior|{'result':'VERIFIED','namespaces':targets,'bootId':shell(state,'cat','/proc/sys/kernel/random/boot_id')}
    SESSION.save(run/'evidence'/('android-trust-verify-'+str(time.time_ns())+'.json'),proof)
    SESSION.save(run/'evidence/android-trust-current.json',proof)
    return proof


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=('inspect','install','reapply','verify'))
    p.add_argument('--run',type=lambda s:Path(s).expanduser().absolute(),required=True)
    p.add_argument('--ca',type=Path)
    p.add_argument('--ca-sha256')
    p.add_argument('--untrusted-probe',type=Path)
    a=p.parse_args()
    if a.action=='inspect':
        state,_=preflight(a.run)
        print(json.dumps({'result':'CAPABLE','sourceHead':state['sourceHead'],'selinux':'Enforcing',
                          'rootRequested':False,'systemRoots':len(inventory(state))}))
    elif a.action=='verify':
        print(json.dumps(verify(a.run)))
    else:
        if not all((a.ca,a.ca_sha256,a.untrusted_probe)):
            p.error('install requires pinned CA and actual untrusted WebView receipt')
        print(json.dumps(install(a.run,a.ca,a.ca_sha256,a.untrusted_probe,reapply=a.action=='reapply')))


if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'result':'FAIL','exceptionType':type(error).__name__,
              'detail':error.reason if isinstance(error,ApkReadbackError) else SESSION.sanitized_diagnostic(str(error))[:400],
              'apkStage':error.stage if isinstance(error,ApkReadbackError) else None,
              'stderr':SESSION.sanitized_diagnostic(getattr(error,'stderr',None) or '')[:2000]}),file=sys.stderr)
        sys.exit(1)
