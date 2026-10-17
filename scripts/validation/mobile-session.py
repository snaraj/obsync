#!/usr/bin/env python3
"""Own one fresh native Mac peer, real server and local recorded HTTPS hop."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
import urllib.error

SPEC=importlib.util.spec_from_file_location('android_session',Path(__file__).with_name('android-session.py'))
COMMON=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(COMMON)
PLUGIN=('main.js','manifest.json','styles.css')


def private_json(path):
    stat=path.lstat()
    if path.resolve()!=path.absolute() or path.is_symlink() or not path.is_file() or stat.st_uid!=os.getuid() or stat.st_mode&0o077 or stat.st_nlink!=1 or stat.st_size>65536:
        raise ValueError('owned private configuration/request required')
    return json.loads(path.read_text())


def pin(path,expected):
    COMMON.checked_file(path)
    if not re.fullmatch('[a-f0-9]{64}',expected) or COMMON.digest(path)!=expected:
        raise ValueError('pinned artifact differs: '+path.name)


def supplied_tls():
    spec=importlib.util.spec_from_file_location('mobile_trusted_tls',Path(__file__).with_name('mobile-trusted-tls.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def configuration(path,run):
    c=private_json(path)
    if c.get('schema')!=1: raise ValueError('configuration schema1 required')
    c['mode']=c.get('mode','acceptance')
    if c['mode'] not in ('core','acceptance'): raise ValueError('explicit core or acceptance mode required')
    if c.get('trustedTls'):
        if c.get('android',{}).get('targetKind')!='usb' or c['mode']!='core':raise ValueError('supplied TLS is supported only for explicit USB core')
        c['trustedTls']=supplied_tls().validate(c['trustedTls'])
    for key in ('source','serverBinary','node','obsidianExecutable','obsidianAsar','tlsScript'):
        c[key]=Path(c[key]).expanduser().absolute()
    source=c['source']
    head=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}',c['sourceHead']) or head!=c['sourceHead'] or subprocess.check_output(['git','-C',str(source),'status','--porcelain']):
        raise ValueError('exact clean candidate source required')
    common=Path(subprocess.check_output(['git','-C',str(source),'rev-parse','--path-format=absolute','--git-common-dir'],text=True).strip()).parent
    if run.exists() or run.is_symlink(): raise ValueError('fresh absent run required')
    if not run.parent.is_dir() or any(p.is_symlink() for p in (run.parent,*run.parent.parents)):
        raise ValueError('existing real run parent required')
    for root in (source.resolve(),common.resolve()):
        if root==run.resolve() or root in run.resolve().parents or run.resolve() in root.parents:
            raise ValueError('external run required')
    if source.resolve()!=source: raise ValueError('real candidate source required')
    if shutil.disk_usage(run.parent).free<20*1024**3: raise ValueError('20 GiB free required')
    c['seconds']=c.get('seconds',14400);c['tlsPort']=c.get('tlsPort',18473)
    if not isinstance(c['seconds'],int) or not 1<=c['seconds']<=86400: raise ValueError('bounded session duration required')
    if not isinstance(c['tlsPort'],int) or not 1024<=c['tlsPort']<=65535: raise ValueError('nonprivileged local TLS port required')
    if not str(c['obsidianExecutable']).endswith('/Obsidian.app/Contents/MacOS/Obsidian'):
        raise ValueError('explicit official Obsidian executable required')
    if c['obsidianAsar']!=c['obsidianExecutable'].parent.parent/'Resources/app.asar':
        raise ValueError('official app.asar must belong to the pinned application')
    if not str(c['tlsScript']).endswith('/scripts/validation/mobile-tls.mjs'):
        raise ValueError('explicit mobile-tls.mjs required')
    for key in ('serverBinary','node','obsidianExecutable','obsidianAsar','tlsScript'):
        pin(c[key],c[{'serverBinary':'serverSha256','node':'nodeSha256','obsidianExecutable':'obsidianSha256','obsidianAsar':'obsidianAsarSha256','tlsScript':'tlsScriptSha256'}[key]])
    observer=source/'scripts/ci/observer.mjs';pin(observer,c['observerSha256'])
    if set(c['pluginHashes'])!=set(PLUGIN): raise ValueError('exact three candidate plugin hashes required')
    for name in PLUGIN:pin(source/'plugin/dist'/name,c['pluginHashes'][name])
    with socket.socket() as sock:sock.bind(('127.0.0.1',c['tlsPort']))
    c['observer']=observer
    return c


def certificates(private):
    ext=private/'leaf.ext'
    ext.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n')
    commands=[['req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(private/'ca.key'),'-out',str(private/'ca.crt'),'-days','1','-subj','/CN=Obsync disposable mobile test CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],
        ['req','-newkey','rsa:2048','-nodes','-keyout',str(private/'tls.key'),'-out',str(private/'leaf.csr'),'-subj','/CN=localhost'],
        ['x509','-req','-in',str(private/'leaf.csr'),'-CA',str(private/'ca.crt'),'-CAkey',str(private/'ca.key'),'-CAcreateserial','-out',str(private/'tls.crt'),'-days','1','-extfile',str(ext)]]
    with (private/'openssl.log').open('wb') as log:
        for command in commands:subprocess.run(['openssl',*command],stdout=log,stderr=log,check=True,timeout=30)
    # OpenSSL chain checks plus Python's strict hostname-verifying TLS client
    # are exercised again against the actual listener before READY.
    subprocess.run(['openssl','verify','-CAfile',str(private/'ca.crt'),'-verify_hostname','localhost',str(private/'tls.crt')],capture_output=True,check=True)


class Peers(COMMON.Owned):
    def stop(self):
        # The child owns an Android controller whose ADB/emulator groups need
        # their own bounded cleanup before this enclosing group can be reaped.
        super().stop(term_seconds=90)

    def launch(self,name,argv,env=None):
        child=super().launch(name,argv,env)
        previous=None
        for _ in range(40):
            current=COMMON.identity(child.pid)
            if COMMON.exit_code(child) is not None: raise RuntimeError(name+' exited during startup')
            if current and current==previous:
                self.state['processes'][name]={'pid':child.pid,'identity':current,'argv':argv}
                COMMON.save(self.run/'lab.json',self.state)
                return child
            previous=current;time.sleep(.1)
        raise RuntimeError(name+' startup identity deadline')

    def stop_one(self,name,term_seconds=10):
        owner=COMMON.Owned(self.run,self.state);owner.children[name]=self.children[name]
        owner.stop(term_seconds=term_seconds)
        child=self.children.pop(name)
        self.state['processes'].pop(name,None)
        COMMON.save(self.run/'lab.json',self.state)
        return child.returncode

    def require(self,*names):
        ended=[name+' exit='+str(COMMON.exit_code(self.children[name])) for name in names if COMMON.exit_code(self.children[name]) is not None]
        if ended:raise RuntimeError('owned peer exited: '+', '.join(ended))


def wait_http(owner,name,url,predicate,seconds=30,context=None):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        owner.require(name)
        try:
            with urllib.request.urlopen(url,timeout=1,context=context) as response:
                if predicate(response):return
        except (OSError,ValueError):pass
        time.sleep(.1)
    raise TimeoutError(name+' readiness deadline')


def listener(pid,port):
    result=subprocess.run(['lsof','-nP','-a','-p',str(pid),'-iTCP:'+str(port),'-sTCP:LISTEN','-Fn'],capture_output=True,text=True,check=True)
    if [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]!=[f'127.0.0.1:{port}']:
        raise RuntimeError('peer listener is not exclusively IPv4 loopback')


def startup_failure(run,stage,error):
    logs={}
    for name in ('server','A','tls','openssl'):
        path=run/'private'/(name+'.log')
        if path.is_file() and not path.is_symlink():
            with path.open('rb') as stream:
                size=stream.seek(0,os.SEEK_END);stream.seek(max(0,size-8192));data=stream.read(8192)
            if size>8192:data=data.partition(b'\n')[2]
            logs[name]=COMMON.sanitized_diagnostic(data)
    COMMON.save(run/'evidence/startup-failure.json',{'stage':stage,'exceptionType':type(error).__name__,'logs':logs,
        'stderr':COMMON.sanitized_diagnostic((getattr(error,'stderr',None) or b'')[-8192:])})


def request(run,name):
    path=run/'private'/name
    if not path.exists():return None
    value=private_json(path)
    if value.get('schema')!=1 or not re.fullmatch('[A-Za-z0-9_-]{1,64}',value.get('requestId','')):
        raise ValueError('owned lifecycle request schema refused')
    return value


def terminal_transport_close(owner,c,active_desktop,request_id,deadline):
    expected='A' if c['mode']=='core' else 'C'
    if active_desktop!=expected:raise ValueError('last owned desktop required for terminal close')
    android=private_json(owner.run.parent/'android/evidence/result.json')
    if android.get('result')!='PASS' or android.get('sourceHead')!=c['sourceHead'] or android.get('cleanup')!='PASS' or android.get('ownedGroupsRemaining')!=0 or not all(android.get(k) is True for k in ('runtimeAbsent','privateAbsent','manifestAbsent')):
        raise ValueError('Android cleanup must precede terminal close')
    desktop=owner.children[active_desktop];quit_until=min(deadline,time.monotonic()+15)
    while True:
        code=COMMON.exit_code(desktop)  # WNOWAIT retains original process-group custody.
        members=COMMON.group_members(desktop.pid)
        if code is not None and not any(not status.startswith('Z') for _,status in members):break
        if time.monotonic()>=quit_until:raise TimeoutError('terminal ordinary desktop Quit deadline')
        time.sleep(.1)
    if code!=0:raise RuntimeError('terminal desktop Quit must exit naturally with code0')
    tls_pid=owner.children['tls'].pid
    code=owner.stop_one('tls',term_seconds=90)
    complete,_=capture_manifest(owner.run,c)
    diagnostic=private_json(owner.run/'evidence/transport-close.json')
    if code!=0:
        reason=diagnostic.get('code')
        if reason not in ('tls_drain_deadline','recorder_index_invalid','recorder_upstream_eof_missing','recorder_drain_deadline','recorder_failed'):reason='transport_close_refused'
        raise RuntimeError('recorder close failed: '+reason+'; exit='+str(code))
    if diagnostic.get('result')!='CLOSED' or diagnostic.get('sourceHead')!=c['sourceHead'] or diagnostic.get('tlsPid')!=tls_pid or diagnostic.get('recorderNaturalEof') is not True or diagnostic.get('tlsActiveSockets')!=0 or diagnostic.get('recorderPendingConnections')!=0 or diagnostic.get('recorderConnectionsWithoutUpstreamEof')!=0 or diagnostic.get('indexPartialRow') is not False or diagnostic.get('drainDeadlineMs')!=70000 or not 0<=diagnostic.get('drainMs',-1)<=70000 or diagnostic.get('recorderErrors')!=[] or diagnostic.get('recorderConnections')!=complete.get('connections') or diagnostic.get('completedRecorderConnections')!=complete.get('connections'):
        raise RuntimeError('natural complete recorder drain proof refused')
    if complete.get('errors') or not complete.get('connections'):raise RuntimeError('empty or failed recorder completion')
    return {'schema':1,'requestId':request_id,'result':'CLOSED','sourceHead':c['sourceHead'],'ownedGroupAbsent':True,
        'connections':complete['connections'],'desktopSlot':active_desktop,'naturalDesktopQuitExitCode':0,
        'desktopGroupNaturallyAbsent':True,'recorderNaturalEof':True,'drainDeadlineMs':70000,'closeProtocol':'NATURAL_EOF_90S'}


def capture_manifest(run,c):
    traffic=run/'private/traffic'
    if traffic.is_symlink() or traffic.resolve()!=traffic.absolute():raise ValueError('owned recorder directory required')
    complete=private_json(traffic/'complete.json')
    if complete.get('version')!=1 or not isinstance(complete.get('connections'),int) or not isinstance(complete.get('errors'),list):
        raise ValueError('incomplete recorder completion schema')
    COMMON.save(run/'evidence/traffic-complete.json',complete)
    files={}
    for path in sorted(traffic.iterdir()):
        if not re.fullmatch(r'(?:c\d+\.(?:up|down)|index\.jsonl|complete\.json)',path.name):
            raise ValueError('unexpected recorder artifact name')
        COMMON.checked_file(path)
        files[path.name]={'sha256':COMMON.digest(path),'bytes':path.stat().st_size}
    manifest={'schema':1,'sourceHead':c['sourceHead'],'observerSha256':c['observerSha256'],'files':files}
    path=run/'evidence/traffic-manifest.json';COMMON.save(path,manifest)
    return complete,COMMON.digest(path)


def scan_manifest(run,c):
    proof=private_json(run/'private/scan-result.json')
    capture=run/'evidence/traffic-manifest.json'
    if proof.get('schema')!=1 or proof.get('result')!='PASS' or proof.get('sourceHead')!=c['sourceHead'] or proof.get('observerSha256')!=c['observerSha256'] or proof.get('captureManifestSha256')!=COMMON.digest(capture):
        raise ValueError('completed exact-source observer scan receipt required')
    receipts=proof.get('receipts')
    expected=['evidence/native-confidentiality.json','evidence/native-confidentiality-controls.json']
    if receipts!=expected:raise ValueError('both fixed native confidentiality receipts required')
    hashes={}
    for name in receipts:
        if not isinstance(name,str) or not re.fullmatch(r'evidence/[A-Za-z0-9_.-]+\.json',name):
            raise ValueError('owned sanitized scan receipt path required')
        receipt=private_json(run/name)
        if (type(receipt.get('schema')) is not int or receipt['schema']!=1 or receipt.get('result')!='PASS' or
            any(receipt.get(key)!=value for key,value in (('sourceHead',c['sourceHead']),('observerSha256',c['observerSha256']),
                ('captureManifestSha256',COMMON.digest(capture)))) or not re.fullmatch('[a-f0-9]{64}',receipt.get('opaqueScannerSha256',''))):
            raise ValueError('scan receipt source/result binding refused')
        hashes[name]=COMMON.digest(run/name)
    scan=private_json(run/expected[0]);controls=private_json(run/expected[1])
    minima={'notes':3,'nativeCaptures':3,'pairingCodes':1,'metadataExports':1,'contentNeedles':11,
        'trafficConnections':1,'trafficRequests':1,'trafficBytes':1,'serverStorageFiles':4,'serverLogBytes':1,'scannedBytes':1,'scannedFiles':1}
    if (scan.get('origin')!='native-confidentiality' or any(type(scan.get(key)) is not int or scan[key]<value for key,value in minima.items()) or
        type(scan.get('backups')) is not int or scan['backups']!=3 or type(scan.get('unexpectedHits')) is not int or scan['unexpectedHits']!=0 or
        type(scan.get('parseErrors')) is not int or scan['parseErrors']!=0 or scan.get('knownRootDerivedKeyCoverageOnly') is not True or
        scan.get('rawApiCredentialValueScan')!='NOT_MEASURED' or scan.get('apiCredentialTrafficSinks')!='NOT_ASSESSED' or
        type(scan.get('durationMs')) is not int or not 0<=scan['durationMs']<=60000 or type(scan.get('budgetMs')) is not int or scan['budgetMs']!=60000):
        raise ValueError('scan receipt coverage/counts refused')
    if (controls.get('origin')!='detached-scanner-controls' or controls['opaqueScannerSha256']!=scan['opaqueScannerSha256'] or
        controls.get('scratchCleanup')!='VERIFIED' or any(controls.get(key) is not True for key in ('baselinePassed',
        'parseableClonedHttpLeakDetected','copiedServerStorageLeakDetected','copiedServerLogLeakDetected','nativeCaptureUnchanged','serverSnapshotUnchanged'))):
        raise ValueError('scan negative controls refused')
    COMMON.save(run/'evidence/scan-manifest.json',{'schema':1,'result':'PASS','sourceHead':c['sourceHead'],
        'observerSha256':c['observerSha256'],'captureManifestSha256':COMMON.digest(capture),'receipts':hashes,
        'productAcceptance':'NOT_ASSERTED'})


def execute(c,run,command):
    os.umask(0o077)
    started=time.time();deadline=time.monotonic()+c['seconds'];stage='provision';outcome='FAIL';failure=None;created=False
    holder=COMMON.identity(os.getpid())
    if not holder:raise RuntimeError('session holder identity unavailable')
    state={'format':1,'run':str(run),'processes':{},'devices':{},'source_head':c['sourceHead'],'source_dirty':False,
        'holder':{'pid':os.getpid(),'identity':holder},'server_port':COMMON.free_port(),'artifacts':{},'expiresAtEpoch':started+c['seconds']}
    owner=Peers(run,state);handlers={};transport_closed=False
    def interrupted(sig,_):raise InterruptedError('mobile session interrupted by signal '+str(sig))
    for sig in (signal.SIGINT,signal.SIGTERM):handlers[sig]=signal.signal(sig,interrupted)
    try:
        run.mkdir(mode=0o700);created=True
        for name in ('runtime/build/plugin','runtime/server/blobs','runtime/server/journal','runtime/A/userdata','runtime/A/Lab-A/.obsidian/plugins/obsync-private-sync','private','evidence'):
            (run/name).mkdir(mode=0o700,parents=True,exist_ok=True)
        build=run/'runtime/build';private=run/'private'
        shutil.copy2(c['serverBinary'],build/'obsyncd');pin(build/'obsyncd',c['serverSha256'])
        state['artifacts']['obsyncd']=c['serverSha256']
        for name in PLUGIN:
            for dest in (build/'plugin'/name,run/'runtime/A/Lab-A/.obsidian/plugins/obsync-private-sync'/name):
                shutil.copy2(c['source']/'plugin/dist'/name,dest);pin(dest,c['pluginHashes'][name])
            state['artifacts']['plugin/'+name]=c['pluginHashes'][name]
        shutil.copytree(c['source']/'dashboard',build/'dashboard')
        COMMON.save(run/'runtime/A/Lab-A/.obsidian/community-plugins.json',['obsync-private-sync'])
        COMMON.save(run/'runtime/A/userdata/obsidian.json',{'updateDisabled':True})
        state['devices']['A']={'vault':str(run/'runtime/A/Lab-A'),'userdata':str(run/'runtime/A/userdata'),'port':COMMON.free_port()}
        env={'PATH':os.defpath,'OBSYNC_EDGE':'none','OBSYNC_LISTEN':f"127.0.0.1:{state['server_port']}",
            'OBSYNC_PUBLIC_URL':f"http://127.0.0.1:{state['server_port']}",'OBSYNC_BLOBS_DIR':str(run/'runtime/server/blobs'),
            'OBSYNC_JOURNAL_DIR':str(run/'runtime/server/journal'),'OBSYNC_BLOBS_CAPACITY':'20GiB','OBSYNC_JOURNAL_CAPACITY':'8GiB',
            'OBSYNC_DASHBOARD_DIR':str(build/'dashboard'),'OBSYNC_PLUGIN_DIR':str(build/'plugin')}
        stage='server';server=owner.launch('server',[str(build/'obsyncd'),'serve'],env)
        wait_http(owner,'server',f"http://127.0.0.1:{state['server_port']}/readyz",lambda r:json.load(r).get('ready') is True)
        listener(server.pid,state['server_port'])
        stage='certificate'
        tls_proof=supplied_tls().stage(private,c['trustedTls']) if c.get('trustedTls') else None
        if not tls_proof:certificates(private)
        stage='transport'
        tls_argv=[str(c['node']),str(c['tlsScript']),str(run),str(c['observer']),str(state['server_port']),str(c['tlsPort'])]
        tls=owner.launch('tls',tls_argv)
        until=min(deadline,time.monotonic()+20)
        while not (private/'tls-ready.json').exists():
            owner.require('tls','server')
            if time.monotonic()>=until:raise TimeoutError('local transport startup deadline')
            time.sleep(.1)
        transport=private_json(private/'tls-ready.json')
        if transport.get('bind')!='127.0.0.1' or transport.get('port')!=c['tlsPort'] or not isinstance(transport.get('recorderPort'),int) or not 1024<=transport['recorderPort']<=65535:
            raise ValueError('invalid owned local TLS readiness')
        for port in (c['tlsPort'],transport['recorderPort']):listener(tls.pid,port)
        binding={'schema':1,'pid':tls.pid,'identity':state['processes']['tls']['identity'],'argv':tls_argv,
            'scriptSha256':c['tlsScriptSha256'],'upstreamPort':state['server_port'],'recorderPort':transport['recorderPort'],'tlsPort':c['tlsPort'],'bind':'127.0.0.1'}
        COMMON.save(private/'tls-binding.json',binding)
        hostname=c['trustedTls']['hostname'] if tls_proof else 'localhost'
        context=supplied_tls().client_context() if tls_proof else ssl.create_default_context(cafile=str(private/'ca.crt'))
        context.verify_flags|=ssl.VERIFY_X509_STRICT
        wait_http(owner,'tls',f"https://{hostname}:{c['tlsPort']}/readyz",lambda r:r.status==200,context=context)
        try:
            urllib.request.urlopen(f"https://127.0.0.1:{c['tlsPort']}/readyz",timeout=3,context=context)
        except urllib.error.URLError as error:
            if not isinstance(error.reason,ssl.SSLCertVerificationError) or error.reason.verify_code!=64:
                raise RuntimeError('wrong-hostname control failed for an unrelated reason') from error
        else:raise RuntimeError('wrong hostname unexpectedly trusted')
        COMMON.save(run/'evidence/host-tls.json',{'result':'PASS','validHostnameAccepted':True,'wrongHostnameRejected':True,
            'trustBasis':'SYSTEM_DEFAULT' if tls_proof else 'SYNTHETIC_DISPOSABLE_CA',
            'caSha256':None if tls_proof else COMMON.digest(private/'ca.crt'),'leafSha256':COMMON.digest(private/'tls.crt'),
            'suppliedCertificate':tls_proof,'hostTrustChanged':False})
        state.update(url=f"http://127.0.0.1:{transport['recorderPort']}",mobileUrl=f"https://{hostname}:{c['tlsPort']}",
            transport='Desktop loopback HTTP and Android verified local HTTPS; both streams recorded')
        stage='desktop';device=state['devices']['A']
        app_argv=[str(c['obsidianExecutable']),'--user-data-dir='+device['userdata'],'--remote-debugging-port='+str(device['port']),'--remote-debugging-address=127.0.0.1']
        app=owner.launch('A',app_argv)
        wait_http(owner,'A',f"http://127.0.0.1:{device['port']}/json/version",lambda r:'Browser' in json.load(r))
        listener(app.pid,device['port'])
        COMMON.save(run/'lab.json',state)
        COMMON.save(run/'evidence/build.json',{key:state[key] for key in ('source_head','source_dirty','artifacts','transport')})
        COMMON.save(run/'evidence/peer-ready.json',{'result':'READY','sourceHead':c['sourceHead'],'artifacts':state['artifacts'],
            'nodeSha256':c['nodeSha256'],'obsidianExecutableSha256':c['obsidianSha256'],'obsidianAsarSha256':c['obsidianAsarSha256'],
            'desktopMockKeychain':False,'publicExposure':False,'productAcceptance':'NOT_RUN'})
        print(json.dumps({'result':'READY','run':str(run)}),flush=True)
        stage='child';child=owner.launch('child',command,dict(os.environ,OBSYNC_MOBILE_RUN=str(run)));seen=set();app_exit_at=None;active_desktop='A'
        while COMMON.exit_code(child) is None:
            if time.monotonic()>=deadline:raise TimeoutError('mobile session duration deadline')
            fresh=request(run,'provision-recovery.json')
            if fresh and fresh['requestId'] not in seen:
                if transport_closed:raise ValueError('recovery must precede terminal recorder closure')
                spec=importlib.util.spec_from_file_location('mobile_recovery',Path(__file__).with_name('mobile-recovery.py'))
                recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)
                receipt=recovery.provision(owner,c,fresh.get('device'),fresh.get('androidRun'),fresh.get('androidOldPid'),fresh['requestId'])
                active_desktop=fresh['device'];app_exit_at=None
                COMMON.save(private/'provision-recovery-result.json',receipt);seen.add(fresh['requestId'])
            restart=request(run,'restart.json')
            if restart and restart['requestId'] not in seen:
                if active_desktop!='A' or restart.get('device')!='A':raise ValueError('only owned desktop A may restart')
                previous=owner.children['A'];quit_until=min(deadline,time.monotonic()+15)
                while COMMON.exit_code(previous) is None and time.monotonic()<quit_until:time.sleep(.1)
                if COMMON.exit_code(previous)!=0:raise RuntimeError('ordinary desktop quit not observed; restart refused')
                old=previous.pid;owner.stop_one('A')
                launch_started=round(time.time()*1000)
                app=owner.launch('A',app_argv)
                wait_http(owner,'A',f"http://127.0.0.1:{device['port']}/json/version",lambda r:'Browser' in json.load(r))
                listener(app.pid,device['port'])
                receipt={'schema':1,'requestId':restart['requestId'],'result':'RESTARTED','oldPid':old,'oldGroupAbsent':True,'newPid':app.pid,'profileReset':False,'naturalQuitExitCode':0,'launchStartedAtEpochMs':launch_started}
                COMMON.save(private/'restart-result.json',receipt);COMMON.save(run/'evidence'/('desktop-restart-'+restart['requestId']+'.json'),receipt)
                seen.add(restart['requestId']);app_exit_at=None
            close=request(run,'close-transport.json')
            if close and close['requestId'] not in seen:
                if close.get('protocol')!='NATURAL_EOF_90S':raise ValueError('explicit natural EOF terminal close protocol required')
                receipt=terminal_transport_close(owner,c,active_desktop,close['requestId'],deadline)
                transport_closed=True
                COMMON.save(run/'evidence/transport-terminal.json',receipt)
                COMMON.save(private/'close-transport-result.json',receipt);seen.add(close['requestId'])
            owner.require('server',*(() if transport_closed else ('tls',)))
            if not transport_closed and COMMON.exit_code(owner.children[active_desktop]) is not None:
                app_exit_at=app_exit_at or time.monotonic()
                if time.monotonic()-app_exit_at>30:raise RuntimeError('desktop quit without bounded restart request')
            else:app_exit_at=None
            time.sleep(.1)
        if time.monotonic()>=deadline:raise TimeoutError('mobile session duration deadline after child')
        if COMMON.exit_code(child)!=0:raise RuntimeError('child exited '+str(COMMON.exit_code(child))+'; child must emit sanitized phase evidence')
        owner.require('server')
        if not transport_closed:raise RuntimeError('child must close and scan complete recorder before success')
        if c['mode']=='acceptance':
            scan_manifest(run,c)
            outcome='PASS'
        else:
            # This is a bounded architecture check, never full acceptance.
            outcome='CORE_ONLY'
    except BaseException as error:
        failure={'stage':stage,'exceptionType':type(error).__name__,'detail':COMMON.sanitized_diagnostic(str(error))[:400]}
        if created and (run/'evidence').is_dir() and stage!='child':startup_failure(run,stage,error)
        raise
    finally:
        for sig in handlers:signal.signal(sig,signal.SIG_IGN)
        cleanup='FAIL'
        try:
            owner.stop()
            nested=run.parent/'android'
            if nested.exists():
                receipt=private_json(nested/'evidence/result.json')
                if receipt.get('cleanup')!='PASS' or receipt.get('ownedGroupsRemaining')!=0 or not all(receipt.get(k) is True for k in ('runtimeAbsent','privateAbsent','manifestAbsent')):
                    raise RuntimeError('nested Android teardown unproven; peer profile retained')
            if created and (run/'private/traffic/complete.json').is_file():
                capture_manifest(run,c)
            if created:
                for name in ('runtime','private'):
                    if (run/name).is_symlink():raise RuntimeError('owned peer directory became a symlink')
                    if (run/name).exists():shutil.rmtree(run/name)
                (run/'lab.json').unlink(missing_ok=True)
            cleanup='PASS'
        finally:
            try:
                if created:
                    (run/'evidence').mkdir(mode=0o700,exist_ok=True)
                    COMMON.save(run/'evidence/peer-result.json',{'schema':1,'sourceHead':c['sourceHead'],'result':outcome if cleanup=='PASS' else 'FAIL','failure':failure,'cleanup':cleanup,
                        'ownedGroupsRemaining':0 if cleanup=='PASS' else None,'runtimeAbsent':not(run/'runtime').exists(),
                        'privateAbsent':not(run/'private').exists(),'manifestAbsent':not(run/'lab.json').exists(),
                        'durationSeconds':round(time.time()-started,3),'budgetSeconds':c['seconds'],'controllerExitMustBeVerified':True,'productAcceptance':'NOT_ASSERTED'})
                    if c['mode']=='core':
                        result=private_json(run/'evidence/peer-result.json')
                        result.update(mode='core',scan='NOT_RUN',fullAcceptance='NOT_RUN')
                        COMMON.save(run/'evidence/peer-result.json',result)
            finally:
                for sig,handler in handlers.items():signal.signal(sig,handler)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',type=lambda s:Path(s).expanduser().absolute(),required=True)
    p.add_argument('--run',type=lambda s:Path(s).expanduser().absolute(),required=True)
    p.add_argument('--child',nargs=argparse.REMAINDER,required=True)
    a=p.parse_args()
    if not a.child:p.error('one child journey command required')
    execute(configuration(a.config,a.run),a.run,a.child)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'result':'FAIL','exceptionType':type(error).__name__,'detail':COMMON.sanitized_diagnostic(str(error))[:400]}),file=sys.stderr)
        sys.exit(1)
