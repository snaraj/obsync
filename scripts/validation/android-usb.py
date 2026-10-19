#!/usr/bin/env python3
"""Optional one-serial USB owner. Existing app/data/trust stay intact.

Requires the companion targetKind patches and caller-authorized dedicated fresh
fixture. This does not provision a phone or replace three fresh emulator runs.
"""
import argparse
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import ssl
import subprocess
import sys
import time
from urllib.parse import urlsplit

SPEC=importlib.util.spec_from_file_location('mobile_platform',Path(__file__).with_name('mobile-platform.py'))
PLATFORM=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(PLATFORM)
SESSION=PLATFORM.SESSION;COMMON=PLATFORM.ANDROID
SPEC=importlib.util.spec_from_file_location('mobile_trusted_tls',Path(__file__).with_name('mobile-trusted-tls.py'))
TLS=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(TLS)
SERIAL=r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}'


def authorized_serial(state,serial):
    deadline=min(time.time()+60,state['expiresAtEpoch']);notified=False
    while time.time()<deadline:
        try:
            value=COMMON.adb_command(state,['get-serialno'],timeout=3).strip()
            if value!=serial:raise ValueError('supplied USB serial does not match; no other device selected')
            return
        except subprocess.CalledProcessError as error:
            message=error.stderr or b''
            if isinstance(message,str):message=message.encode()
            if not any(word in message.lower() for word in (b'unauthorized',b'offline',b'not found')):
                raise ValueError('scoped USB authorization probe failed') from None
            if not notified:
                print(json.dumps({'result':'OWNER_KEY_APPROVAL_REQUIRED','targetKind':'usb','action':'Owner must authorize this fresh private ADB key on the supplied device outside code','seconds':60}),flush=True);notified=True
        time.sleep(.25)
    raise TimeoutError('supplied USB device/key not authorized within bounded owner-action window')


def target_guard(state):
    serial=state.get('serial','');usb=state.get('usb',{})
    if (state.get('targetKind')!='usb' or not re.fullmatch(SERIAL,serial) or serial.startswith('emulator-') or
        usb.get('ownerApprovedDedicatedFixture') is not True or usb.get('serialSha256')!=hashlib.sha256(serial.encode()).hexdigest() or
        'emulator' in state['processes'] or 'adb' not in state['processes']):raise ValueError('explicit one-serial owned USB target required')
    argv=state['processes']['adb'].get('argv',[])
    expected=[str(Path(state['sdk'])/'platform-tools/adb'),'--one-device',serial,'-L','tcp:'+str(state['adbPort']),'server','nodaemon']
    if argv!=expected or not state['processes']['adb']['identity'].endswith(' '.join(argv)):
        raise ValueError('private one-device ADB ownership changed')


