"""Finite full native acceptance sequence; imported only by the owned runner.

No acceptance result is produced here. The caller additionally requires closed
complete capture, the actual confidentiality scanner and both owners' cleanup.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import time
import os
import stat


def pending_journal(run, source_head):
    """Whole owned CRC-checked journal, including IDs absent from API queries."""
    spec = importlib.util.spec_from_file_location('pending_rotation_journal', Path(__file__).with_name('mobile-journal.py'))
    journal = importlib.util.module_from_spec(spec); spec.loader.exec_module(journal)
    state = journal.SESSION.private_json(run / 'lab.json')
    if (state.get('format') != 1 or state.get('run') != str(run) or state.get('source_dirty') is not False
            or state.get('source_head') != source_head or time.time() >= state['expiresAtEpoch']):
        raise ValueError('owned pending journal source refused')
    server, holder = state['processes']['server'], state['holder']
    def bound():
        return (server['argv'] == [str(run / 'runtime/build/obsyncd'), 'serve']
                and journal.COMMON.identity(server['pid']) == server['identity']
                and journal.COMMON.identity(holder['pid']) == holder['identity'])
    if not bound(): raise ValueError('owned pending journal process refused')
    journal.SESSION.pin(run / 'runtime/build/obsyncd', state['artifacts']['obsyncd'])
    snapshot = journal.read_segments(run / 'runtime/server/journal/v1/journal')
    if not bound(): raise ValueError('owned pending journal process changed')
    return {**snapshot, 'sourceHead': source_head, 'serverArtifactSha256': state['artifacts']['obsyncd'],
            'serverIdentitySha256': hashlib.sha256(server['identity'].encode()).hexdigest()}


def assert_pending_journal(before, after):
    if (not isinstance(before, dict) or not before.get('segments') or before.get('frameCounts', {}).get('suite2_setup', 0) < 1
            or not re.fullmatch('[a-f0-9]{40}', before.get('sourceHead', ''))
            or any(not re.fullmatch('[a-f0-9]{64}', before.get(k, '')) for k in ('serverArtifactSha256', 'serverIdentitySha256'))
            or before != after):
        raise ValueError('pending restart changed whole verified journal')


def launch_to_idle(require, launch, idle):
    started, observed = launch.get('launchStartedAtEpochMs'), idle.get('idleObservedAtEpochMs')
    require(type(started) is int and type(observed) is int and 0 <= observed - started <= 120000,
            'actual_launch_to_automatic_idle_120000ms')
    return observed - started


def android_case_rename(require, proof):
    """Admit the explicit two-action UI workflow, never a direct-rename claim."""
    facts = {'result': 'PASS', 'workflow': 'TWO_ORDINARY_RENAMES', 'ordinaryRenameCount': 2,
             'intermediateAbsent': True, 'originalAbsent': True, 'originalBaselinePreserved': True,
             'finalFolder': 'Team docs', 'sharedBudgetMs': 180000, 'directSingleStepCaseRename': False,
             'independentAdbDirectory': True, 'descendants': 2}
    require(all(type(proof.get(k)) is type(v) and proof.get(k) == v for k, v in facts.items()),
            'android_two_ordinary_renames_original_baseline')
    elapsed = proof.get('elapsedMs')
    require(type(elapsed) is int and 0 <= elapsed < 180000, 'android_two_renames_shared_180000ms')
    return elapsed


def selected_evidence(run, source_head, phase=None):
    """Admit only the fixed retained selected exports; ancestry stays the JS oracle."""
    def need(ok):
        if not ok: raise ValueError('selected retained evidence refused')
    def raw(relative, bound=2097152):
        path = run / relative
        info = path.lstat()
        need(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
             and info.st_nlink == 1 and info.st_mode & 0o077 == 0 and 0 < info.st_size <= bound)
        return path.read_bytes()
    def read(relative):
        return json.loads(raw(relative))
    if phase is None: phase = read('evidence/full-selected-rename.json')
    exports, snapshots = phase.get('retainedByteExports'), phase.get('retainedServerSnapshots')
    labels = ('seed', 'down', 'down-quiet', 'up', 'up-quiet')
    need(isinstance(exports, list) and [e.get('label') for e in exports] == ['selected-' + n for n in labels])
    expected_hashes = None
    for name, entry in zip(labels, exports):
        root = 'evidence/independent-bytes-selected-' + name
        need(entry.get('resultPath') == root + '/result.json' and entry.get('fixtureManifestPath') == root + '-fixtures.json')
        fixture_raw, result_raw = raw(root + '-fixtures.json'), raw(root + '/result.json')
        need(hashlib.sha256(fixture_raw).hexdigest() == entry.get('fixtureManifestSha256')
             and hashlib.sha256(result_raw).hexdigest() == entry.get('resultSha256'))
        fixtures, result = json.loads(fixture_raw), json.loads(result_raw)
        folder = 'team docs' if name in ('down', 'down-quiet') else 'Team docs'
        need(isinstance(fixtures, list) and len(fixtures) == 2 and [n.get('path') for n in fixtures] == [folder + '/One.md', folder + '/Two.md'])
        need(result.get('schema') == 1 and result.get('result') == 'PASS' and result.get('sourceHead') == source_head
             and result.get('fixtureManifestSha256') == entry['fixtureManifestSha256']
             and result.get('expectedCount') == 2 and result.get('verifiedCount') == 2 and len(result.get('files', [])) == 2)
        hashes = []
        for i, fixture in enumerate(fixtures):
            expected = fixture['text'].encode()
            need(0 < len(expected) <= 65536)
            digest = hashlib.sha256(expected).hexdigest(); hashes.append(digest)
            row = result['files'][i]
            need(row.get('fixtureIndex') == i and row.get('bytes') == len(expected)
                 and all(row.get(k) == digest for k in ('expectedSha256', 'desktopSha256', 'androidSha256')))
            need(raw(root + '/' + str(i) + '-android.bin', 65536) == expected
                 and raw(root + '/' + str(i) + '-desktop.bin', 65536) == expected)
        if expected_hashes is None: expected_hashes = hashes
        need(hashes == expected_hashes)
    roles = ('original', 'down', 'quiet-down', 'up', 'quiet-up')
    need(isinstance(snapshots, list) and [s.get('label') for s in snapshots] == list(roles))
    identity, generation = None, None
    for label, command, entry in zip(roles, ('rename', 'before', 'watch-down', 'returned', 'watch-up'), snapshots):
        relative = 'evidence/selected-snapshot-' + label + '.json'
        need(entry.get('path') == relative)
        data = raw(relative, 67108864)
        need(len(data) == entry.get('bytes') and hashlib.sha256(data).hexdigest() == entry.get('sha256'))
        emitted = read('evidence/selected-desktop-' + command + '.json')
        need(emitted.get('result') == 'PASS' and emitted.get('sourceHead') == source_head and emitted.get('retainedSnapshots') == [entry])
        snapshot = json.loads(data)
        need(snapshot.get('schema') == 1 and snapshot.get('sourceHead') == source_head
             and snapshot.get('folder') == ('team docs' if label in ('down', 'quiet-down') else 'Team docs')
             and re.fullmatch('[a-f0-9]{32}', snapshot.get('generation', ''))
             and isinstance(snapshot.get('records'), list) and 3 <= len(snapshot['records']) <= 64)
        rows = snapshot.get('notes')
        need(isinstance(rows, list) and len(rows) == 2 and [r.get('suffix') for r in rows] == ['One.md', 'Two.md']
             and [r.get('sha256') for r in rows] == expected_hashes)
        current = [(r.get('fileId'), r.get('sha256')) for r in rows]
        need(all(re.fullmatch('[a-f0-9]{32}', r[0] or '') for r in current) and len(set(r[0] for r in current)) == 2)
        if identity is None: identity, generation = current, snapshot['generation']
        need(current == identity and snapshot['generation'] == generation)
    return True


def recovery_evidence(run, source_head):
    """Fixed fresh-C byte exports remain independently readable after cleanup."""
    def need(ok):
        if not ok: raise ValueError('recovery retained evidence refused')
    def raw(name, bound):
        path = run / 'evidence/recovery-C-readback' / name
        info = path.lstat()
        need(path.resolve() == path and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
             and info.st_nlink == 1 and info.st_mode & 0o077 == 0 and 0 < info.st_size <= bound)
        return path.read_bytes()
    manifest = raw('expectations.json', 1048576)
    expected, result = json.loads(manifest), json.loads(raw('result.json', 1048576))
    need(type(expected.get('schema')) is int and expected['schema'] == 1 and expected.get('sourceHead') == source_head
         and re.fullmatch('[a-f0-9]{64}', expected.get('generationHash', '')))
    notes = expected.get('notes')
    need(isinstance(notes, list) and len(notes) == 2 and [n.get('generation') for n in notes] == ['retained', 'current']
         and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md', n.get('path', ''))
                 and re.fullmatch('[a-f0-9]{64}', n.get('sha256', '')) for n in notes)
         and len({n['path'] for n in notes}) == 2 and len({n['sha256'] for n in notes}) == 2)
    need(type(result.get('schema')) is int and result['schema'] == 1 and result.get('result') == 'PASS' and result.get('sourceHead') == source_head
         and result.get('expectationsSha256') == hashlib.sha256(manifest).hexdigest()
         and type(result.get('expectedCount')) is int and result['expectedCount'] == 2
         and type(result.get('exportedCount')) is int and result['exportedCount'] == 2
         and isinstance(result.get('exports'), list) and len(result['exports']) == 2)
    for i, (note, entry) in enumerate(zip(notes, result['exports'])):
        data = raw(str(i) + '-desktop.bin', 65536)
        need(type(entry.get('index')) is int and entry['index'] == i
             and entry.get('path') == 'evidence/recovery-C-readback/' + str(i) + '-desktop.bin'
             and entry.get('generation') == note['generation'] and entry.get('expectedSha256') == note['sha256']
             and entry.get('actualSha256') == note['sha256'] == hashlib.sha256(data).hexdigest()
             and type(entry.get('bytes')) is int and entry['bytes'] == len(data) and entry.get('exactHashMatched') is True)
    return True


def run(api, args, c, desktop, android, lab, steps, phone, desk, tls, vault, core_notes, untrusted):
    require, save, private, helper = api.require, api.save, api.private_json, api.helper
    node, source, controller = c['node'], c['source'], api.load_controller()
    notes = list(core_notes)
    phases = []

    def native(stage, file, *arguments, results=('PASS',), timeout=180):
        return steps.run(stage, [node, helper('mobile/' + file), str(desktop), source, *map(str, arguments)], results, timeout=timeout)

    def life(stage, action, results, extra=()):
        return steps.run(stage, [sys.executable, '-B', helper('android-session.py'), action, '--run', str(android), *extra], results, timeout=300)

    def receipt(name, **facts):
        save(desktop / 'evidence' / ('full-' + name + '.json'), {'schema': 1, 'result': 'PASS', 'sourceHead': c['sourceHead'], **facts})
        phases.append(name)

    def metadata(phase):
        proof = phone('metadata-' + phase, 'metadata-export', {'phase': phase})
        require(proof.get('credentialExport') != 'EXPORTED', 'no_raw_android_credential_export')
        original = android / ('private/android-custody-' + phase + '/metadata.json')
        private(original)
        target = desktop / ('private/android-metadata-' + phase + '.json')
        with target.open('xb') as stream: stream.write(original.read_bytes())
        target.chmod(0o600)

    def both_bytes(label, fixture_list=None):
        expected = notes if fixture_list is None else fixture_list
        fixtures = desktop / ('evidence/independent-bytes-' + label + '-fixtures.json'); save(fixtures, expected)
        output = desktop / ('evidence/independent-bytes-' + label)
        proof = steps.run('independent-bytes-' + label, [sys.executable, '-B', helper('mobile-evidence.py'),
            '--controller', helper('android-session.py'), '--android-run', str(android), '--desktop-run', str(desktop),
            '--fixtures', str(fixtures), '--output', str(output), '--android-vault', vault])
        require(proof.get('expectedCount') == len(expected) and proof.get('verifiedCount') == len(expected), 'all_independent_fixture_bytes', 'OUTCOME_MISMATCH')
        require(proof.get('sourceHead') == c['sourceHead'] and proof.get('fixtureManifestSha256') == hashlib.sha256(fixtures.read_bytes()).hexdigest(), 'retained_fixture_binding')
        save(desktop / ('evidence/independent-bytes-' + label + '.json'), proof)
        return {'label': label, 'resultPath': str((output / 'result.json').relative_to(desktop)),
                'resultSha256': hashlib.sha256((output / 'result.json').read_bytes()).hexdigest(),
                'fixtureManifestPath': str(fixtures.relative_to(desktop)), 'fixtureManifestSha256': proof['fixtureManifestSha256']}

    def note_from_phone(label, text, paired=True):
        note = {'path': 'Android-' + label + '.md', 'text': text}
        phone('phone-create-' + label, 'note-create', {'note': note['path'], 'text': text, 'expectPaired': paired})
        save(desktop / ('private/desktop/note-' + label + '.json'), {**note, 'sha256': hashlib.sha256(text.encode()).hexdigest()})
        return note

    def phone_reads(stage, note):
        phone(stage, 'note-read', {'note': note['path'], 'text': note['text']})

    def new_desktop(label):
        desk('desktop-create-' + label, 'note', label)
        return private(desktop / ('private/desktop/note-' + label + '.json'))

    def capture(label, note, backup):
        return steps.run('native-cipher-' + label, [node, helper('mobile/native-ciphertext-capture.mjs'), str(desktop), label,
            '--source', source, '--note-label', note, '--backup', backup], results=('CAPTURED',), timeout=180)

    def archive_pair(label):
        root = desktop / ('private/desktop/pair-' + label); root.mkdir(mode=0o700)
        for name in ('phone-pair-code.txt', 'phone-creator-match.txt', 'pair-approval-used.json'):
            path = desktop / 'private/desktop' / name
            require(path.exists(), 'prior_complete_pair_round'); api.private_json(path) if name.endswith('.json') else path.read_bytes()
            path.rename(root / name)
        observed = android / 'private/android-claimant-observation.json'; private(observed)
        observed.rename(root / 'android-claimant-observation.json')

    def compare_approve(label):
        binding = ('--android-run', str(android), '--observation', str(android / 'private/android-claimant-observation.json'))
        desk(label + '-independent-match', 'pair-match', extra=binding)
        desk(label + '-creator-approve', 'pair-approve', extra=binding)

    def request(name, label, payload, expected):
        for suffix in ('', '-result'):
            old = desktop / ('private/' + name + suffix + '.json')
            if old.exists():
                private(old); old.rename(desktop / ('private/' + name + suffix + '-before-' + label + '.json'))
        request_id = 'full-' + label
        target = desktop / ('private/' + name + '.json')
        body = {'schema': 1, 'requestId': request_id, **payload}
        if name == 'android-route':
            temporary = desktop / 'private/android-route.pending.json'
            save(temporary, body); temporary.rename(target)
        else: save(target, body)
        end = time.monotonic() + 90
        while time.monotonic() < end:
            path = desktop / ('private/' + name + '-result.json')
            if path.exists():
                result = private(path)
                if name == 'android-route' and result.get('requestId') == request_id and result.get('result') == 'FAIL':
                    code = result.get('errorCode')
                    known = ('route_request_private', 'route_request_shape', 'route_request_reused', 'route_request_budget',
                             'route_source_binding', 'route_gate_state', 'route_drain_timeout', 'route_drain_incomplete', 'route_resume_without_drain')
                    require(False, 'owned_android_route_' + (code if code in known else 'control_refused'))
                require(result.get('requestId') == request_id and result.get('result') == expected, 'owned_' + name + '_receipt')
                return result
            time.sleep(.1)
        require(False, 'owned_' + name + '_deadline')

    def restart_desktop(label, expected_phase):
        before=desk(label + '-before-normal-quit', 'status')
        require(before.get('phase')==expected_phase and before.get('rotationPending') is True and before.get('pendingCheckpointMatches') is True,
                'pending_checkpoint_before_normal_quit')
        desk(label + '-ordinary-quit', 'quit')
        proof = request('restart', label, {'device': 'A'}, 'RESTARTED')
        require(proof.get('oldGroupAbsent') is True and proof.get('profileReset') is False and proof.get('naturalQuitExitCode') == 0,
                'natural_quit_and_preserved_restart')
        native(label + '-passive-pending-readiness', 'native-readiness.mjs', label + '-restart',
               before['generationHash'], before['credentialHash'], str(proof.get('launchStartedAtEpochMs')), timeout=125)
        status = desk(label + '-reloaded-state', 'status')
        require(status.get('phase') == expected_phase and status.get('rotationPending') is True and status.get('pendingCheckpointMatches') is True,
                'persisted_rotation_checkpoint')
        return status

    # Baseline and quiet period: no Android call of any kind within the interval.
    steps.run('platform-observation', [sys.executable, '-B', helper('mobile-platform.py'), '--desktop-run', str(desktop), '--android-run', str(android)], ('OBSERVED',))
    desk('save-complete-old-ui-backup', 'save-old')
    capture('before', 'core-desktop', 'old')
    save(desktop / 'private/full-fixtures.json', notes)
    native('quiet-before', 'native-checkpoint.mjs', 'quiet-before', results=('OBSERVED',))
    old_status = phone('before-lifecycle-state', 'status', {'requireIdle': True}, ('OBSERVED',))
    home = life('android-home-before-quiet', 'home', ('BACKGROUNDED',))
    require(home.get('processRetained') is True, 'background_process_retained')
    start = time.monotonic()
    while True:
        remaining = 213 - (time.monotonic() - start)
        if remaining <= 0: break
        time.sleep(min(10, remaining))
    elapsed = time.monotonic() - start
    native('quiet-after', 'native-checkpoint.mjs', 'quiet-after', 'quiet-before')
    receipt('quiet', elapsedMs=round(elapsed * 1000), androidCallsDuringInterval=0, historiesAndHeadsUnchanged=True)

    desktop_before = desk('active-desktop-before-normal-quit', 'status')
    require(desktop_before.get('status') == 'idle' and desktop_before.get('paired') is True and desktop_before.get('phase') == 'active'
            and desktop_before.get('dialogCount') == 0 and desktop_before.get('generationHash') == old_status['generationHash'], 'active_desktop_enrollment_before_restart')
    desk('active-desktop-ordinary-quit', 'quit')
    desktop_launch = request('restart', 'active-desktop', {'device': 'A'}, 'RESTARTED')
    require(desktop_launch.get('oldGroupAbsent') is True and desktop_launch.get('profileReset') is False and desktop_launch.get('naturalQuitExitCode') == 0,
            'active_desktop_natural_quit_preserved_profile')
    desktop_idle = native('desktop-passive-automatic-idle', 'native-readiness.mjs', 'active-restart',
        desktop_before['generationHash'], desktop_before['credentialHash'])
    desktop_idle_ms = launch_to_idle(require, desktop_launch, desktop_idle)
    both_bytes('active-desktop-restart')

    restarted = life('android-real-process-restart', 'restart-app', ('RESTARTED',))
    require(restarted.get('oldProcessAndSocketAbsent') is True and restarted.get('freshDevtoolsSocket') is True
            and restarted.get('oldPid') == home['applicationPid'] and restarted.get('appDataReset') is False, 'real_android_restart')
    phone('vault-after-real-restart', 'wait-vault', {})
    android_idle = phone('persisted-native-enrollment', 'status', {'expectedGenerationHash': old_status['generationHash'], 'expectedCredentialHash': old_status['credentialHash'], 'requireIdle': True})
    android_idle_ms = launch_to_idle(require, restarted, android_idle)
    both_bytes('restart')
    rebooted = life('android-guest-reboot', 'reboot', ('REBOOTED',), ('--boot-seconds', '240'))
    require(rebooted.get('actualGuestReboot') is True and rebooted.get('trustReapplyRequired') is True, 'real_guest_reboot')
    ca = desktop / 'private/ca.crt'
    steps.run('reapply-owned-ca-after-reboot', [sys.executable, '-B', helper('android-trust.py'), 'reapply', '--run', str(android),
        '--ca', str(ca), '--ca-sha256', api.sha(ca), '--untrusted-probe', str(untrusted)], ('INSTALLED',), timeout=120)
    life('start-android-after-reboot', 'restart-app', ('STARTED', 'RESTARTED'))
    phone('vault-after-reboot', 'wait-vault', {})
    steps.run('verify-ca-after-reboot', [sys.executable, '-B', helper('android-trust.py'), 'verify', '--run', str(android)], ('VERIFIED',))
    trusted = tls('trusted'); tls('wrong-host', trusted)
    phone('native-enrollment-after-reboot', 'status', {'expectedGenerationHash': old_status['generationHash'], 'expectedCredentialHash': old_status['credentialHash'], 'requireIdle': True})
    both_bytes('reboot'); receipt('restart', processRestart=True, guestReboot=True, physicalDeviceReboot='NOT_RUN', persistedEnrollment=True,
        activeDesktopNormalQuitRestart=True, desktopLaunchToIdleMs=desktop_idle_ms, androidLaunchToIdleMs=android_idle_ms,
        noSetupPairingOrSyncNowAction=True, preexistingIndependentBytes=True)

    # Offline is an explicitly removed private reverse route, never global Wi-Fi.
    life('android-home-before-offline', 'home', ('BACKGROUNDED',))
    state = controller.live_state(android); controller.check_reverse(state)
    port = c['tlsPort']; require(state['reversePorts'] == [port], 'single_owned_offline_route')
    controller.adb_command(state, ['reverse', '--remove', 'tcp:' + str(port)])
    mappings = controller.adb_command(state, ['reverse', '--list'])
    require(not any(line.split()[-2:] == ['tcp:' + str(port)] * 2 for line in mappings.splitlines()), 'owned_route_removed')
    drained = request('android-route', 'offline-drain', {'action': 'drain'}, 'DRAINED')
    require(drained.get('sourceHead') == c['sourceHead'] and drained.get('activeSockets') == 0 and drained.get('gateClosed') is True and
            drained.get('forcedActiveSocketCloses') == 0 and drained.get('drainDeadlineMs') == 70000 and
            0 <= drained.get('drainMs', -1) <= 70000 and drained.get('desktopRecorderListenerUnchanged') is True,
            'owned_android_route_gracefully_drained')
    offline_note = new_desktop('offline-desktop')
    activity = controller.adb_command(state, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', 'md.obsidian']).strip().splitlines()[-1]
    require(re.fullmatch(r'md\.obsidian/[\w.$]+', activity), 'official_owned_android_activity')
    controller.adb_command(state, ['shell', 'am', 'start', '-W', '-n', activity])
    phone('offline-desktop-note-not-received', 'note-absent', {'note': offline_note['path']})
    phone_note = note_from_phone('offline-phone', '# Synthetic offline Android\n\nPending bytes survive route removal and Home.\n', paired=False)
    notes.extend([{'path': offline_note['path'], 'text': offline_note['text']}, phone_note])
    require(not (desktop / 'runtime/A/Lab-A' / phone_note['path']).exists(), 'offline_phone_note_not_received')
    resumed = request('android-route', 'offline-resume', {'action': 'resume'}, 'RESUMED')
    require(resumed.get('sourceHead') == c['sourceHead'] and resumed.get('gateOpen') is True and resumed.get('priorDrainProven') is True, 'owned_android_route_gate_resumed')
    controller.adb_command(controller.live_state(android), ['reverse', 'tcp:' + str(port), 'tcp:' + str(port)])
    controller.check_reverse(controller.live_state(android))
    phone_reads('offline-desktop-note-received-after-route', offline_note)
    phone_reads('offline-phone-tracked-after-route', phone_note)
    desk('offline-phone-note-received-after-route', 'read-note', 'offline-phone')
    both_bytes('offline'); receipt('background-offline', privateRouteRemovedAndRestored=True, existingTlsSocketsGracefullyDrained=True,
        tlsGateResumed=True, faultClass='OWNED_ANDROID_ROUTE_OFFLINE', certificateValidation='NOT_TESTED_BY_ROUTE_GATE', pendingNotesBothDirections=True)

    # Access-only revocation deliberately keeps the same content root.
    desk('inspect-access-dialog-and-cancel', 'inspect-cancel')
    desk('block-android-access-only', 'block-access')
    phone('android-authentication-refused', 'expect-revoked', {})
    access_note = new_desktop('access-desktop')
    phone('revoked-android-new-note-absent', 'note-absent', {'note': access_note['path']})
    capture('access', 'access-desktop', 'old')
    phone('leave-preserves-local-before', 'leave-snapshot', {}, ('OBSERVED',))
    phone('ordinary-leave-open', 'leave-open', {}, ('ACTION_COMPLETED',))
    phone('ordinary-leave-confirm', 'control', {'selector': '.modal:not(.mod-settings) button', 'expectedText': 'Leave', 'action': 'click'}, ('ACTION_COMPLETED',))
    phone('leave-preserves-local-after', 'leave-verify', {})
    steps.run('independent-preinvite-known-notes', [node, helper('mobile/known-notes-proof.mjs'), str(desktop), 'access-repair', '--source', source, '--backup', 'old'])
    archive_pair('initial')
    desk('access-repair-invitation', 'pair-generate')
    invitation = desktop / 'private/desktop/phone-pair-code.txt'
    phone('access-repair-claimant', 'pair-submit', {'serverUrl': lab['mobileUrl'], 'invitationFile': str(invitation)}, ('OBSERVED',))
    compare_approve('access-repair')
    phone('access-repair-local-consent', 'pair-consent', {'expectedGenerationHash': old_status['generationHash'], 'invitationFile': str(invitation),
        'knownNotesProof': str(desktop / 'private/desktop/known-notes-access-repair.json')})
    phone_reads('access-repair-desktop-note-read', access_note)
    notes.append({'path': access_note['path'], 'text': access_note['text']})
    both_bytes('access-repair'); metadata('access'); receipt('access-repair', revokedTransportRefused=True, oldRootDirectCipherPositive='REQUIRED_ORACLE_AFTER_ROTATION', ordinaryLeavePreservedBytes=True, freshIndependentSas=True)

    # Persisted interruption at prepared and commit_unknown, without state edits.
    desk('stage-strong-key-rotation', 'rotate-stage')
    native('rotation-draft-complete-inventory', 'native-checkpoint.mjs', 'rotation-draft', results=('OBSERVED',))
    desk('prepare-strong-key-rotation', 'prepare')
    def held_checkpoint(stage, label, previous=None):
        proof = native(stage, 'native-checkpoint.mjs', label, *([previous] if previous else []), results=('PASS',) if previous else ('OBSERVED',))
        require(proof.get('engineState') in ('ABSENT', 'STOPPED'), 'pending_rotation_engine_stopped')
    held_checkpoint('prepared-before-restart', 'prepared-before', 'rotation-draft')
    prepared_journal = pending_journal(desktop, c['sourceHead'])
    restart_desktop('prepared', 'prepared')
    held_checkpoint('prepared-after-restart', 'prepared-after', 'prepared-before')
    assert_pending_journal(prepared_journal, pending_journal(desktop, c['sourceHead']))
    save(desktop / 'evidence/pending-journal-prepared.json', {**prepared_journal, 'result': 'PASS', 'entireVerifiedJournalUnchanged': True})
    desk('resume-prepared-rotation', 'resume')
    desk('seed-current-generation', 'seed')
    held_checkpoint('commit-unknown-before-restart', 'commit-before')
    commit_journal = pending_journal(desktop, c['sourceHead'])
    restart_desktop('commit-unknown', 'commit_unknown')
    held_checkpoint('commit-unknown-after-restart', 'commit-after', 'commit-before')
    assert_pending_journal(commit_journal, pending_journal(desktop, c['sourceHead']))
    save(desktop / 'evidence/pending-journal-commit.json', {**commit_journal, 'result': 'PASS', 'entireVerifiedJournalUnchanged': True})
    desk('resume-commit-unknown', 'resume')
    desk('commit-strong-key-rotation', 'commit')
    desk('close-committed-rotation-dialog', 'close-dialog')
    new_status = desk('strong-rotation-current-state', 'status')
    require(new_status['generationHash'] != old_status['generationHash'], 'new_native_generation')
    phone('old-android-generation-refused', 'expect-revoked', {})
    rotated_note = new_desktop('rotated-desktop')
    phone('old-android-current-note-absent', 'note-absent', {'note': rotated_note['path']})
    capture('rotated', 'rotated-desktop', 'new')
    steps.run('detached-native-crypto-oracle', [node, helper('mobile/ciphertext-oracle.mjs'), str(desktop), '--source', source,
        '--baseline', 'before', '--access-only', 'access', '--current', 'rotated'], timeout=180)
    archive_pair('access')
    steps.run('independent-rotation-preinvite-known-notes', [node, helper('mobile/known-notes-proof.mjs'), str(desktop), 'rotation-repair', '--source', source, '--backup', 'new', '--rotation-proof', 'commit-after'])
    desk('rotation-repair-new-invitation', 'pair-generate')
    phone('ordinary-pair-after-rotation', 'rotation-pair-submit', {'serverUrl': lab['mobileUrl'], 'invitationFile': str(invitation),
        'oldBackupFile': str(desktop / 'private/desktop/phone-old-recovery-backup.txt')}, ('OBSERVED',))
    compare_approve('rotation-repair')
    phone('rotation-repair-local-consent', 'pair-consent', {'expectedGenerationHash': new_status['generationHash'], 'expectedOldGenerationHash': old_status['generationHash'], 'invitationFile': str(invitation),
        'knownNotesProof': str(desktop / 'private/desktop/known-notes-rotation-repair.json')})
    phone('rotation-repair-retained-history', 'rotation-pair-status', {'expectedGenerationHash': new_status['generationHash'], 'expectedOldGenerationHash': old_status['generationHash']})
    phone_reads('rotated-desktop-note-received', rotated_note)
    notes.append({'path': rotated_note['path'], 'text': rotated_note['text']})
    new_phone = note_from_phone('rotated-phone', '# Synthetic rotated Android\n\nCurrent generation native phone bytes.\n')
    desk('rotated-phone-note-received', 'read-note', 'rotated-phone'); notes.append(new_phone)
    both_bytes('rotation')
    retained = core_notes[0]
    history = phone('ordinary-previous-generation-history', 'previous-history-restore', {'note': retained['path'], 'text': retained['text'],
        'expectedGenerationHash': new_status['generationHash'], 'expectedOldGenerationHash': old_status['generationHash']})
    require(all(history.get(name) is True for name in ('explicitPreviousGenerationUi', 'ordinaryRestoreCopy', 'knownRetainedBytesMatch',
        'currentNoteUnchanged', 'independentAdbBytesBeforeEditor')) and history.get('restoredFixtureFile') == 'private/android-history-restored.json',
        'explicit_previous_history_independent_bytes')
    restored = private(android / 'private/android-history-restored.json')
    expected_sha = hashlib.sha256(retained['text'].encode()).hexdigest()
    require(restored.get('sourceHead') == c['sourceHead'] and restored.get('text') == retained['text'] and restored.get('sha256') == expected_sha
            and re.fullmatch(re.escape(retained['path'].removesuffix('.md')) + r' \(restored-[a-f0-9]{32}\)\.md', restored.get('path', '')),
            'source_bound_generated_history_copy', 'OUTCOME_MISMATCH')
    save(desktop / 'private/desktop/note-history-restored.json', {key: restored[key] for key in ('path', 'text', 'sha256')})
    notes.append({'path': restored['path'], 'text': restored['text']})
    both_bytes('rotation-history')
    rotated_before = phone('rotated-phone-before-restart', 'status', {'expectedGenerationHash': new_status['generationHash'], 'requireIdle': True})
    rotated_launch = life('rotated-phone-real-process-restart', 'restart-app', ('RESTARTED',))
    require(rotated_launch.get('oldProcessAndSocketAbsent') is True and rotated_launch.get('freshDevtoolsSocket') is True
            and rotated_launch.get('appDataReset') is False, 'postrotation_android_real_restart')
    phone('rotated-vault-after-restart', 'wait-vault', {})
    rotated_idle = phone('rotated-phone-persisted-current-enrollment', 'status', {'expectedGenerationHash': new_status['generationHash'],
        'expectedCredentialHash': rotated_before['credentialHash'], 'requireIdle': True})
    rotated_idle_ms = launch_to_idle(require, rotated_launch, rotated_idle)
    phone('rotated-phone-persisted-history', 'rotation-pair-status', {'expectedGenerationHash': new_status['generationHash'], 'expectedOldGenerationHash': old_status['generationHash']})
    both_bytes('rotation-restart'); metadata('rotation')
    receipt('rotation-recovery', wholeJournalUnchangedAcrossBothRestarts=True, preparedRestart=True, commitUnknownRestart=True, normalQuitRequired=True, retainedHistory=True, detachedNativeCipherOracle=True,
        postrotationPhoneRestart=True, postrotationLaunchToIdleMs=rotated_idle_ms, preexistingIndependentBytesAfterRotationRestart=True,
        previousGenerationHistoryUi='RESTORE_COPY', knownRetainedHistoryBytes=True, currentOriginalUnchanged=True)

    # Desktop direct recase; Android two explicit ordinary renames. The pinned
    # official mobile UI refuses a direct recase on its shared filesystem.
    native('selected-folder-seed', 'selected-fixtures.mjs', 'seed', results=('PREPARED',))
    selected = [private(desktop / ('private/desktop/note-selected-' + name + '.json')) for name in ('one', 'two')]
    for i, note in enumerate(selected): phone_reads('selected-seed-read-' + str(i), note)
    selected_exports = [both_bytes('selected-seed', selected)]
    def selected_bytes(label, folder):
        selected_exports.append(both_bytes('selected-' + label, [{**note, 'path': folder + '/' + note['path'].split('/')[-1]} for note in selected]))
    snapshots = []
    native('desktop-save-selected-policy', 'selected-desktop.mjs', 'scope')
    phone('android-save-selected-policy', 'scope-selected', {'folders': ['Team docs']})
    native('desktop-fresh-excluded-control', 'selected-fixtures.mjs', 'outside', results=('OBSERVED',))
    phone('phone-fresh-excluded-control', 'fixture-provision', {'path': 'Outside/Phone-sentinel.md', 'text': '# Outside Android\n\nSynthetic excluded phone control.\n'})
    phone_before = android / 'private/folder-before-desktop-rename.json'
    require(phone('android-selected-before-desktop-rename', 'folder-snapshot', {'folder': 'Team docs', 'output': str(phone_before)}).get('descendants') == 2, 'exact_two_selected_descendants')
    snapshots.extend(native('desktop-ordinary-selected-rename', 'selected-desktop.mjs', 'rename')['retainedSnapshots'])
    require(phone('android-passive-selected-rename', 'folder-verify', {'folder': 'team docs', 'oldFolder': 'Team docs', 'beforeSnapshot': str(phone_before)}).get('descendants') == 2, 'exact_two_passive_selected_descendants')
    snapshots.extend(native('desktop-selected-stable-before', 'selected-desktop.mjs', 'before')['retainedSnapshots'])
    selected_bytes('down', 'team docs')
    def selected_boundary(label, folder):
        phone(label, 'selected-boundaries', {'folder': folder, 'outsideLocal': 'Outside/Phone-sentinel.md',
            'outsideAbsent': 'Outside/Sentinel.md', 'outsideText': '# Outside Android\n\nSynthetic excluded phone control.\n'})
    selected_boundary('android-boundary-after-desktop-rename', 'team docs')
    down = native('selected-five-minute-watch-desktop-origin', 'selected-desktop.mjs', 'watch-down', timeout=420)
    require(down.get('watchMs', 0) >= 300000, 'desktop_origin_selected_watch')
    snapshots.extend(down['retainedSnapshots']); selected_bytes('down-quiet', 'team docs')
    selected_boundary('android-boundary-after-desktop-origin-watch', 'team docs')
    rename_ms = android_case_rename(require, phone('android-ordinary-selected-rename-back',
        'folder-case-rename', {'from': 'team docs', 'to': 'Team docs'}))
    snapshots.extend(native('desktop-passive-selected-rename-back', 'selected-desktop.mjs', 'returned')['retainedSnapshots'])
    selected_bytes('up', 'Team docs')
    selected_boundary('android-boundary-after-android-rename', 'Team docs')
    up = native('selected-five-minute-watch-android-origin', 'selected-desktop.mjs', 'watch-up', timeout=420)
    require(up.get('watchMs', 0) >= 300000, 'android_origin_selected_watch')
    snapshots.extend(up['retainedSnapshots']); selected_bytes('up-quiet', 'Team docs')
    selected_boundary('android-boundary-after-android-origin-watch', 'Team docs')
    selected_evidence(desktop, c['sourceHead'], {'retainedByteExports': selected_exports, 'retainedServerSnapshots': snapshots})
    receipt('selected-rename', retainedByteExports=selected_exports, retainedServerSnapshots=snapshots, ordinaryDesktopRename=True, ordinaryAndroidRename=True, noteIdentityAndBytesPreserved=True,
        androidRenameWorkflow='TWO_ORDINARY_RENAMES', androidOrdinaryRenameCount=2,
        directAndroidCaseRename=False, androidIntermediateAbsent=True, androidRenameElapsedMs=rename_ms,
        priorHistoryAndAncestryPreserved=True, postConvergenceHeadsAndVersionsFrozen=True,
        excludedControlsCreatedAfterScope=True, desktopOriginWatchMs=down['watchMs'], androidOriginWatchMs=up['watchMs'], trashEmpty=True)
    metadata('selected')

    # Fresh B/D/C recovery: all enrolled peers stopped, existing server retained.
    state = controller.live_state(android); old_pid = controller.stopped_app(state)
    require(type(old_pid) is int and old_pid > 1, 'last_owned_android_pid')
    desk('ordinary-quit-last-enrolled-desktop', 'quit')
    expected_notes = [notes[0], {'path': rotated_note['path'], 'text': rotated_note['text']}]
    require(expected_notes[0]['path'] != expected_notes[1]['path'], 'distinct_retained_and_current_notes')
    save(desktop / 'private/recovery-expectations.json', {'schema': 1, 'sourceHead': c['sourceHead'], 'generationHash': new_status['generationHash'],
        'notes': [{'path': n['path'], 'sha256': hashlib.sha256(n['text'].encode()).hexdigest(), 'generation': g}
                  for n, g in zip(expected_notes, ('retained', 'current'))]})
    def recovery(slot, command, backup=None, results=('PASS',)):
        return native('recovery-' + slot.lower() + '-' + command + ('-' + backup if backup else ''), 'recovery.mjs', slot, command,
                      *([backup] if backup else []), results=results)
    def journal(slot, case, when):
        steps.run('journal-' + slot.lower() + '-' + case + '-' + when, [sys.executable, '-B', helper('mobile-journal.py'), when,
            '--run', str(desktop), '--slot', slot, '--case', case], results=('BASELINE_CAPTURED',) if when == 'before' else ('PASS',))
    request('provision-recovery', 'fresh-B', {'device': 'B', 'androidRun': str(android), 'androidOldPid': old_pid}, 'PROVISIONED')
    recovery('B', 'open', results=('READY',)); recovery('B', 'stage', 'old', ('STAGED',))
    journal('B', 'old-backup', 'before'); recovery('B', 'setup-refuse-old'); journal('B', 'old-backup', 'after')
    recovery('B', 'quit', results=('QUIT_REQUESTED',))
    request('provision-recovery', 'fresh-D', {'device': 'D', 'androidRun': str(android), 'androidOldPid': old_pid}, 'PROVISIONED')
    recovery('D', 'open', results=('READY',)); recovery('D', 'make-unrelated')
    recovery('D', 'stage', 'unrelated', ('STAGED',)); journal('D', 'unrelated-backup', 'before')
    recovery('D', 'setup-refuse-wrong'); journal('D', 'unrelated-backup', 'after')
    recovery('D', 'quit', results=('QUIT_REQUESTED',))
    request('provision-recovery', 'fresh-C', {'device': 'C', 'androidRun': str(android), 'androidOldPid': old_pid}, 'PROVISIONED')
    recovery('C', 'open', results=('READY',)); recovery('C', 'stage', 'wrong'); recovery('C', 'stage', 'stripped')
    recovery('C', 'stage', 'new', ('STAGED',)); journal('C', 'wrong-token', 'before')
    recovery('C', 'setup-wrong-token'); journal('C', 'wrong-token', 'after')
    recovery('C', 'setup-correct'); recovery('C', 'readback')
    receipt('fresh-recovery-J11', pairedPeersStopped=True, freshDesktopB=True, freshDesktopC=True, oldBackupRefused=True,
        freshDesktopD=True, validUnrelatedBackupRefused=True, unrelatedBackupJournalUnchanged=True,
        wrongTokenJournalUnchanged=True, completeNewBackupRecovery=True)

    directory = desktop / 'private/desktop'
    save(desktop / 'private/confidentiality-inputs.json', {'schema': 1, 'sourceHead': c['sourceHead'],
        'notes': sorted(str(p.relative_to(desktop)) for p in directory.glob('note-*.json')),
        'backups': ['private/desktop/phone-old-recovery-backup.txt', 'private/desktop/phone-new-recovery-backup.txt', 'private/desktop/phone-unrelated-recovery-backup.txt'],
        'nativeCaptures': sorted(str(p.relative_to(desktop)) for p in directory.glob('ciphertext-*.json')),
        'pairingCodes': sorted(str(p.relative_to(desktop)) for p in directory.glob('**/*pair-code.txt')),
        'androidMetadata': sorted(str(p.relative_to(desktop)) for p in (desktop / 'private').glob('android-metadata-*.json'))})
    save(desktop / 'evidence/full-native-journeys.json', {'schema': 1, 'result': 'PASS', 'sourceHead': c['sourceHead'], 'journeys': phases,
        'acceptance': 'PENDING_CLOSED_CAPTURE_SCAN_AND_OWNED_CLEANUP', 'physicalPhone': 'NOT_RUN'})
