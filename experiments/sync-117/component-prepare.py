#!/usr/bin/env python3
"""Freeze built measurement artifacts and a checksum-verified runtime; no network or install."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--source',type=Path,required=True)
p.add_argument('--server',type=Path,required=True,help='measurement server built for the selected platform')
p.add_argument('--node-archive',type=Path,required=True)
p.add_argument('--node-sha256',required=True,help='digest from independently signature-verified official checksums')
p.add_argument('--platform',choices=['darwin-arm64','linux-arm64'],required=True)
p.add_argument('--root',type=Path,required=True,help='absent /tmp/obsync-pi-lab-<16 lowercase hex> on the measurement host')
a=p.parse_args();os.umask(0o077);source=a.source.resolve();root=a.root.resolve();here=Path(__file__).resolve().parent
if root.parent!=Path('/tmp').resolve() or not re.fullmatch('obsync-pi-lab-[a-f0-9]{16}',root.name) or root.exists():
 p.error('fresh exact scratch required')
if not re.fullmatch('[a-f0-9]{64}',a.node_sha256) or hashlib.sha256(a.node_archive.read_bytes()).hexdigest()!=a.node_sha256:
 p.error('runtime archive hash mismatch')
if a.node_archive.name!='node-v26.10.0-'+a.platform+'.tar.gz':p.error('pinned runtime platform mismatch')
files={'obsyncd':a.server.resolve(),'LICENSE':source/'LICENSE','dashboard/index.html':source/'dashboard/index.html','obsyncd.service':source/'deploy/systemd/obsyncd.service'}
for name in ['main.js','manifest.json','styles.css']:files['plugin/'+name]=source/'plugin/dist'/name
for path in list(files.values())+[source/'plugin/build/crypto.js',source/'plugin/build/chunker.js']:
 if path.is_symlink() or not path.is_file() or path.stat().st_size>64*1024**2:p.error('invalid built input')
root.mkdir(mode=0o700);inputs=root/'inputs';inputs.mkdir(mode=0o700)
try:
 for name in ['component-profile.py','component-profile.mjs']:shutil.copy2(here/name,root/name)
 for name in ['crypto.js','chunker.js']:shutil.copy2(source/'plugin/build'/name,inputs/name)
 shutil.copy2(a.node_archive,inputs/'node.tar.gz')
 with tarfile.open(inputs/'server.tar.gz','w:gz') as t:
  for name,path in files.items():
   data=path.read_bytes();item=tarfile.TarInfo(name);item.size=len(data);item.mode=0o700 if name=='obsyncd' else 0o600;t.addfile(item,io.BytesIO(data))
 subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(inputs/'tls.key'),'-out',str(inputs/'tls.crt'),'-days','1','-subj','/CN=obsync-bench.invalid','-addext','subjectAltName=DNS:obsync-bench.invalid'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 head=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
 provenance={'source':head,'sourceDirty':bool(subprocess.check_output(['git','-C',str(source),'status','--porcelain'])),'serverSha256':hashlib.sha256(a.server.read_bytes()).hexdigest(),'runtimeArchiveSha256':a.node_sha256,'platform':a.platform,'cryptoSourceSha256':hashlib.sha256((source/'plugin/src/crypto.ts').read_bytes()).hexdigest(),'scope':'three fresh synthetic component passes; protections enabled'}
 (inputs/'verified.json').write_text(json.dumps({'sha256':{x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in inputs.iterdir()},'provenance':provenance},indent=2)+'\n')
 print(json.dumps({'result':'PREPARED','command':['python3',str(root/'component-profile.py'),'run'],'serverSha256':provenance['serverSha256']}))
except BaseException:
 shutil.rmtree(root);raise