def trusted_route(c):
    desktop_run=Path(c['desktopRun']);state,_=PLATFORM.desktop_binding(desktop_run)
    if state['source_head']!=c['sourceHead']:raise ValueError('same candidate desktop required')
    route=c['trustedRoute'];url=urlsplit(route['url'])
    if (url.scheme!='https' or not url.hostname or url.username or url.password or url.path not in ('','/') or url.query or url.fragment):
        raise ValueError('explicit trusted HTTPS base URL required')
    path=desktop_run/'private/tls-binding.json';SESSION.pin(path,route['bindingSha256']);binding=SESSION.private_json(path)
    tls=state['processes'].get('tls')
    if (binding.get('schema')!=1 or binding.get('bind')!='127.0.0.1' or binding['upstreamPort']!=state['server_port'] or
        (url.port or 443)!=binding['tlsPort'] or not tls or binding['pid']!=tls['pid'] or binding['identity']!=tls['identity'] or
        binding['argv']!=tls['argv'] or COMMON.identity(tls['pid'])!=tls['identity'] or not tls['identity'].endswith(' '.join(tls['argv']))):
        raise ValueError('trusted route must bind the existing owned server/transport')
    argv=tls['argv']
    if (len(argv)!=6 or argv[2:]!=[str(desktop_run),str(Path(c['source'])/'scripts/ci/observer.mjs'),str(state['server_port']),str(binding['tlsPort'])] or
        not argv[1].endswith('/scripts/validation/mobile-tls.mjs')):raise ValueError('owned TLS argv must route to this exact server')
    SESSION.pin(Path(argv[1]),binding['scriptSha256'])
    for port in (binding['tlsPort'],binding['recorderPort']):SESSION.listener(tls['pid'],port)
    cert=COMMON.checked_file(desktop_run/'private/tls.crt')
    expected=hashlib.sha256(TLS.leaf_der(cert.read_bytes())).hexdigest()
    if expected!=route['leafDerSha256']:raise ValueError('owned transport leaf pin mismatch')
    context=ssl.create_default_context();context.verify_flags|=ssl.VERIFY_X509_STRICT
    connection=http.client.HTTPSConnection(url.hostname,url.port or 443,context=context,timeout=10)
    try:
        connection.connect()
        if hashlib.sha256(connection.sock.getpeercert(binary_form=True)).hexdigest()!=expected:raise ValueError('trusted endpoint is not the owned TLS leaf')
        connection.request('GET','/readyz');response=connection.getresponse();body=response.read(65537)
        if response.status!=200 or len(body)>65536 or json.loads(body).get('ready') is not True:raise ValueError('trusted owned endpoint readiness failed')
    finally:connection.close()
    if route.get('transport') not in ('direct','adb-reverse'):raise ValueError('explicit existing route transport required')
    return {'url':route['url'].rstrip('/'),'transport':route['transport'],'port':binding['tlsPort'],
        'leafDerSha256':expected,'bindingSha256':route['bindingSha256'],'hostSystemTrustVerified':True,
        'nativeWebViewTrust':'REQUIRED','sameOwnedServerBinding':True}


