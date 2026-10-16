"""One complete installed official APK readback; no device discovery or trust actions.

The importing owned controller supplies its already-scoped ADB and private
receipt writer. This module imports neither the controller nor trust setup.
"""
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

APK_READBACK_MAX = 1024**3  # Installer artifact only; no vault/product size limit.

APK_REASONS = frozenset(('apk_package_layout_refused','apk_remote_size_refused','apk_remote_hash_refused',
    'apk_local_file_refused','apk_local_size_refused','apk_readback_deadline','apk_official_pin_refused',
    'apk_private_root_refused','apk_package_path_changed','apk_remote_file_changed','apk_pull_integrity_mismatch',
    'apk_official_pin_mismatch','apk_temporary_cleanup_failed','apk_device_command_timeout',
    'apk_device_command_failed','apk_readback_refused'))
APK_STAGES = frozenset(('validate_owned_private_root','resolve_official_apk','remote_apk_before',
    'pull_official_apk','local_apk_integrity','remote_apk_after','verify_complete_apk_readback','verify_official_apk_pin'))

class ApkReadbackError(ValueError):
    def __init__(self,reason,stage=None):
        self.reason=reason if reason in APK_REASONS else 'apk_readback_refused'
        self.stage=stage if stage in APK_STAGES else None
        super().__init__(self.reason)


def apk_command_failure(error):
    # Only fixed marker classes and counts leave this function, never error text.
    def encoded(value):
        return value if isinstance(value,bytes) else value.encode('utf-8',errors='replace') if isinstance(value,str) else b''
    stdout=encoded(getattr(error,'stdout',None));stderr=encoded(getattr(error,'stderr',None))
    sample=(stderr[:2048]+b'\n'+stdout[:2048]).lower()
    markers=(('permission_denied',(b'permission denied',b'access is denied')),
             ('file_missing',(b'no such file or directory',b'cannot stat',b'failed to stat remote object')),
             ('transport_unavailable',(b'device offline',b'device not found',b'no devices/emulators found',b'error: closed',b'connection reset',b'connection refused',b'broken pipe')),
             ('protocol_error',(b'protocol fault',b'protocol error',b'unexpected id_done',b'msg.data.size too large',b'unexpected response from daemon')),
             ('decompression_error',(b'decompress failed',)),
             ('transfer_read_error',(b'failed to read copy response',)),
             ('no_space',(b'no space left on device',)),
             ('write_error',(b'cannot create',b'cannot write',b'failed to create',b'failed to write')))
    if b'remote object' in sample and b'does not exist' in sample:category='file_missing'
    else:category=next((name for name,needles in markers if any(marker in sample for marker in needles)),'OTHER')
    return {'stdoutBytes':len(stdout),'stderrBytes':len(stderr),'errorClass':category}


def apk_path(state,adb_command,timeout=30):
    rows=adb_command(state,['shell','pm','path','md.obsidian'],timeout=timeout).strip().splitlines()
    if len(rows)!=1 or not re.fullmatch(r'package:/data/app/(?:[A-Za-z0-9._~+=-]+/)?md\.obsidian-[A-Za-z0-9._~+=-]+/base\.apk',rows[0]):
        raise ApkReadbackError('apk_package_layout_refused')
    return rows[0][8:]


def apk_remote_witness(state,path,remaining,adb_command):
    # Modern adb shell carries remote exit status. This is independent of the
    # purpose-built sync-protocol pull, and never outputs the path in evidence.
    size=adb_command(state,['shell','toybox','stat','-c','%s',path],timeout=remaining()).strip()
    if not size.isdecimal() or not 0<int(size)<=APK_READBACK_MAX:
        raise ApkReadbackError('apk_remote_size_refused')
    rows=adb_command(state,['shell','toybox','sha256sum',path],timeout=remaining()).strip().splitlines()
    fields=rows[0].split() if len(rows)==1 else []
    if len(fields)!=2 or not re.fullmatch('[a-f0-9]{64}',fields[0]) or fields[1]!=path:
        raise ApkReadbackError('apk_remote_hash_refused')
    return {'bytes':int(size),'sha256':fields[0]}


