#!/usr/bin/env python3
"""Bounded software metadata for the two explicitly owned native peers."""
import argparse
import importlib.util
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import time

SPEC=importlib.util.spec_from_file_location('mobile_session',Path(__file__).with_name('mobile-session.py'))
SESSION=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(SESSION)
ANDROID=SESSION.COMMON
PROPERTIES=('ro.build.version.release','ro.build.version.sdk','ro.build.version.security_patch',
            'ro.product.cpu.abi','ro.build.type','ro.debuggable')


def scalar(value):
    value=value.strip()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 ._+()/-]{0,100}',value):raise ValueError('bounded software metadata required')
    return value


def package_metadata(text):
    if len(text)>2*1024*1024 or not re.search(r'Package \[md\.obsidian\]',text):raise ValueError('fixed Obsidian package metadata absent')
    codes=re.findall(r'^\s*versionCode=(\d+)\b',text,re.M)
    names=re.findall(r'^\s*versionName=(\S+)\s*$',text,re.M)
    if len(codes)!=1 or len(names)!=1:raise ValueError('unambiguous Obsidian version required')
    return {'package':'md.obsidian','versionName':scalar(names[0]),'versionCode':int(codes[0])}


def webview_metadata(text):
    if len(text)>2*1024*1024:raise ValueError('bounded WebView metadata required')
    rows=re.findall(r'^\s*Current WebView package \(name, version\): \(([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+), ([^()\r\n]+)\)\s*$',text,re.M)
    if len(rows)!=1:raise ValueError('one active WebView provider/version required')
    return {'package':rows[0][0],'versionName':scalar(rows[0][1])}


def host_value(*args):
    return scalar(subprocess.check_output(list(args),text=True,stderr=subprocess.PIPE,timeout=10))


def desktop_binding(run):
    state=SESSION.private_json(run/'lab.json');ready=SESSION.private_json(run/'evidence/peer-ready.json')
    if (state.get('format')!=1 or state.get('run')!=str(run) or state.get('stopped') or
        state.get('source_dirty') is not False or not re.fullmatch('[a-f0-9]{40}',state.get('source_head','')) or
        time.time()>=state['expiresAtEpoch'] or ready.get('sourceHead')!=state['source_head'] or ready.get('artifacts')!=state['artifacts']):
        raise ValueError('live clean same-candidate desktop binding required')
    if set(state['artifacts'])!={'obsyncd','plugin/main.js','plugin/manifest.json','plugin/styles.css'} or state['processes']['server'].get('argv')!=[str(run/'runtime/build/obsyncd'),'serve']:
        raise ValueError('complete candidate artifacts and owned server required')
    slots=[slot for slot in ('A','B','C') if slot in state['processes']]
    if len(slots)!=1:raise ValueError('one current owned desktop required')
    slot=slots[0];app=state['processes'][slot];device=state['devices'][slot]
    if (device.get('vault')!=str(run/'runtime'/slot/('Lab-'+slot)) or device.get('userdata')!=str(run/'runtime'/slot/'userdata') or
        len(app.get('argv',[]))!=4 or not app['argv'][0].endswith('/Obsidian.app/Contents/MacOS/Obsidian') or
        app['argv'][1:]!=['--user-data-dir='+device['userdata'],'--remote-debugging-port='+str(device['port']),'--remote-debugging-address=127.0.0.1']):
        raise ValueError('fixed owned desktop application required')
    for record in (state['holder'],state['processes']['server'],app):
        if ANDROID.identity(record['pid'])!=record['identity'] or ('argv' in record and not record['identity'].endswith(' '.join(record['argv']))):raise ValueError('owned desktop process identity changed')
    executable=Path(app['argv'][0]);contents=executable.parent.parent
    SESSION.pin(executable,ready['obsidianExecutableSha256']);SESSION.pin(contents/'Resources/app.asar',ready['obsidianAsarSha256'])
    info=ANDROID.checked_file(contents/'Info.plist')
    metadata=plistlib.loads(info.read_bytes())
    version=scalar(metadata['CFBundleShortVersionString'])
    for name,expected in state['artifacts'].items():
        if name not in ('obsyncd','plugin/main.js','plugin/manifest.json','plugin/styles.css'):raise ValueError('unexpected candidate artifact')
        SESSION.pin(run/'runtime/build'/name,expected)
        if name.startswith('plugin/'):SESSION.pin(Path(device['vault'])/'.obsidian/plugins/obsync-private-sync'/name[7:],expected)
    return state,{'slot':slot,'versionName':version,'executableSha256':ready['obsidianExecutableSha256'],
        'appAsarSha256':ready['obsidianAsarSha256'],'infoPlistSha256':ANDROID.digest(info),
        'publisherAuthenticity':'CALLER_ACQUISITION_PROOF_REQUIRED','peerReadyReceiptSha256':ANDROID.digest(run/'evidence/peer-ready.json')}