def configuration(path,run):
    c=SESSION.private_json(path)
    if c.get('schema')!=1 or c.get('targetKind')!='usb' or c.get('ownerApprovedDedicatedFixture') is not True:
        raise ValueError('explicit owner-authorized dedicated USB fixture required')
    if not re.fullmatch(SERIAL,c.get('serial','')) or c['serial'].startswith('emulator-'):raise ValueError('one supplied USB serial required; no discovery')
    if not re.fullmatch(r'/storage/emulated/0/Documents/Obsync-[A-Za-z0-9-]+',c.get('vaultPath','')):raise ValueError('explicit fresh synthetic vault required')
    c['source']=Path(c['source']);c['sdk']=Path(c['sdk']);c['seconds']=c.get('seconds',7200)
    if type(c['seconds']) is not int or not 1<=c['seconds']<=14400:raise ValueError('USB deadline must be 1..14400 seconds')
    if (subprocess.check_output(['git','-C',str(c['source']),'rev-parse','HEAD'],text=True).strip()!=c['sourceHead'] or
        not re.fullmatch('[a-f0-9]{40}',c['sourceHead']) or subprocess.check_output(['git','-C',str(c['source']),'status','--porcelain'])):raise ValueError('exact clean candidate required')
    if not re.fullmatch(r'https://github\.com/obsidianmd/obsidian-releases/releases/download/v[^/]+/Obsidian-[^/]+\.apk',c['apk']['url']):raise ValueError('official Obsidian APK acquisition URL required')
    if not re.fullmatch('[a-f0-9]{64}',c['apk']['sha256']):raise ValueError('official APK pin required')
    SESSION.pin(c['sdk']/'platform-tools/adb',c['adbSha256'])
    if run.exists() or run.is_symlink() or not run.parent.is_dir() or run.parent.resolve()!=run.parent:raise ValueError('fresh real USB run path required')
    common=Path(subprocess.check_output(['git','-C',str(c['source']),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()).parent
    for root in (c['source'].resolve(),common.resolve(),Path(c['desktopRun']).resolve()):
        if root==run or root in run.parents or run in root.parents:raise ValueError('external separate USB run required')
    c['routeProof']=trusted_route(c)  # no USB is accessed before route proof
    return c


def execute(c,run,command):
    os.umask(0o077);created=False;outcome='FAIL';failure=None;cleanup='FAIL';cleanup_failure=None;stage='private-adb';reverse_added=False
    now=time.time();state={'format':1,'targetKind':'usb','run':str(run),'sourceHead':c['sourceHead'],'sdk':str(c['sdk']),
        'serial':c['serial'],'adbPort':COMMON.free_port(),'expiresAtEpoch':now+c['seconds'],'processes':{},'reversePorts':[],
        'holder':{'pid':os.getpid(),'identity':COMMON.identity(os.getpid())},
        'usb':{'ownerApprovedDedicatedFixture':True,'serialSha256':hashlib.sha256(c['serial'].encode()).hexdigest(),'vaultPath':c['vaultPath']}}
    if not state['holder']['identity']:raise RuntimeError('USB holder identity unavailable')
    state['environment']={'PATH':str(Path(sys.executable).parent)+os.pathsep+os.defpath,'HOME':str(run/'runtime/user'),'ANDROID_USER_HOME':str(run/'runtime/user'),
        'ADB_SERVER_SOCKET':'tcp:127.0.0.1:'+str(state['adbPort']),'ANDROID_ADB_SERVER_PORT':str(state['adbPort']),
        'ADB_USB':'1','ADB_EMU':'0','ADB_MDNS':'0','ADB_MDNS_AUTO_CONNECT':'','ADB_VENDOR_KEYS':str(run/'runtime/user/adbkey')}
    owner=COMMON.Owned(run,state);handlers={}
    def interrupted(sig,_):raise InterruptedError('USB owner interrupted '+str(sig))
    for sig in (signal.SIGINT,signal.SIGTERM):handlers[sig]=signal.signal(sig,interrupted)
    try:
        run.mkdir(mode=0o700);created=True
        for name in ('private','evidence','runtime/user'):(run/name).mkdir(mode=0o700,parents=True,exist_ok=True)
        COMMON.save(run/'android.json',state)
        argv=[str(c['sdk']/'platform-tools/adb'),'--one-device',c['serial'],'-L','tcp:'+str(state['adbPort']),'server','nodaemon']
        owner.launch('adb',argv,state['environment']);owner.record('adb');state['processes']['adb']['argv']=argv
        COMMON.save(run/'android.json',state);COMMON.adb_listener(owner,state);target_guard(state)
        stage='owner-key-authorization'
        authorized_serial(state,c['serial'])
        stage='verify-existing-official-app'
        paths=COMMON.adb_command(state,['shell','pm','path','md.obsidian']).strip().splitlines()
        if len(paths)!=1 or not re.fullmatch(r'package:/data/app/[A-Za-z0-9_=~./+-]+/base\.apk',paths[0]):raise ValueError('single official installed Obsidian APK required; no install or replacement performed')
        installed=COMMON.adb_command(state,['exec-out','cat',paths[0][8:]],binary=True,timeout=60)
        if hashlib.sha256(installed).hexdigest()!=c['apk']['sha256']:raise ValueError('existing signed APK differs from explicit official pin')
        COMMON.adb_command(state,['shell','test','!','-e',c['vaultPath']])
        if COMMON.app_pid(state) is None:raise ValueError('owner must open dedicated fresh Obsidian onboarding externally; existing app data is preserved')
        if c['routeProof']['transport']=='adb-reverse':
            port=c['routeProof']['port'];mapping=f'tcp:{port}'
            if any(mapping in line.split()[-2:] for line in COMMON.adb_command(state,['reverse','--list']).splitlines()):raise ValueError('fresh owned reverse port required; existing mapping untouched')
            COMMON.adb_command(state,['reverse',mapping,mapping]);reverse_added=True;state['reversePorts']=[port];COMMON.save(run/'android.json',state)
        COMMON.save(run/'evidence/assets.json',{'apkSha256':c['apk']['sha256'],'apkUrl':c['apk']['url'],'adbSha256':c['adbSha256'],'archives':[]})
        facts={name:COMMON.adb_command(state,['shell','getprop',name]).strip() for name in PLATFORM.PROPERTIES[:4]}
        COMMON.save(run/'evidence/android-ready.json',{'result':'READY','sourceHead':c['sourceHead'],'targetKind':'usb',
            'freshProfile':False,'freshPhysicalEnvironment':False,'installedApkVerified':True,'apkSha256':c['apk']['sha256'],
            'facts':facts,'trustedRoute':c['routeProof'],'configuredVaultAbsent':'ORDINARY_JOURNEY_PRECONDITION_REQUIRED',
            'vaultPath':c['vaultPath'],'physicalPhone':'CONNECTED_ONLY','hardwareBackedCustody':'NOT_MEASURED','productAcceptance':'NOT_RUN'})
        print(json.dumps({'result':'READY','run':str(run),'targetKind':'usb','sourceHead':c['sourceHead']}),flush=True)
        stage='journey';child=owner.launch('journey',command,state['environment']|{'OBSYNC_ANDROID_RUN':str(run),'OBSYNC_ANDROID_TARGET_KIND':'usb','OBSYNC_MOBILE_RUN':c['desktopRun']})
        while COMMON.exit_code(child) is None:
            if time.time()>=state['expiresAtEpoch']:raise TimeoutError('USB journey deadline')
            if COMMON.exit_code(owner.children['adb']) is not None:raise RuntimeError('owned USB ADB exited')
            time.sleep(.1)
        if COMMON.exit_code(child)!=0:raise RuntimeError('USB journey failed; sanitized child phase evidence required')
        outcome='PASS'
    except BaseException as error:
        failure={'stage':stage,'exceptionType':type(error).__name__,'detail':COMMON.sanitized_diagnostic(str(error))[:300]};raise
    finally:
        for sig in handlers:signal.signal(sig,signal.SIG_IGN)
        try:
            try:
                if reverse_added:COMMON.adb_command(state|{'expiresAtEpoch':time.time()+15},['reverse','--remove','tcp:'+str(c['routeProof']['port'])])
            finally:owner.stop()  # even a lost USB transport must not leak ADB/helper groups
            if created:
                for name in ('runtime','private'):shutil.rmtree(run/name)
                (run/'android.json').unlink(missing_ok=True)
            cleanup='PASS'
        except BaseException as error:
            cleanup_failure={'exceptionType':type(error).__name__,'detail':COMMON.sanitized_diagnostic(str(error))[:300]};raise
        finally:
            if created:COMMON.save(run/'evidence/result.json',{'result':outcome if cleanup=='PASS' else 'FAIL','sourceHead':c['sourceHead'],
                'cleanup':cleanup,'failure':failure,'cleanupFailure':cleanup_failure,'ownedGroupsRemaining':0 if cleanup=='PASS' else None,
                'runtimeAbsent':not(run/'runtime').exists(),'privateAbsent':not(run/'private').exists(),'manifestAbsent':not(run/'android.json').exists(),
                'targetKind':'usb','physicalPhone':'JOURNEY_EXECUTED' if outcome=='PASS' else 'INCOMPLETE','freshPhysicalEnvironment':False,
                'deviceFixtureCleanup':'ORDINARY_LEAVE_AND_TEST_VAULT_REMOVAL_REQUIRED','existingAppDataPreserved':True,
                'hostCleanupDoesNotAssertDeviceCleanup':True,'productAcceptance':'NOT_ASSERTED'})
            for sig,handler in handlers.items():signal.signal(sig,handler)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',type=Path,required=True);p.add_argument('--run',type=Path,required=True)
    p.add_argument('--child',nargs=argparse.REMAINDER,required=True);a=p.parse_args()
    if not a.child:p.error('same bounded journey child required')
    run=a.run.expanduser().absolute();execute(configuration(a.config,run),run,a.child)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'result':'FAIL','exceptionType':type(error).__name__,'detail':COMMON.sanitized_diagnostic(str(error))[:300],
            'physicalPhone':'INCOMPLETE','productAcceptance':'NOT_ASSERTED'}),file=sys.stderr);sys.exit(1)
