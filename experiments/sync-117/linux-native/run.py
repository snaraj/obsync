#!/usr/bin/env python3
"""Fresh Linux Obsidian profiles with encrypted GNOME custody and native restart."""
from pathlib import Path
import argparse
import json
import os
import select
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def profile_environment(home, password, inherited):
    env = {key: value for key, value in inherited.items()
           if not key.startswith(('DBUS_', 'GNOME_KEYRING_')) and
           key not in ('OBSYNC_E2E_SESSION_BUS', 'XDG_RUNTIME_DIR')}
    env.update(HOME=str(home), OBSYNC_E2E_KEYRING_PASSWORD=str(password),
               XDG_DATA_HOME=str(home / '.local/share'), XDG_CONFIG_HOME=str(home / '.config'),
               XDG_CACHE_HOME=str(home / '.cache'), XDG_STATE_HOME=str(home / '.local/state'))
    return env


def session():
    profiles = [a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--user-data-dir=')]
    assert len(profiles) == 1
    profile = Path(profiles[0])
    root = Path(os.environ['OBSYNC_LINUX_RUN']) / 'runtime'
    assert profile in [root / 'A/userdata', root / 'B/userdata'] and profile.is_dir()
    os.umask(0o077)
    home = profile / 'home'
    home.mkdir(exist_ok=True)
    password = home / '.task-keyring-password'
    if not password.exists():
        password.write_bytes(os.urandom(32).hex().encode())
    env = profile_environment(home, password, os.environ)
    # Keep this owned parent stable while the repository session wrapper execs.
    return subprocess.call([str(Path(env['OBSYNC_LAB_SOURCE']) / 'scripts/ci/obsidian-session.sh'),
                            env['OBSYNC_LINUX_APP'], '--disable-gpu', *sys.argv[1:]], env=env)


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source', 'harness', 'run', 'binary', 'plugin', 'obsidian']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--cotype', action='store_true')
    args = parser.parse_args()
    assert sys.platform == 'linux' and os.getuid() != 0
    for name in ['source', 'harness', 'run', 'binary', 'plugin', 'obsidian']:
        setattr(args, name, getattr(args, name).resolve())
    assert not args.run.exists(), 'fresh external run required'
    os.umask(0o077)
    os.environ.update(OBSYNC_LAB_SOURCE=str(args.source), OBSYNC_LINUX_HARNESS=str(args.harness),
                      OBSYNC_LINUX_RUN=str(args.run), OBSYNC_LINUX_APP=str(args.obsidian))
    sys.path.insert(0, str(args.harness))
    import lab
    from finalize import finalize
    lab.external(args.run)  # Keep every generated profile outside the repository.
    command = [sys.executable, '-B', str(args.harness / 'lab.py'), 'up', '--source-repo', str(args.source),
               '--run', str(args.run), '--binary', str(args.binary), '--plugin', str(args.plugin),
               '--obsidian', str(Path(__file__).resolve()), '--hold']
    holder = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    passed = False

    def node(script, *values):
        subprocess.run(['node', str(script), str(args.run), *values], check=True, timeout=240)

    try:
        assert select.select([holder.stdout], [], [], 90)[0], 'launcher readiness deadline'
        assert json.loads(holder.stdout.readline())['ready']
        for step in ['init', 'setup-first', 'pair']:
            node(args.harness / 'journeys.mjs', step)
        node(HERE / 'custody.mjs', 'before')
        if args.cotype:
            node(args.harness / 'cotype.mjs')
        for step in ['notes', 'sweep']:
            node(args.harness / 'journeys.mjs', step)
        node(HERE / 'restart.mjs')
        node(HERE / 'custody.mjs', 'after')
        node(args.harness / 'journeys.mjs', 'notes')
        passed = True
    finally:
        # The actual parent must reap its holder; a separate down subprocess
        # cannot reap it and can mistake the unreaped zombie for identity drift.
        try:
            if (args.run / 'lab.json').exists():
                lab.down(args.run)
            else:
                holder.terminate()
        finally:
            holder.wait(timeout=15)
        if (args.run / 'lab.json').exists():
            finalize(args.run)
        (args.run / 'evidence/linux-workflow.json').write_text(json.dumps({
            'result': 'PASS' if passed else 'FAIL', 'cotype': args.cotype,
            'runtimeAbsent': not (args.run / 'runtime').exists(),
            'privateAbsent': not (args.run / 'private').exists(),
            'manifestAbsent': not (args.run / 'lab.json').exists()}, indent=2) + '\n')


if __name__ == '__main__':
    if any(a.startswith('--user-data-dir=') for a in sys.argv[1:]):
        raise SystemExit(session())
    run()