def collect(desktop_run,android_run,acquisition=None,acquisition_hash=None):
    if desktop_run.resolve()!=desktop_run or android_run.resolve()!=android_run:raise ValueError('exact real owned run paths required')
    state,desktop=desktop_binding(desktop_run);android=ANDROID.live_state(android_run)
    ready=SESSION.private_json(android_run/'evidence/android-ready.json');assets=SESSION.private_json(android_run/'evidence/assets.json')
    if (android['sourceHead']!=state['source_head'] or ready.get('sourceHead')!=state['source_head'] or
        ready.get('installedApkVerified') is not True or ready.get('apkSha256')!=assets.get('apkSha256')):
        raise ValueError('same-candidate verified official Android installation required')
    app_pid=ANDROID.app_pid(android)
    if app_pid is None:raise ValueError('owned native Android app must be running for metadata receipt')
    package=package_metadata(ANDROID.adb_command(android,['shell','dumpsys','package','md.obsidian'],timeout=15))
    webview=webview_metadata(ANDROID.adb_command(android,['shell','dumpsys','webviewupdate'],timeout=15))
    facts={name:scalar(ANDROID.adb_command(android,['shell','getprop',name],timeout=10)) for name in PROPERTIES}
    if any(ready['facts'].get(name)!=facts[name] for name in PROPERTIES[:4]):raise ValueError('verified guest OS metadata changed')
    if ANDROID.app_pid(android)!=app_pid:raise ValueError('Android application restarted during metadata collection')
    acquired={'result':'UNKNOWN','reason':'No caller-pinned official Mac acquisition receipt supplied'}
    if acquisition is not None:
        if not acquisition_hash:raise ValueError('explicit Mac acquisition receipt pin required')
        SESSION.private_json(acquisition);SESSION.pin(acquisition,acquisition_hash)
        acquired={'result':'PINNED_RECEIPT','sha256':acquisition_hash,'publisherAuthenticity':'CALLER_ATTESTATION_NOT_INDEPENDENTLY_VERIFIED'}
    elif acquisition_hash is not None:raise ValueError('Mac acquisition receipt path required with pin')
    trusted=android_run/'evidence/android-trust-current.json'
    trust={'installed':False,'syntheticCaUse':'NOT_OBSERVED'}
    if trusted.exists():
        receipt=SESSION.private_json(trusted)
        if receipt.get('sourceHead')!=state['source_head']:raise ValueError('same-candidate synthetic CA receipt required')
        trust={'installed':True,'syntheticCaUse':'DISPOSABLE_GUEST_SYSTEM_CA_NAMESPACE_UNION','receiptSha256':ANDROID.digest(trusted)}
    value={'schema':1,'result':'OBSERVED','sourceHead':state['source_head'],'atEpoch':time.time(),
        'candidateArtifacts':state['artifacts'],'desktop':desktop,'macAcquisition':acquired,
        'host':{'productName':host_value('sw_vers','-productName'),'productVersion':host_value('sw_vers','-productVersion'),
                'buildVersion':host_value('sw_vers','-buildVersion'),'kernel':host_value('uname','-s'),'architecture':host_value('uname','-m')},
        'android':package|{'appPid':app_pid,'activeWebView':webview,'os':facts,'apkSha256':ready['apkSha256'],
            'officialApkUrl':assets['apkUrl'],'assetsReceiptSha256':ANDROID.digest(android_run/'evidence/assets.json'),
            'installedApkReadbackReceiptSha256':ANDROID.digest(android_run/'evidence/android-ready.json'),'syntheticTrust':trust},
        'physicalPhone':'USB_DEVICE_OBSERVED' if android.get('targetKind')=='usb' else 'NOT_RUN','hardwareBackedCustody':'NOT_MEASURED','osEncryptedBackingStore':'NOT_MEASURED',
        'limitations':['USB software metadata only; no fresh physical environment claim' if android.get('targetKind')=='usb' else 'Disposable Android emulator; no physical-phone acceptance',
            'USB requires stock app trust; no root/system-CA mutation by this adapter' if android.get('targetKind')=='usb' else 'Userdebug/root-capable guest and synthetic CA differ from a stock personal device',
            'Native SecretStorage API persistence does not independently establish hardware backing or OS encryption'],
        'productAcceptance':'NOT_ASSERTED'}
    path=desktop_run/'evidence/mobile-platform.json'
    if path.exists() or path.is_symlink():raise ValueError('fresh platform evidence path required')
    ANDROID.save(path,value)
    return value


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--desktop-run',type=Path,required=True);p.add_argument('--android-run',type=Path,required=True)
    p.add_argument('--mac-acquisition',type=Path);p.add_argument('--mac-acquisition-sha256')
    a=p.parse_args();print(json.dumps(collect(a.desktop_run.absolute(),a.android_run.absolute(),a.mac_acquisition,a.mac_acquisition_sha256)))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'result':'FAIL','exceptionType':type(error).__name__,
              'detail':ANDROID.sanitized_diagnostic(str(error))[:300],'physicalPhone':'NOT_RUN',
              'hardwareBackedCustody':'NOT_MEASURED'}),file=sys.stderr);sys.exit(1)
