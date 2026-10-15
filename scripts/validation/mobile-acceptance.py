#!/usr/bin/env python3
"""One command for fresh owned mobile fixtures. Full acceptance fails closed."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
FULL_JOURNEYS = ('restart', 'background-offline', 'access-repair', 'rotation-recovery',
                 'selected-rename', 'fresh-recovery-J11', 'native-confidentiality')
IMPLEMENTED_FULL_JOURNEYS = FULL_JOURNEYS
FULL_NATIVE_PHASES = ('quiet', 'restart', 'background-offline', 'access-repair', 'rotation-recovery', 'selected-rename', 'fresh-recovery-J11')
# Structural admission of facts emitted only after the native journey checks.
# access-repair deliberately records a deferred cipher assertion; rotation's
# detachedNativeCipherOracle is the later completed assertion, not this marker.
FULL_PHASE_FACTS = {
    'quiet': {'androidCallsDuringInterval': 0, 'historiesAndHeadsUnchanged': True},
    'restart': dict.fromkeys(('processRestart', 'guestReboot', 'persistedEnrollment',
        'activeDesktopNormalQuitRestart', 'noSetupPairingOrSyncNowAction', 'preexistingIndependentBytes'), True) | {'physicalDeviceReboot': 'NOT_RUN'},
    'background-offline': {'privateRouteRemovedAndRestored': True, 'pendingNotesBothDirections': True,
        'existingTlsSocketsGracefullyDrained': True, 'tlsGateResumed': True,
        'faultClass': 'OWNED_ANDROID_ROUTE_OFFLINE', 'certificateValidation': 'NOT_TESTED_BY_ROUTE_GATE'},
    'access-repair': dict.fromkeys(('revokedTransportRefused', 'ordinaryLeavePreservedBytes', 'freshIndependentSas'), True) |
        {'oldRootDirectCipherPositive': 'REQUIRED_ORACLE_AFTER_ROTATION'},
    'rotation-recovery': dict.fromkeys(('wholeJournalUnchangedAcrossBothRestarts', 'preparedRestart', 'commitUnknownRestart', 'normalQuitRequired', 'retainedHistory',
        'detachedNativeCipherOracle', 'postrotationPhoneRestart', 'preexistingIndependentBytesAfterRotationRestart',
        'knownRetainedHistoryBytes', 'currentOriginalUnchanged'), True) | {'previousGenerationHistoryUi': 'RESTORE_COPY'},
    'selected-rename': dict.fromkeys(('ordinaryDesktopRename', 'ordinaryAndroidRename', 'noteIdentityAndBytesPreserved',
        'priorHistoryAndAncestryPreserved', 'postConvergenceHeadsAndVersionsFrozen', 'excludedControlsCreatedAfterScope', 'trashEmpty'), True),
    'fresh-recovery-J11': dict.fromkeys(('pairedPeersStopped', 'freshDesktopB', 'freshDesktopC', 'oldBackupRefused',
        'freshDesktopD', 'validUnrelatedBackupRefused', 'unrelatedBackupJournalUnchanged', 'wrongTokenJournalUnchanged', 'completeNewBackupRecovery'), True),
}
FULL_PHASE_BOUNDS = {
    'quiet': {'elapsedMs': (213000, 14400000)},
    'restart': {'desktopLaunchToIdleMs': (0, 120000), 'androidLaunchToIdleMs': (0, 120000)},
    'rotation-recovery': {'postrotationLaunchToIdleMs': (0, 120000)},
    'selected-rename': {'desktopOriginWatchMs': (300000, 14400000), 'androidOriginWatchMs': (300000, 14400000)},
}
CORE_HELPERS = ('mobile-acceptance.py', 'mobile-session.py', 'android-session.py', 'android-trust.py', 'android-apk.py',
                'android-usb.py', 'mobile-trusted-tls.py', 'mobile-platform.py',
                'android-tls-proof.py', 'android-journey.mjs', 'mobile-evidence.py', 'mobile-tls.mjs',
                'mobile/setup.mjs', 'mobile/desktop.mjs', 'mobile/desktop-guard.mjs', 'mobile/cdp.mjs')
FULL_HELPERS = ('mobile-full.py', 'mobile-platform.py', 'mobile-recovery.py', 'mobile-journal.py',
                'mobile/native-checkpoint.mjs', 'mobile/native-readiness.mjs', 'mobile/selected-fixtures.mjs', 'mobile/selected-desktop.mjs',
                'mobile/native-ciphertext-capture.mjs', 'mobile/ciphertext-retention.mjs', 'mobile/ciphertext-oracle.mjs', 'mobile/known-notes-proof.mjs',
                'mobile/recovery.mjs', 'mobile/recovery-guard.mjs', 'mobile/native-confidentiality-scan.mjs')


class StageFailure(RuntimeError):
    def __init__(self, stage, failure_class='UNCLASSIFIED'):
        super().__init__(stage)
        self.stage = stage
        self.failure_class = failure_class


def require(value, stage, failure_class='UNCLASSIFIED'):
    if not value:
        raise StageFailure(stage, failure_class)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_json(path):
    info = path.lstat()
    require(path.resolve() == path.absolute() and path.is_file() and not path.is_symlink()
            and info.st_uid == os.getuid() and info.st_nlink == 1 and not info.st_mode & 0o077
            and info.st_size <= 1048576, 'private_input_custody')
    return json.loads(path.read_text())


def save(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    path.chmod(0o600)


def helper(name):
    path = HERE / name
    require(path.is_file() and path.resolve() == path.absolute() and not path.is_symlink(), 'missing_helper_' + Path(name).name, 'AUTOMATION_FAILURE')
    return str(path)


def driver_inventory(mode, source):
    files = {name: Path(helper(name)) for name in CORE_HELPERS + (FULL_HELPERS if mode == 'full' else ())}
    for name in ('obsidian-drive.mjs', 'obsidian-evidence.mjs', 'obsidian-redirect.mjs'):
        files['../ci/' + name] = HERE.parent / 'ci' / name
    files['candidate/observer.mjs'] = Path(source) / 'scripts/ci/observer.mjs'
    if mode == 'full': files['candidate/e2ee.mjs'] = Path(source) / 'scripts/ci/e2ee.mjs'
    result = {}
    for name, path in files.items():
        require(path.is_file() and not path.is_symlink() and path.resolve() == path.absolute(), 'driver_file_custody', 'AUTOMATION_FAILURE')
        result[name] = sha(path)
        if mode == 'full' and not name.startswith('candidate/'):
            root = HERE.parent.parent
            try:
                committed = subprocess.check_output(['git', '-C', str(root), 'show', 'HEAD:' + str(path.relative_to(root))], stderr=subprocess.PIPE)
            except subprocess.CalledProcessError:
                raise StageFailure('driver_not_committed', 'AUTOMATION_FAILURE') from None
            require(hashlib.sha256(committed).hexdigest() == result[name], 'driver_not_committed', 'AUTOMATION_FAILURE')
    return result


def recheck_drivers(mode, source, expected):
    require(driver_inventory(mode, source) == expected, 'driver_changed', 'AUTOMATION_FAILURE')


def full_journey_receipt(run, source_head):
    proof = private_json(run / 'evidence/full-native-journeys.json')
    require(proof.get('schema') == 1 and proof.get('result') == 'PASS' and proof.get('sourceHead') == source_head
            and proof.get('journeys') == list(FULL_NATIVE_PHASES), 'full_native_journey_receipt')
    for phase in FULL_NATIVE_PHASES:
        receipt = private_json(run / 'evidence' / ('full-' + phase + '.json'))
        require(type(receipt.get('schema')) is int and receipt['schema'] == 1 and receipt.get('result') == 'PASS'
                and receipt.get('sourceHead') == source_head, 'full_phase_' + phase)
        require(all(type(receipt.get(key)) is type(value) and receipt[key] == value for key, value in FULL_PHASE_FACTS[phase].items()),
                'full_phase_facts_' + phase)
        require(all(type(receipt.get(key)) is int and low <= receipt[key] <= high for key, (low, high) in FULL_PHASE_BOUNDS.get(phase, {}).items()),
                'full_phase_bounds_' + phase)
    return proof


def load_controller():
    spec = importlib.util.spec_from_file_location('owned_android_session', helper('android-session.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def final_json(data):
    values = []
    for line in data.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                values.append(value)
        except ValueError:
            pass
    require(values, 'missing_child_json')
    return values[-1]


def run_bounded(argv, log, seconds):
    common = load_controller()
    owner = common.Owned(Path(log.name).parent.parent, {'processes': {}})
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    owner.children['step'] = child  # custody precedes every fallible observation
    deadline = time.monotonic() + seconds
    code = None
    try:
        while time.monotonic() < deadline:
            code = common.exit_code(child)  # WNOWAIT reserves the original PGID
            if code is not None: break
            time.sleep(.05)
    finally:
        owner.stop()  # signal/verify the whole retained group, then final wait
    require(code is not None, 'helper_timeout')
    return code


class Steps:
    def __init__(self, attempt, source_head):
        self.attempt, self.head, self.number = attempt, source_head, 0

    def run(self, stage, argv, results=('PASS',), timeout=120, negative=False):
        self.number += 1
        path = self.attempt / 'private' / f'{self.number:03d}-{stage}.log'
        started = time.time()
        proof, code, accepted, helper_failure, failure_class = {}, None, False, None, 'UNCLASSIFIED'
        try:
            with path.open('xb') as log:
                path.chmod(0o600)
                code = run_bounded(argv, log, timeout)
            proof = final_json(path.read_text(errors='replace'))
            child_class = proof.get('failureClass')
            failure_class = child_class if isinstance(child_class, str) and re.fullmatch('[A-Z_]{1,64}', child_class) else 'UNCLASSIFIED'
            accepted = ((code == 0 or negative and code == 1) and proof.get('result') in results
                        and proof.get('sourceHead', self.head) == self.head)
        except (OSError, subprocess.SubprocessError, StageFailure) as error:
            helper_failure = error.stage if isinstance(error, StageFailure) else type(error).__name__
            failure_class = error.failure_class if isinstance(error, StageFailure) else 'AUTOMATION_FAILURE' if isinstance(error, FileNotFoundError) else 'UNCLASSIFIED'
        save(self.attempt / 'evidence' / f'{self.number:03d}-{stage}.json', {
            'schema': 1, 'sourceHead': self.head, 'stage': stage,
            'result': ('OBSERVED' if negative else 'PASS') if accepted else 'FAIL', 'childResult': proof.get('result'),
            'exitCode': code, 'durationMs': round((time.time() - started) * 1000),
            'childLogSha256': sha(path), 'negativeDiagnostic': negative, 'helperFailure': helper_failure,
            'childFailureClass': proof.get('failureClass'), **({'failureClass': failure_class} if not accepted else {})})
        require(accepted, stage, failure_class)
        return proof


def clean_controller(receipt):
    return (receipt.get('cleanup') == 'PASS' and receipt.get('ownedGroupsRemaining') == 0
            and receipt.get('runtimeAbsent') is True and receipt.get('privateAbsent') is True
            and receipt.get('manifestAbsent') is True)


def require_android_controller(proof, returncode, source_head):
    require(proof.get('sourceHead') == source_head, 'android_controller_source')
    if returncode != 0 or proof.get('result') != 'PASS':
        failure = proof.get('failure')
        stage = failure.get('stage') if isinstance(failure, dict) else None
        # Copy only the controller's closed stage vocabulary, never diagnostics.
        raise StageFailure('android_controller_' + (stage if stage in ('boot', 'install', 'journey') else 'terminal'))
    require(clean_controller(proof), 'android_controller_cleanup')


def attempt_cleanup(peer, android):
    if not clean_controller(peer): return 'FAIL'
    if android.exists():
        receipt = android / 'evidence/result.json'
        if not receipt.exists(): return 'UNKNOWN'
        if not clean_controller(private_json(receipt)): return 'FAIL'
    return 'PASS'


def target_scope(c,mode,runs):
    a=c['android'];kind=a.get('targetKind','emulator')
    require(kind in ('emulator','usb'),'explicit_android_target_kind')
    if kind=='usb':
        require(mode=='core','usb_full_journeys_not_implemented')
        require(runs==1,'usb_one_explicit_fresh_fixture_only')
        require(a.get('ownerApprovedDedicatedFixture') is True and isinstance(c.get('trustedTls'),dict),'usb_explicit_fixture_and_trusted_tls_required')
        require(set(c['trustedTls'])=={'hostname','certificate','certificateSha256','key','keySha256'},'usb_complete_explicit_tls_inputs_required')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',a.get('serial','')) and not a['serial'].startswith('emulator-'),'usb_explicit_serial')
        require(re.fullmatch(r'/storage/emulated/0/Documents/Obsync-[A-Za-z0-9-]+',a.get('vaultPath','')),'usb_explicit_fresh_vault')
        route=a.get('trustedRoute',{})
        require(route.get('transport')=='adb-reverse' and route.get('url','').rstrip('/')==f"https://{c['trustedTls'].get('hostname')}:{c.get('tlsPort',18473)}",'usb_owned_loopback_trusted_route_required')
    return kind


def usb_configuration(c,desktop,lab):
    spec=importlib.util.spec_from_file_location('mobile_trusted_tls',helper('mobile-trusted-tls.py'))
    tls_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(tls_module)
    target_scope(c,'core',1)
    require(lab['mobileUrl']==c['android']['trustedRoute']['url'].rstrip('/'),'usb_runtime_route_hostname')
    return {**c['android'],'schema':1,'targetKind':'usb','source':c['source'],'sourceHead':c['sourceHead'],'desktopRun':str(desktop),
        'seconds':min(c.get('seconds',7500)-120,c['android'].get('seconds',7200)),
        'trustedRoute':{'url':lab['mobileUrl'],'transport':'adb-reverse',
            'bindingSha256':sha(desktop/'private/tls-binding.json'),
            'leafDerSha256':hashlib.sha256(tls_module.leaf_der((desktop/'private/tls.crt').read_bytes())).hexdigest()}}


def summary(attempts, requested, mode, source_head, target_kind='emulator'):
    full = (target_kind=='emulator' and mode == 'full' and requested == 3 and len(attempts) == 3
            and len({a['attempt'] for a in attempts}) == 3
            and all(a.get('result') == 'FULL_PASS' and a.get('cleanup') == 'PASS' for a in attempts))
    core = (target_kind=='emulator' or requested==1) and mode == 'core' and len(attempts) == requested and all(a.get('result') == 'CORE_ONLY' and a.get('cleanup') == 'PASS' for a in attempts)
    first = next((row for row in attempts if row.get('result') == 'FAIL'), None)
    return {'schema': 1, 'sourceHead': source_head, 'result': 'PASS' if full else 'CORE_ONLY' if core else 'FAIL',
            'requestedRuns': requested, 'completedRuns': len(attempts), 'attempts': attempts,
            'threeFreshFullRunsPassed': full, 'fullAcceptance': 'PASS' if full else 'NOT_RUN',
            'targetKind':target_kind,'physicalPhone':'USB_CORE_ONLY' if target_kind=='usb' and core else 'INCOMPLETE' if target_kind=='usb' else 'NOT_RUN',
            'freshPhysicalEnvironment':False if target_kind=='usb' else 'NOT_ASSERTED','deviceFixtureCleanup':'NOT_ASSERTED' if target_kind=='usb' else 'NOT_RUN' if not attempts else
                'OWNED_RUNTIME_REMOVED' if all(a.get('cleanup') == 'PASS' for a in attempts) else 'UNKNOWN',
            'unimplementedJourneys':list(FULL_JOURNEYS) if target_kind=='usb' else sorted(set(FULL_JOURNEYS) - set(IMPLEMENTED_FULL_JOURNEYS)),
            **({'firstFailure': first.get('firstFailure'), 'failureClass': first.get('failureClass', 'UNCLASSIFIED')} if first else {})}


def lifecycle_request(run, name, expected):
    request_id = 'core-' + name.removesuffix('.json')
    require(name == 'close-transport.json' and expected == 'CLOSED', 'explicit_terminal_close_protocol')
    save(run / 'private' / name, {'schema': 1, 'requestId': request_id, 'protocol': 'NATURAL_EOF_90S'})
    result = run / 'private' / name.replace('.json', '-result.json')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if result.exists():
            proof = private_json(result)
            require(proof.get('requestId') == request_id and proof.get('result') == expected
                    and proof.get('ownedGroupAbsent') is True and proof.get('naturalDesktopQuitExitCode') == 0
                    and proof.get('desktopGroupNaturallyAbsent') is True and proof.get('recorderNaturalEof') is True
                    and proof.get('drainDeadlineMs') == 70000 and proof.get('closeProtocol') == 'NATURAL_EOF_90S', 'transport_close_receipt')
            return
        time.sleep(.1)
    raise StageFailure('transport_close_deadline')


def child_context(args):
    config = private_json(args.config)
    require(re.fullmatch('[a-f0-9]{40}', config.get('sourceHead', '')), 'source_head')
    target_scope(config,args.mode,1)
    desktop, android = args.attempt / 'desktop', args.attempt / 'android'
    require(os.environ.get('OBSYNC_MOBILE_RUN') == str(desktop), 'owned_desktop_child_environment')
    lab = private_json(desktop / 'lab.json')
    require(lab.get('run') == str(desktop) and lab.get('source_head') == config['sourceHead']
            and lab.get('source_dirty') is False, 'owned_desktop_manifest')
    return config, desktop, android, lab, Steps(args.attempt, config['sourceHead'])


def desktop_child(args):
    c, desktop, android, lab, steps = child_context(args)
    node, source = c['node'], c['source']
    steps.run('desktop-setup', [node, helper('mobile/setup.mjs'), str(desktop), source], timeout=180)
    a = c['android']
    if a.get('targetKind')=='usb':
        usb_config=args.attempt/'private/usb-config.json';save(usb_config,usb_configuration(c,desktop,lab))
        command=[sys.executable,'-B',helper('android-usb.py'),'--config',str(usb_config),'--run',str(android),'--child',
                 sys.executable,'-B',str(Path(__file__).resolve()),'--android-child','--config',str(args.config),'--attempt',str(args.attempt),'--mode',args.mode]
    else:
        command = [sys.executable, '-B', helper('android-session.py'), 'run', '--run', str(android), '--source', source,
                   '--source-head', c['sourceHead'], '--sdk', a['sdk'], '--java', a['java'], '--assets', a['assets'],
                   '--system-image', a['systemImage'], '--gpu', a.get('gpu', 'software'), '--port', str(a.get('port', 5584)),
                   '--seconds', str(min(c.get('seconds', 7500) - 120, a.get('seconds', 7200))), '--reverse', str(c['tlsPort']),
                   '--', sys.executable, '-B', str(Path(__file__).resolve()), '--android-child', '--config', str(args.config),
                   '--attempt', str(args.attempt), '--mode', args.mode]
    # Controllers own process groups, duration enforcement and cleanup. Do not
    # SIGKILL their parent with subprocess timeout and strand nested peers.
    with (args.attempt / 'private/android-controller.log').open('xb') as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    result_path = android / 'evidence/result.json'
    if not result_path.exists():
        terminal = final_json((args.attempt / 'private/android-controller.log').read_text(errors='replace'))
        common = load_controller()
        save(desktop / 'evidence/android-controller-terminal.json', {'schema': 1, 'result': 'FAIL', 'sourceHead': c['sourceHead'],
             'exceptionType': terminal.get('exceptionType'), 'detail': common.sanitized_diagnostic(terminal.get('detail', ''))})
        raise StageFailure('android_controller_preflight')
    proof = private_json(result_path)
    require_android_controller(proof, result.returncode, c['sourceHead'])
    quit_command = ([node, helper('mobile/recovery.mjs'), str(desktop), source, 'C', 'quit'] if args.mode == 'full' else
                    [node, helper('mobile/desktop.mjs'), str(desktop), 'quit', 'terminal-close', '--source', source])
    steps.run('terminal-ordinary-desktop-quit', quit_command, ('QUIT_REQUESTED',))
    lifecycle_request(desktop, 'close-transport.json', 'CLOSED')
    if args.mode == 'full':
        full_journey_receipt(desktop, c['sourceHead'])
        steps.run('closed-native-confidentiality-scan', [node, helper('mobile/native-confidentiality-scan.mjs'), str(desktop), '--source', source], timeout=90)
        scan = private_json(desktop / 'private/scan-result.json')
        require(scan.get('result') == 'PASS' and scan.get('sourceHead') == c['sourceHead'], 'full_native_scan_receipt')
        save(desktop / 'evidence/full-result.json', {'schema': 1, 'sourceHead': c['sourceHead'], 'result': 'PASS',
             'nativeJourneys': 'PASS', 'closedConfidentialityScan': 'PASS', 'androidCleanup': 'PASS', 'physicalPhone': 'NOT_RUN'})
        print(json.dumps({'result': 'PASS', 'sourceHead': c['sourceHead']}), flush=True)
        return
    save(desktop / 'evidence/core-result.json', {'schema': 1, 'sourceHead': c['sourceHead'], 'result': 'CORE_ONLY',
         'fullAcceptance': 'NOT_RUN', 'scanner': 'NOT_RUN', 'androidCleanup': 'PASS',
         'unimplementedJourneys': list(FULL_JOURNEYS), 'physicalPhone':'USB_CORE_ONLY' if a.get('targetKind')=='usb' else 'NOT_RUN',
         'targetKind':a.get('targetKind','emulator'),'deviceFixtureCleanup':'NOT_ASSERTED' if a.get('targetKind')=='usb' else 'AVD_REMOVED_BY_CONTROLLER'})
    print(json.dumps({'result': 'CORE_ONLY', 'sourceHead': c['sourceHead']}), flush=True)


def android_child(args):
    c, desktop, android, lab, steps = child_context(args)
    require(os.environ.get('OBSYNC_ANDROID_RUN') == str(android), 'owned_android_child_environment')
    node, source, controller = c['node'], c['source'], load_controller()
    state = controller.live_state(android)
    require(state['sourceHead'] == c['sourceHead'], 'android_source_binding')
    require(state.get('targetKind','emulator')==c['android'].get('targetKind','emulator'),'android_target_binding')
    usb=state.get('targetKind')=='usb'
    vault = c['android']['vaultPath'] if usb else '/storage/emulated/0/Documents/Obsync-Core-' + args.attempt.name.replace('attempt-', '')
    count = 0
    def phone(stage, command, values, results=('PASS',), negative=False):
        nonlocal count
        count += 1
        path = android / 'private' / f'orchestrator-{count:03d}-{stage}.json'
        save(path, {'vaultPath': vault, **values})
        return steps.run(stage, [node, helper('android-journey.mjs'), '--manifest', str(android / 'android.json'),
                                '--input', str(path), command], results, timeout=180, negative=negative)
    def desk(stage, command, label=None, extra=()):
        return steps.run(stage, [node, helper('mobile/desktop.mjs'), str(desktop), command,
                                *([label] if label else []), '--source', source, *extra],
                         {'note': ('PASS',), 'pair-generate': ('READY',), 'pair-match': ('MATCHED',),
                          'pair-approve': ('APPROVED',), 'status': ('OBSERVED',), 'read-note': ('PASS',),
                          'save-old': ('PASS',), 'inspect-cancel': ('PASS',), 'block-access': ('OBSERVED',),
                          'rotate-stage': ('PASS',), 'prepare': ('PASS',), 'resume': ('OBSERVED',),
                          'seed': ('PASS',), 'commit': ('PASS',), 'close-dialog': ('PASS',), 'quit': ('QUIT_REQUESTED',)}[command])
    def tls(case, trusted_probe=None):
        url = f"https://127.0.0.1:{c['tlsPort']}" if case == 'wrong-host' else lab['mobileUrl']
        before_files = set((android / 'evidence').glob('android-journey-tls-probe-*.json'))
        probe = phone('tls-' + case, 'tls-probe', {'url': url + '/v1/plugin/manifest', 'case': case},
                      results=('PASS',) if case == 'trusted' else ('PASS', 'FAIL'), negative=case != 'trusted')
        added = set((android / 'evidence').glob('android-journey-tls-probe-*.json')) - before_files
        require(len(added) == 1, 'exact_tls_probe_receipt')
        probe_path = added.pop(); require(private_json(probe_path) == probe, 'tls_probe_stdout_binding')
        require(probe.get('tlsVerificationDisabled') is False and not probe.get('blockedReasons'), 'owned_tls_probe_identity')
        if case == 'trusted':
            require(probe.get('result') == 'PASS' and probe.get('status') == 200 and probe.get('webViewFetchResolved') is True
                    and probe.get('manifestVersion') == json.loads((Path(source) / 'manifest.json').read_text())['version'], 'trusted_manifest_200')
            return probe_path
        require(probe.get('webViewFetchResolved') is False, 'rejected_tls_probe')
        host_path = desktop / 'evidence/host-tls.json'
        command = [sys.executable, '-B', helper('android-tls-proof.py'), '--run', str(android), '--probe', str(probe_path),
                   '--host-proof', str(host_path), '--host-proof-sha256', sha(host_path)]
        if case == 'wrong-host':
            require(trusted_probe is not None, 'trusted_probe_before_wrong_host'); command.extend(['--trusted-probe', str(trusted_probe)])
        combined = steps.run('native-certificate-' + case, command)
        path = Path(combined['receipt'])
        require(path.parent == android / 'evidence' and private_json(path).get('sourceHead') == c['sourceHead'], 'certificate_receipt_scope')
        return path
    phone('android-onboard', 'onboard', {'sourceDir': source, 'preflight': c['candidateBuildReceipt'], 'controllerPath': helper('android-session.py')})
    before=None
    if not usb:
        before = tls('untrusted')
        ca = desktop / 'private/ca.crt'
        steps.run('install-owned-android-ca', [sys.executable, '-B', helper('android-trust.py'), 'install', '--run', str(android),
                  '--ca', str(ca), '--ca-sha256', sha(ca), '--untrusted-probe', str(before)], ('INSTALLED',), timeout=120)
        phone('restart-after-trust', 'restart', {'controllerPath': helper('android-session.py')}, ('RESTARTED',))
        phone('vault-after-trust-restart', 'wait-vault', {})
        steps.run('verify-owned-android-ca', [sys.executable, '-B', helper('android-trust.py'), 'verify', '--run', str(android)], ('VERIFIED',))
    trusted = tls('trusted'); tls('wrong-host', trusted)
    phone_note = {'path': 'Android-Core-' + args.attempt.name + '.md', 'text': '# Synthetic Android core\n\nNative note before pairing.\n'}
    phone('android-note-before-pair', 'note-create', {'note': phone_note['path'], 'text': phone_note['text'], 'expectPaired': False})
    generation = desk('desktop-before-pair', 'status')['generationHash']
    desk('desktop-invitation', 'pair-generate')
    phone('android-pair-submit', 'pair-submit', {'serverUrl': lab['mobileUrl'], 'invitationFile': str(desktop / 'private/desktop/phone-pair-code.txt')}, ('OBSERVED',))
    observation = android / 'private/android-claimant-observation.json'
    binding = ('--android-run', str(android), '--observation', str(observation))
    desk('independent-sas-compare', 'pair-match', extra=binding)
    desk('desktop-approve-sas', 'pair-approve', extra=binding)
    phone('android-upload-consent', 'pair-consent', {'expectedGenerationHash': generation})
    phone('android-active-generation', 'status', {'expectedGenerationHash': generation})
    expected = {**phone_note, 'sha256': hashlib.sha256(phone_note['text'].encode()).hexdigest()}
    save(desktop / 'private/desktop/note-core-phone.json', expected)
    desk('desktop-read-phone-note', 'read-note', 'core-phone')
    desk('desktop-create-note', 'note', 'core-desktop')
    desktop_note = private_json(desktop / 'private/desktop/note-core-desktop.json')
    phone('android-read-desktop-note', 'note-read', {'note': desktop_note['path'], 'text': desktop_note['text']})
    fixtures = android / 'private/core-fixtures.json'; save(fixtures, [phone_note, {'path': desktop_note['path'], 'text': desktop_note['text']}])
    output = desktop / 'evidence/core-independent-bytes'
    proof = steps.run('independent-both-peer-bytes', [sys.executable, '-B', helper('mobile-evidence.py'), '--controller', helper('android-session.py'),
             '--android-run', str(android), '--desktop-run', str(desktop), '--fixtures', str(fixtures), '--output', str(output), '--android-vault', vault])
    require(proof.get('expectedCount') == 2 and proof.get('verifiedCount') == 2, 'independent_fixture_count')
    save(desktop / 'evidence/core-independent-bytes.json', proof)
    phone('android-metadata', 'metadata-export', {'phase': 'core'})
    metadata = android / 'private/android-custody-core/metadata.json'
    private_json(metadata)
    with (desktop / 'private/android-metadata-core.json').open('xb') as stream:
        stream.write(metadata.read_bytes())
    (desktop / 'private/android-metadata-core.json').chmod(0o600)
    if usb:steps.run('usb-software-platform',[sys.executable,'-B',helper('mobile-platform.py'),'--desktop-run',str(desktop),'--android-run',str(android)],('OBSERVED',))
    if usb:
        old=controller.stopped_app(state)
        save(android/'evidence/usb-core-device-stop.json',{'schema':1,'result':'STOPPED','sourceHead':c['sourceHead'],
            'oldPid':old,'oldProcessAndSocketAbsent':old is not None,'alreadyStopped':old is None,
            'method':'force-stop dedicated test app','appDataReset':False,'testVaultRemoval':'NOT_RUN','nativeKeyErasure':'NOT_ASSERTED'})
    if args.mode == 'full':
        spec = importlib.util.spec_from_file_location('owned_mobile_full', helper('mobile-full.py'))
        full = importlib.util.module_from_spec(spec); spec.loader.exec_module(full)
        full.run(SimpleNamespace(**globals()), args, c, desktop, android, lab, steps, phone, desk, tls, vault,
                 [phone_note, {'path': desktop_note['path'], 'text': desktop_note['text']}], before)
    print(json.dumps({'result': 'PASS', 'sourceHead': c['sourceHead'],
        'acceptanceScope': 'CORE_ONLY' if args.mode == 'core' else 'NATIVE_JOURNEYS_COMPLETE',
        'fullAcceptance': 'NOT_RUN' if args.mode == 'core' else 'PENDING_SCAN_AND_CLEANUP'}), flush=True)


def outer(args):
    c = private_json(args.config)
    require(re.fullmatch('[a-f0-9]{40}', c.get('sourceHead', '')) and isinstance(args.runs, int) and 1 <= args.runs <= 3, 'bounded_config')
    source = Path(c['source']).resolve(); out = args.out
    common = Path(subprocess.check_output(['git', '-C', str(source), 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True).strip()).parent
    require(not out.exists() and out.parent.is_dir() and out.parent.resolve() == out.parent and
            all(out.resolve() != root and root not in out.resolve().parents and out.resolve() not in root.parents for root in (source, common)), 'fresh_external_output')
    require(shutil.disk_usage(out.parent).free >= 20 * 1024**3, 'free_space_floor')
    out.mkdir(mode=0o700)
    args.output_created, args.source_head = True, c['sourceHead']
    args.target_kind=c['android'].get('targetKind','emulator');target_scope(c,args.mode,args.runs)
    missing = sorted(set(FULL_JOURNEYS) - set(IMPLEMENTED_FULL_JOURNEYS))
    if args.mode == 'full' and missing:
        save(out / 'result.json', {**summary([], args.runs, args.mode, c['sourceHead']), 'firstFailure': 'full_journeys_not_implemented'})
        return 2
    port = c['android'].get('port', 5584)
    if args.target_kind=='emulator':require(type(port) is int and 5554 <= port <= 5584 and port % 2 == 0, 'android_emulator_port_5554_to_5584_even', 'AUTOMATION_FAILURE')
    inventory = driver_inventory(args.mode, source)
    driver_head = subprocess.check_output(['git', '-C', str(HERE), 'rev-parse', 'HEAD'], text=True).strip()
    save(out / 'driver-manifest.json', {'schema': 1, 'sourceHead': c['sourceHead'], 'driverHead': driver_head, 'files': inventory})
    require(c.get('schema') == 1 and c.get('seconds', 7500) >= 600 and c['android']['sourceHead'] == c['sourceHead'], 'core_configuration')
    attempts = []
    args.completed_attempts = attempts
    for index in range(1, args.runs + 1):
        recheck_drivers(args.mode, source, inventory)
        attempt = out / f'attempt-{index:02d}'; attempt.mkdir(mode=0o700)
        for part in ('private', 'evidence'): (attempt / part).mkdir(mode=0o700)
        config = attempt / 'private/session-config.json'; save(config, {**c, 'mode': 'core' if args.mode == 'core' else 'acceptance'})
        command = [sys.executable, '-B', helper('mobile-session.py'), '--config', str(config), '--run', str(attempt / 'desktop'),
                   '--child', sys.executable, '-B', str(Path(__file__).resolve()), '--desktop-child', '--config', str(config),
                   '--attempt', str(attempt), '--mode', args.mode]
        failure, cleanup, failure_class = None, 'UNKNOWN', 'UNCLASSIFIED'
        try:
            with (attempt / 'private/mobile-controller.log').open('xb') as log:
                result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
            peer = private_json(attempt / 'desktop/evidence/peer-result.json')
            cleanup = attempt_cleanup(peer, attempt / 'android')
            require(result.returncode == 0 and peer.get('sourceHead') == c['sourceHead']
                    and peer.get('result') == ('CORE_ONLY' if args.mode == 'core' else 'PASS') and clean_controller(peer), 'desktop_controller_cleanup')
            if args.mode == 'core':
                core = private_json(attempt / 'desktop/evidence/core-result.json')
                require(core.get('result') == 'CORE_ONLY' and core.get('fullAcceptance') == 'NOT_RUN', 'core_only_receipt')
            else:
                full = private_json(attempt / 'desktop/evidence/full-result.json')
                require(full.get('result') == 'PASS' and full.get('sourceHead') == c['sourceHead']
                        and full.get('nativeJourneys') == 'PASS' and full.get('closedConfidentialityScan') == 'PASS', 'full_native_and_scan_receipt')
            recheck_drivers(args.mode, source, inventory)
        except Exception as error:
            failure = error.stage if isinstance(error, StageFailure) else type(error).__name__
            failure_class = error.failure_class if isinstance(error, StageFailure) else 'UNCLASSIFIED'
            first = attempt / 'evidence/first-failure.json'
            if first.exists():
                marker = private_json(first)
                failure, failure_class = marker['firstFailure'], marker.get('failureClass', 'UNCLASSIFIED')
        row = {'attempt': attempt.name, 'result': 'FAIL' if failure else 'CORE_ONLY' if args.mode == 'core' else 'FULL_PASS', 'cleanup': cleanup,
               'firstFailure': failure, **({'failureClass': failure_class} if failure else {}), 'driverManifestSha256': sha(out / 'driver-manifest.json')}
        save(attempt / 'evidence/attempt-result.json', row); attempts.append(row)
        if failure: break  # Never replace a failed fresh attempt with a retry.
    recheck_drivers(args.mode, source, inventory)
    result = {**summary(attempts, args.runs, args.mode, c['sourceHead'],args.target_kind), 'driverHead': driver_head,
              'driverManifestSha256': sha(out / 'driver-manifest.json')}; save(out / 'result.json', result)
    print(json.dumps(result), flush=True)
    return 0 if result['result'] in ('CORE_ONLY', 'PASS') else 1


def main():
    os.umask(0o077)
    def interrupted(signum, frame):
        raise StageFailure('owned_runner_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=lambda v: Path(v).expanduser().absolute(), required=True)
    p.add_argument('--out', type=lambda v: Path(v).expanduser().absolute())
    p.add_argument('--runs', type=int, default=3)
    p.add_argument('--mode', choices=('full', 'core'), default='full')
    roles = p.add_mutually_exclusive_group(); roles.add_argument('--desktop-child', action='store_true'); roles.add_argument('--android-child', action='store_true')
    p.add_argument('--attempt', type=lambda v: Path(v).expanduser().absolute())
    args = p.parse_args()
    if args.desktop_child or args.android_child:
        require(args.attempt is not None, 'explicit_owned_child_scope')
        try:
            (desktop_child if args.desktop_child else android_child)(args)
        except Exception as error:
            path = args.attempt / 'evidence/first-failure.json'
            if not path.exists(): save(path, {'schema': 1, 'result': 'FAIL', 'role': 'desktop' if args.desktop_child else 'android',
                'firstFailure': error.stage if isinstance(error, StageFailure) else type(error).__name__,
                'failureClass': error.failure_class if isinstance(error, StageFailure) else 'UNCLASSIFIED', 'fullAcceptance': 'NOT_RUN'})
            raise
        return 0
    require(args.out is not None and args.attempt is None, 'outer_output_required')
    try:
        return outer(args)
    except Exception as error:
        if getattr(args, 'output_created', False) and not (args.out / 'result.json').exists():
            save(args.out / 'result.json', {**summary(getattr(args, 'completed_attempts', []), args.runs, args.mode, args.source_head,getattr(args,'target_kind','emulator')), 'result': 'FAIL',
                 'firstFailure': error.stage if isinstance(error, StageFailure) else type(error).__name__,
                 'failureClass': error.failure_class if isinstance(error, StageFailure) else 'UNCLASSIFIED'})
        raise


if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'schema': 1, 'result': 'FAIL', 'firstFailure': error.stage if isinstance(error, StageFailure) else type(error).__name__,
                          'failureClass': error.failure_class if isinstance(error, StageFailure) else 'UNCLASSIFIED',
                          'fullAcceptance': 'NOT_RUN', 'physicalPhone': 'NOT_ASSERTED'}), file=sys.stderr)
        raise SystemExit(1)
