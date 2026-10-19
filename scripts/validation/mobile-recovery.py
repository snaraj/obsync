#!/usr/bin/env python3
"""Fixed fresh B/C provisioning called inside the existing mobile-session owner."""
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

SPEC=importlib.util.spec_from_file_location('mobile_session',Path(__file__).with_name('mobile-session.py'))
SESSION=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(SESSION)
COMMON=SESSION.COMMON


def android_absent(run,source_head,old_pid):
    if type(old_pid) is not int or old_pid<=1:
        raise ValueError('explicit previously owned Android app PID required')
    state=COMMON.live_state(Path(run).expanduser().absolute())
    if state['sourceHead']!=source_head:
        raise ValueError('same-candidate owned Android session required')
    if COMMON.app_pid(state) is not None or COMMON.devtools_present(state,old_pid):
        raise ValueError('paired Android package and old debugger must be absent')
    return {'packageAbsent':True,'oldDevtoolsAbsent':True,'oldPid':old_pid}


def settle_desktops(owner):
    # A native Quit request belongs to the UI operator. Never stop a live paired
    # app here: observe its exit without reaping, then settle its retained group.
    deadline=time.monotonic()+15
    for slot in ('A','B','C','D'):
        if (slot in owner.state['processes']) != (slot in owner.children):
            raise ValueError('original desktop child ownership must be retained')
        child=owner.children.get(slot)
        if child is not None:
            while True:
                code=COMMON.exit_code(child)  # WNOWAIT retains the original PGID
                if code is not None:break
                remaining=deadline-time.monotonic()
                if remaining<=0:raise TimeoutError('ordinary desktop Quit deadline for '+slot)
                time.sleep(min(.1,remaining))
            if code!=0:raise RuntimeError('ordinary desktop Quit exited nonzero for '+slot+': '+str(code))
    for slot in ('A','B','C','D'):
        if slot in owner.children:owner.stop_one(slot)


def provision(owner,config,slot,android_run,android_old_pid,request_id):
    if slot not in ('B','C','D') or not re.fullmatch('[A-Za-z0-9_-]{1,64}',request_id):
        raise ValueError('fixed fresh recovery slot/request required')
    run=owner.run;state=owner.state
    if state.get('source_dirty') is not False or state.get('source_head')!=config['sourceHead']:
        raise ValueError('same clean candidate owner required')
    if time.time()>=state['expiresAtEpoch']:
        raise ValueError('expired existing session')
    for role in ('server','tls'):
        owner.require(role)
        record=state['processes'][role]
        if COMMON.identity(record['pid'])!=record['identity']:
            raise ValueError('owned existing server/transport identity changed')
    head=subprocess.check_output(['git','-C',str(config['source']),'rev-parse','HEAD'],text=True).strip()
    if head!=config['sourceHead'] or subprocess.check_output(['git','-C',str(config['source']),'status','--porcelain']):
        raise ValueError('candidate source changed')
    SESSION.pin(config['obsidianExecutable'],config['obsidianSha256'])
    SESSION.pin(config['obsidianAsar'],config['obsidianAsarSha256'])
    profile=run/'runtime'/slot
    if slot in state['devices'] or slot in state['processes'] or profile.exists() or profile.is_symlink():
        raise ValueError('unused fresh recovery slot required')
    bodies={}
    for name in SESSION.PLUGIN:
        path=run/'runtime/build/plugin'/name
        expected=state['artifacts']['plugin/'+name]
        SESSION.pin(path,expected)
        SESSION.pin(config['source']/'plugin/dist'/name,expected)
        bodies[name]=path.read_bytes()
    absence=android_absent(android_run,config['sourceHead'],android_old_pid)
    settle_desktops(owner)
    profile.mkdir(mode=0o700)
    userdata=profile/'userdata';userdata.mkdir(mode=0o700)
    vault=profile/('Lab-'+slot)
    plugin=vault/'.obsidian/plugins/obsync-private-sync';plugin.mkdir(mode=0o700,parents=True)
    for name,body in bodies.items():
        path=plugin/name;path.write_bytes(body);path.chmod(0o600)
        SESSION.pin(path,state['artifacts']['plugin/'+name])
    COMMON.save(vault/'.obsidian/community-plugins.json',['obsync-private-sync'])
    COMMON.save(userdata/'obsidian.json',{'updateDisabled':True})
    port=COMMON.free_port()
    state['devices'][slot]={'vault':str(vault),'userdata':str(userdata),'port':port}
    COMMON.save(run/'lab.json',state)
    argv=[str(config['obsidianExecutable']),'--user-data-dir='+str(userdata),
          '--remote-debugging-port='+str(port),'--remote-debugging-address=127.0.0.1']
    child=owner.launch(slot,argv)
    SESSION.wait_http(owner,slot,f'http://127.0.0.1:{port}/json/version',lambda r:'Browser' in json.load(r))
    SESSION.listener(child.pid,port)
    binding={'schema':1,'sourceHead':state['source_head'],'source':str(config['source']),'slot':slot,'androidRun':str(Path(android_run).absolute()),
        'androidOldPid':android_old_pid,'requestId':request_id,'atEpoch':time.time(),
        'serverPid':state['processes']['server']['pid'],'serverIdentitySha256':hashlib.sha256(state['processes']['server']['identity'].encode()).hexdigest(),
        'obsidianSha256':config['obsidianSha256'],'obsidianAsarSha256':config['obsidianAsarSha256']}
    COMMON.save(run/'private'/('recovery-'+slot+'-binding.json'),binding)
    receipt={'schema':1,'requestId':request_id,'result':'PROVISIONED','slot':slot,'sourceHead':state['source_head'],
        'freshProfile':True,'freshVault':True,'threePluginFilesVerified':True,'copiedPairedState':False,
        'priorDesktopGroupsAbsent':True,'android':absence,'existingServerReused':True,'registeredForOwnedCleanup':True,
        'ordinaryVaultTrustAndRecovery':'REQUIRED','productAcceptance':'NOT_ASSERTED'}
    COMMON.save(run/'evidence'/('recovery-provision-'+slot+'.json'),receipt)
    return receipt
