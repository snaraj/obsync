#!/usr/bin/env python3
"""Discard resolved lab secrets and fixtures after independent process absence proof."""
import argparse
import json
from pathlib import Path
import shutil
import time
from lab import external, load, group_alive, identity, save


def finalize(run):
    run = external(run)
    receipt = run / 'evidence/teardown.json'
    state = load(run)
    done = json.loads(receipt.read_text())
    if not state.get('stopped') or done.get('process_groups_remaining') != 0 or done.get('runtime_exists') is not False:
        raise RuntimeError('successful teardown required before discarding diagnostic fixtures')
    if (run/'runtime').exists() or (run/'runtime').is_symlink():
        raise RuntimeError('runtime still present')
    if any(group_alive(x['pid']) for x in state['processes'].values()):
        raise RuntimeError('recorded group is present; inspect before removing its fixture')
    holder = state.get('holder')
    if holder and identity(holder['pid']) is not None:
        raise RuntimeError('recorded holder PID is present; inspect before cleanup')
    private = run/'private'
    if private.is_symlink():
        raise RuntimeError('private directory became a symlink')
    # Preserve only already reduced evidence. Never parse or publish secret-bearing logs.
    removed = sum(p.stat().st_size for p in private.rglob('*') if p.is_file() and not p.is_symlink()) if private.exists() else 0
    if private.exists():
        shutil.rmtree(private)
    (run/'lab.json').unlink()
    result = {'result':'PASS','privateAbsent':not private.exists(),'runtimeAbsent':not (run/'runtime').exists(),
              'manifestAbsent':not (run/'lab.json').exists(),'privateBytesRemoved':removed,
              'retained':['sanitized evidence and screenshots'],'observedAtEpoch':int(time.time())}
    save(run/'evidence/final-cleanup.json',result)
    print(json.dumps(result))

if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('run',type=Path);a=p.parse_args();finalize(a.run)
