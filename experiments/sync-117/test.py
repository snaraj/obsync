#!/usr/bin/env python3
"""One entry point for the owned native Obsidian lab. No personal vaults."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
HARNESS = ROOT / 'harness/scripts/validation/lab'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('scenario', choices=['desktop', 'stage', 'cotype', 'editor', 'throttle', 'performance', 'up', 'down', 'status'])
parser.add_argument('--source', type=Path, required=True, help='explicit obsync checkout; already built')
parser.add_argument('--run', type=Path, required=True, help='new output directory; existing only for down/status')
parser.add_argument('--notes', type=int, default=7700)
parser.add_argument('--pairs', type=int, choices=[1, 3], default=3)
parser.add_argument('--fixture', type=Path, help='optional caller-owned sentinel directory; default generated fixture is removed')
args = parser.parse_args()
source, run = args.source.resolve(), args.run.resolve()
if not (source / 'AGENTS.md').is_file() or not (source / 'plugin/package.json').is_file():
    parser.error('source is not an obsync checkout')
env = {**os.environ, 'OBSYNC_LAB_SOURCE': str(source)}
if args.scenario == 'performance':
    command = ['performance.py', '--source-repo', str(source), '--run', str(run),
               '--notes', str(args.notes), '--pairs', str(args.pairs)]
    if args.fixture:
        command += ['--fixture', str(args.fixture.resolve())]
else:
    command = ['lab.py', args.scenario, '--source-repo', str(source), '--run', str(run),
               '--binary', str(source / 'target/release/obsyncd'), '--plugin', str(source / 'plugin/dist')]
    if args.scenario == 'throttle':
        command += ['--faults']
    if args.scenario == 'up':
        command += ['--hold']
result = subprocess.run([sys.executable, '-B', str(HARNESS / command[0]), *command[1:]], env=env)
sys.exit(result.returncode)
