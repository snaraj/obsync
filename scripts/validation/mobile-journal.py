#!/usr/bin/env python3
"""Bounded full CRC journal equality around fixed fresh-recovery refusals."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import time
import zlib

SPEC=importlib.util.spec_from_file_location('mobile_recovery',Path(__file__).with_name('mobile-recovery.py'))
RECOVERY=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(RECOVERY)
SESSION=RECOVERY.SESSION;COMMON=SESSION.COMMON
MAX_BYTES=64*1024*1024
KINDS={'rotation_prepare','rotation_progress','rotation_commit','rotation_transfer','format_floor','scoped_device',
       'suite2_setup','setup_enrolment','account','device','device_update','device_activate','device_revoke','device_delete','version','seen','gc','scrub'}


def regular(path,private=True):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or path.resolve()!=path or (private and info.st_mode&0o077):
        raise ValueError('owned regular journal artifact required')
    return info


def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('duplicate journal JSON field')
        result[key]=value
    return result


def frames(body):
    offset=0;counts={}
    while offset<len(body):
        if len(body)-offset<8:raise ValueError('partial journal frame header')
        size,crc=struct.unpack_from('<II',body,offset);offset+=8
        if not 0<size<=MAX_BYTES or offset+size>len(body):raise ValueError('partial or oversized journal frame')
        payload=body[offset:offset+size];offset+=size
        if zlib.crc32(payload)&0xffffffff!=crc:raise ValueError('journal CRC mismatch')
        value=json.loads(payload,object_pairs_hook=unique)
        if not isinstance(value,dict) or value.get('t') not in KINDS or type(value.get('s')) is not int or value['s']<0:
            raise ValueError('unknown journal frame envelope')
        kind=value['t'];counts[kind]=counts.get(kind,0)+1
    return counts


def stamp(info):return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)


def read_segments(directory):
    if directory.resolve()!=directory or directory.is_symlink() or not directory.is_dir():
        raise ValueError('exact owned journal directory required')
    paths=sorted(directory.glob('*.log'))
    if not paths or len(paths)>16 or any(not re.fullmatch(r'\d{6}\.log',p.name) for p in paths):
        raise ValueError('bounded numbered journal inventory required')
    entries=[];counts={};total=0;stamps={}
    for path in paths:
        before=regular(path);total+=before.st_size
        if total>MAX_BYTES:raise ValueError('journal byte budget exceeded')
        body=path.read_bytes();after=regular(path)
        if stamp(before)!=stamp(after) or len(body)!=before.st_size:raise ValueError('journal changed during read')
        for kind,count in frames(body).items():counts[kind]=counts.get(kind,0)+count
        entries.append({'segment':path.name,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'inode':after.st_ino})
        stamps[path.name]=stamp(after)
    if counts.get('suite2_setup',0)<1:raise ValueError('initial suite2 account frame required; compacted history unsupported')
    if sorted(p.name for p in directory.glob('*.log'))!=[e['segment'] for e in entries]:raise ValueError('journal inventory changed during read')
    for path in paths:
        if stamp(regular(path))!=stamps[path.name]:raise ValueError('journal changed before snapshot completed')
    return {'segments':entries,'frameCounts':counts,'bytes':total}


def snapshot(run,slot):
    if slot not in ('B','C','D'):raise ValueError('fixed recovery slot required')
    state=SESSION.private_json(run/'lab.json')
    if state.get('format')!=1 or state.get('run')!=str(run) or state.get('source_dirty') is not False or time.time()>=state['expiresAtEpoch']:
        raise ValueError('live clean owned session required')
    if COMMON.identity(state['holder']['pid'])!=state['holder']['identity']:raise ValueError('session holder changed')
    server=state['processes']['server']
    if server['argv']!=[str(run/'runtime/build/obsyncd'),'serve'] or COMMON.identity(server['pid'])!=server['identity']:
        raise ValueError('owned existing server changed')
    for name in ('A','B','C','D'):
        if name!=slot and name in state['processes'] and COMMON.group_members(state['processes'][name]['pid']):
            raise ValueError('all other desktops must be absent')
    binding=SESSION.private_json(run/'private'/('recovery-'+slot+'-binding.json'))
    if binding['sourceHead']!=state['source_head'] or binding['slot']!=slot:raise ValueError('same-candidate fresh recovery binding required')
    source=Path(binding['source'])
    if source.resolve()!=source or subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()!=state['source_head'] or subprocess.check_output(['git','-C',str(source),'status','--porcelain']):
        raise ValueError('original clean source changed')
    RECOVERY.android_absent(binding['androidRun'],state['source_head'],binding['androidOldPid'])
    SESSION.pin(run/'runtime/build/obsyncd',state['artifacts']['obsyncd'])
    value=read_segments(run/'runtime/server/journal/v1/journal')
    return value|{'sourceHead':state['source_head'],'serverIdentitySha256':hashlib.sha256(server['identity'].encode()).hexdigest(),
                  'serverArtifactSha256':state['artifacts']['obsyncd']}


def compare(run,slot,case,action):
    if case not in ('old-backup','wrong-token','unrelated-backup') or action not in ('before','after'):
        raise ValueError('fixed recovery refusal comparison required')
    current=snapshot(run,slot)
    baseline=run/'private'/('recovery-journal-'+slot+'-'+case+'-before.json')
    if action=='before':
        if baseline.exists() or baseline.is_symlink():raise ValueError('fresh journal baseline required')
        COMMON.save(baseline,current)
        return {'result':'BASELINE_CAPTURED','slot':slot,'case':case,'crcVerifiedFrames':sum(current['frameCounts'].values()),'journalBytes':current['bytes']}
    before=SESSION.private_json(baseline)
    unchanged=before==current
    receipt={'result':'PASS' if unchanged else 'UNKNOWN','sourceHead':current['sourceHead'],'slot':slot,'case':case,
        'entireVerifiedJournalUnchanged':unchanged,'durableAccountStateUnchanged':unchanged,
        'crcVerifiedFrames':sum(current['frameCounts'].values()),'journalBytes':current['bytes'],
        'allOtherPairedAppsAbsent':True,'scope':'Entire durable journal; volatile in-memory rate counters excluded'}
    COMMON.save(run/'evidence'/('recovery-journal-'+slot+'-'+case+'-'+str(time.time_ns())+'.json'),receipt)
    if not unchanged:raise RuntimeError('journal/source/server changed; account unchanged UNKNOWN')
    return receipt


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=('before','after'));p.add_argument('--run',type=lambda s:Path(s).expanduser().absolute(),required=True)
    p.add_argument('--slot',choices=('B','C','D'),required=True);p.add_argument('--case',choices=('old-backup','wrong-token','unrelated-backup'),required=True)
    a=p.parse_args();print(json.dumps(compare(a.run,a.slot,a.case,a.action)))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'result':'UNKNOWN','exceptionType':type(error).__name__,
              'detail':COMMON.sanitized_diagnostic(str(error))[:400]}),file=sys.stderr);sys.exit(1)
