#!/usr/bin/env python3
"""Correlate one real WebView certificate refusal with owned, bounded native logs.

The original generic CDP receipt is never rewritten. Native messages are reduced
to timestamps/PIDs/error codes; raw application logs are never persisted.
"""
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import re
import sys
import time

SPEC=importlib.util.spec_from_file_location('android_session',Path(__file__).with_name('android-session.py'))
SESSION=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(SESSION)


def epoch(value):
    if not isinstance(value,str) or not value.endswith('Z'):raise ValueError('explicit UTC probe interval required')
    return datetime.datetime.fromisoformat(value[:-1]+'+00:00').timestamp()


def correlated(log,pid,start,end,case):
    matches=[];anchors=[];codes=[]
    for line in log.splitlines():
        row=re.match(r'^\s*(\d+\.\d+)\s+(\d+)\s+\d+\s+[VDIWEF]\s+([^:]+):\s*(.*)$',line)
        if not row or int(row[2])!=pid or not start-1<=float(row[1])<=end+1:continue
        at=float(row[1]);message=row[4]
        if 'Trust anchor for certification path not found' in message:anchors.append(at)
        code=re.search(r'net_error\s+(-\d+)\b',message)
        if 'ssl_client_socket_impl' in message and code:
            codes.append(int(code[1]));matches.append({'atEpoch':at,'pid':pid,'netError':int(code[1])})
    expected=-202 if case=='untrusted' else -200
    if not matches or any(code!=expected for code in codes):raise ValueError('expected isolated native certificate refusal absent or ambiguous')
    if case=='untrusted' and not anchors:raise ValueError('native trust-anchor rejection absent')
    return {'nativeTlsErrors':matches,'trustAnchorMissingAtEpoch':anchors,'expectedNetError':expected,
            'correlationWindowSeconds':{'before':1,'after':1}}


def strict_host_proof(host):
    legacy=host.get('trustedHostReadinessStatus')==200 and host.get('hostWrongHostnameRejected') is True
    modern=host.get('validHostnameAccepted') is True and host.get('wrongHostnameRejected') is True and isinstance(host.get('leafSha256'),str) and re.fullmatch('[a-f0-9]{64}',host['leafSha256'])
    trust=host.get('trustBasis')=='SYSTEM_DEFAULT' or isinstance(host.get('caSha256'),str) and re.fullmatch('[a-f0-9]{64}',host['caSha256'])
    return host.get('result')=='PASS' and bool(legacy or modern and trust)


def proof(run,probe_path,host_path,host_hash,trusted_path=None):
    run=run.resolve();state=SESSION.live_state(run)
    probe_path=probe_path.absolute();host_path=host_path.absolute()
    if probe_path.parent!=run/'evidence' or probe_path.resolve()!=probe_path:raise ValueError('same-run real probe receipt required')
    probe=json.loads(SESSION.checked_file(probe_path).read_text())
    if SESSION.digest(host_path)!=host_hash:raise ValueError('pinned host TLS receipt mismatch')
    host=json.loads(SESSION.checked_file(host_path).read_text())
    if not strict_host_proof(host):
        raise ValueError('strict host TLS positive and hostname controls required')
    case=probe.get('case');pid=probe.get('appPid')
    if (case not in ('untrusted','wrong-host') or type(pid) is not int or pid<=1 or
        probe.get('sourceHead')!=state['sourceHead'] or probe.get('webViewFetchResolved') is not False or
        probe.get('tlsVerificationDisabled') is not False or probe.get('result') not in ('FAIL','PASS')):
        raise ValueError('actual same-candidate WebView refusal required')
    start=epoch(probe.get('probeStartedAt'));end=epoch(probe.get('probeEndedAt'))
    if not 0<=end-start<=15 or not 0<=time.time()-end<=120:raise ValueError('recent bounded probe interval required')
    refs=[{'role':'originalWebViewProbe','sha256':SESSION.digest(probe_path)}, {'role':'strictHostTls','sha256':host_hash}]
    if case=='wrong-host':
        if trusted_path is None or trusted_path.absolute().parent!=run/'evidence':raise ValueError('same-run prior trusted WebView success required')
        trusted=json.loads(SESSION.checked_file(trusted_path).read_text())
        if (trusted.get('result')!='PASS' or trusted.get('sourceHead')!=state['sourceHead'] or trusted.get('appPid')!=pid or
            trusted.get('webViewFetchResolved') is not True or trusted.get('status')!=200 or trusted.get('tlsVerificationDisabled') is not False):
            raise ValueError('same-process trusted WebView success required')
        refs.append({'role':'trustedWebViewProbe','sha256':SESSION.digest(trusted_path)})
    if SESSION.app_pid(state)!=pid:raise ValueError('probe application PID changed before log read')
    # Time bounds check guest/host agreement instead of interpreting local time.
    before=time.time();device_epoch=int(SESSION.adb_command(state,['shell','date','+%s']).strip());after=time.time()
    if not before-2<=device_epoch<=after+2:raise ValueError('guest clock cannot correlate host probe interval')
    log=SESSION.adb_command(state,['logcat','--pid',str(pid),'-d','-v','epoch','-t','2000'])
    if SESSION.app_pid(state)!=pid:raise ValueError('probe application PID changed during log read')
    evidence=correlated(log,pid,start,end,case)
    receipt={'schema':1,'result':'PASS','sourceHead':state['sourceHead'],'case':case,'appPid':pid,
        'actualWebViewFetchRejected':True,'sameProbeTimestampCorrelated':True,'originalGenericReceiptPreserved':True,
        'nativeLogScope':'exact live app PID and bounded UTC interval; sanitized certificate fields only',
        'physicalPhone':'USB_DIAGNOSTIC' if state.get('targetKind')=='usb' else 'NOT_RUN','supportingReceipts':refs}|evidence
    receipt['untrustedRejected' if case=='untrusted' else 'wrongHostnameRejected']=True
    path=run/'evidence'/('android-'+case+'-certificate-proof-'+str(time.time_ns())+'.json')
    SESSION.save(path,receipt)
    return {'receipt':str(path),'result':'PASS','case':case}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ('run','probe','host-proof'):p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--host-proof-sha256',required=True);p.add_argument('--trusted-probe',type=Path)
    a=p.parse_args();print(json.dumps(proof(a.run,a.probe,a.host_proof,a.host_proof_sha256,a.trusted_probe)))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'result':'UNKNOWN','exceptionType':type(error).__name__,
              'detail':SESSION.sanitized_diagnostic(str(error))[:300]}),file=sys.stderr);sys.exit(1)