def apk_local_witness(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or path.resolve()!=path:
        raise ApkReadbackError('apk_local_file_refused')
    if info.st_size>APK_READBACK_MAX:raise ApkReadbackError('apk_local_size_refused')
    path.chmod(0o600)
    with path.open('rb') as stream:sha256=hashlib.file_digest(stream,'sha256').hexdigest()
    return {'bytes':info.st_size,'sha256':sha256}


def apk_hash(state,run,expected,phase,adb_command,save):
    # Exactly one pull. No raw exec: stream, retry, root, or fallback.
    diagnostic={'schema':1,'sourceHead':state['sourceHead'],'phase':phase,'result':'FAIL',
                'expectedSha256':expected if isinstance(expected,str) and re.fullmatch('[a-f0-9]{64}',expected) else None,
                'method':'owned-adb-pull-and-independent-shell-stat-sha256sum','pullAttempts':0,'pullExitCode':None,
                'before':None,'after':None,'local':None,'temporaryRemoved':False}
    stage='validate_owned_private_root';temporary=None;failure=None;observed=None;started=time.monotonic();deadline=started+30
    diagnostic['deadlineMs']=30000
    def remaining():
        value=deadline-time.monotonic()
        if value<=0:raise ApkReadbackError('apk_readback_deadline')
        return value
    try:
        budget=max(0,min(30,state['expiresAtEpoch']-time.time()));deadline=started+budget;diagnostic['deadlineMs']=round(budget*1000)
        remaining()
        if not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected):raise ApkReadbackError('apk_official_pin_refused')
        root=run/'private';info=root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077 or root.resolve()!=root:
            raise ApkReadbackError('apk_private_root_refused')
        stage='resolve_official_apk';path=apk_path(state,adb_command,timeout=remaining())
        diagnostic['packagePathSha256']=hashlib.sha256(path.encode()).hexdigest()
        stage='remote_apk_before';before=apk_remote_witness(state,path,remaining,adb_command);diagnostic['before']=before
        with tempfile.TemporaryDirectory(prefix='apk-readback-',dir=root) as tmp:
            temporary=Path(tmp);destination=temporary/'base.apk'
            stage='pull_official_apk';diagnostic['pullAttempts']=1
            try:adb_command(state,['pull',path,str(destination)],timeout=remaining())
            except (OSError,subprocess.SubprocessError):
                if destination.exists() and not destination.is_symlink():diagnostic['local']=apk_local_witness(destination)
                raise
            diagnostic['pullExitCode']=0
            stage='local_apk_integrity';local=apk_local_witness(destination);diagnostic['local']=local
            stage='remote_apk_after'
            if apk_path(state,adb_command,timeout=remaining())!=path:raise ApkReadbackError('apk_package_path_changed')
            after=apk_remote_witness(state,path,remaining,adb_command);diagnostic['after']=after
            stage='verify_complete_apk_readback'
            if before!=after:raise ApkReadbackError('apk_remote_file_changed')
            if local!=before:raise ApkReadbackError('apk_pull_integrity_mismatch')
            stage='verify_official_apk_pin'
            if local['sha256']!=expected:raise ApkReadbackError('apk_official_pin_mismatch')
            observed=local['sha256']
        diagnostic['temporaryRemoved']=not temporary.exists()
        if not diagnostic['temporaryRemoved']:raise ApkReadbackError('apk_temporary_cleanup_failed')
        remaining()
        diagnostic.update(result='VERIFIED',sameOfficialApk=True,independentRemoteWitnesses=True)
    except Exception as error:
        reason=str(error) if isinstance(error,ApkReadbackError) else 'apk_device_command_timeout' if isinstance(error,subprocess.TimeoutExpired) else 'apk_device_command_failed' if isinstance(error,(subprocess.SubprocessError,OSError)) else 'apk_readback_refused'
        if isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)):
            diagnostic['commandFailure']=apk_command_failure(error)
        if isinstance(error,subprocess.CalledProcessError):
            diagnostic['commandExitCode']=error.returncode
            if stage=='pull_official_apk':diagnostic['pullExitCode']=error.returncode
        diagnostic.update(reason=reason,stage=stage,temporaryRemoved=temporary is None or not temporary.exists())
        failure=ApkReadbackError(reason,stage)
    diagnostic['elapsedMs']=round((time.monotonic()-started)*1000)
    save(run/'evidence'/('android-apk-readback-'+str(time.time_ns())+'.json'),diagnostic)
    if failure is not None:raise failure
    return observed
