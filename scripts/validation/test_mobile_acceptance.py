"""Offline stage admission: no app, emulator, server or device is launched."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mobile_acceptance', Path(__file__).with_name('mobile-acceptance.py'))
RUNNER = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(RUNNER)
FULL_SPEC = importlib.util.spec_from_file_location('mobile_full', Path(__file__).with_name('mobile-full.py'))
FULL = importlib.util.module_from_spec(FULL_SPEC); FULL_SPEC.loader.exec_module(FULL)
HEAD = 'a' * 40
if os.environ.get('OBSYNC_ACCEPTANCE_TEST_CONTROLLER'):
    controller_spec = importlib.util.spec_from_file_location('test_owned_controller', os.environ['OBSYNC_ACCEPTANCE_TEST_CONTROLLER'])
    controller = importlib.util.module_from_spec(controller_spec); controller_spec.loader.exec_module(controller)
    RUNNER.load_controller = lambda: controller


def phase_fixture():
    # Explicit producer contract; manufactured receipts are structural controls.
    return {
        'quiet': {'elapsedMs':213000,'androidCallsDuringInterval':0,'historiesAndHeadsUnchanged':True},
        'restart': {'processRestart':True,'guestReboot':True,'physicalDeviceReboot':'NOT_RUN','persistedEnrollment':True,
            'activeDesktopNormalQuitRestart':True,'desktopLaunchToIdleMs':1200,'androidLaunchToIdleMs':2400,
            'noSetupPairingOrSyncNowAction':True,'preexistingIndependentBytes':True},
        'background-offline': {'privateRouteRemovedAndRestored':True,'pendingNotesBothDirections':True,
            'existingTlsSocketsGracefullyDrained':True,'tlsGateResumed':True,
            'faultClass':'OWNED_ANDROID_ROUTE_OFFLINE','certificateValidation':'NOT_TESTED_BY_ROUTE_GATE'},
        'access-repair': {'revokedTransportRefused':True,'oldRootDirectCipherPositive':'REQUIRED_ORACLE_AFTER_ROTATION',
            'ordinaryLeavePreservedBytes':True,'freshIndependentSas':True},
        'rotation-recovery': {'wholeJournalUnchangedAcrossBothRestarts':True,'preparedRestart':True,'commitUnknownRestart':True,'normalQuitRequired':True,'retainedHistory':True,
            'detachedNativeCipherOracle':True,'postrotationPhoneRestart':True,'postrotationLaunchToIdleMs':2400,
            'preexistingIndependentBytesAfterRotationRestart':True,'previousGenerationHistoryUi':'RESTORE_COPY',
            'knownRetainedHistoryBytes':True,'currentOriginalUnchanged':True},
        'selected-rename': {'ordinaryDesktopRename':True,'ordinaryAndroidRename':True,'noteIdentityAndBytesPreserved':True,
            'androidRenameWorkflow':'TWO_ORDINARY_RENAMES','androidOrdinaryRenameCount':2,'directAndroidCaseRename':False,
            'androidIntermediateAbsent':True,'androidRenameElapsedMs':8000,
            'priorHistoryAndAncestryPreserved':True,'postConvergenceHeadsAndVersionsFrozen':True,'excludedControlsCreatedAfterScope':True,
            'desktopOriginWatchMs':300000,'androidOriginWatchMs':300000,'trashEmpty':True},
        'fresh-recovery-J11': {'pairedPeersStopped':True,'freshDesktopB':True,'freshDesktopC':True,'oldBackupRefused':True,
            'freshDesktopD':True,'validUnrelatedBackupRefused':True,'unrelatedBackupJournalUnchanged':True,
            'wrongTokenJournalUnchanged':True,'completeNewBackupRecovery':True},
    }


class Admission(unittest.TestCase):
    def test_android_case_workflow_requires_both_actions_original_bytes_and_remaining_budget(self):
        proof = {'result':'PASS','workflow':'TWO_ORDINARY_RENAMES','ordinaryRenameCount':2,
            'intermediateAbsent':True,'originalAbsent':True,'originalBaselinePreserved':True,'finalFolder':'Team docs',
            'sharedBudgetMs':180000,'directSingleStepCaseRename':False,'independentAdbDirectory':True,
            'descendants':2,'elapsedMs':8000}
        self.assertEqual(FULL.android_case_rename(RUNNER.require, proof), 8000)
        for key, value in proof.items():
            for broken in ({k:v for k,v in proof.items() if k!=key},
                           proof | {key:not value if type(value) is bool else True if type(value) is int else 'wrong'}):
                with self.assertRaises(RUNNER.StageFailure, msg=key): FULL.android_case_rename(RUNNER.require, broken)
        for elapsed in (-1,180000,180001):
            with self.assertRaises(RUNNER.StageFailure): FULL.android_case_rename(RUNNER.require, proof | {'elapsedMs':elapsed})

    def test_launch_to_idle_uses_actual_launch_and_bounded_later_observation(self):
        self.assertEqual(FULL.launch_to_idle(RUNNER.require, {'launchStartedAtEpochMs': 1000}, {'idleObservedAtEpochMs': 1200}), 200)
        for launch, idle in [({}, {}), ({'launchStartedAtEpochMs': 1000}, {}),
                            ({'launchStartedAtEpochMs': 1000}, {'idleObservedAtEpochMs': 999}),
                            ({'launchStartedAtEpochMs': 1000}, {'idleObservedAtEpochMs': 121001}),
                            ({'launchStartedAtEpochMs': True}, {'idleObservedAtEpochMs': 1000})]:
            with self.assertRaisesRegex(RUNNER.StageFailure, 'actual_launch_to_automatic_idle_120000ms'):
                FULL.launch_to_idle(RUNNER.require, launch, idle)

    def test_every_explicit_driver_and_shared_control_is_bound(self):
        with tempfile.TemporaryDirectory(prefix='obsync-driver-binding-') as temporary:
            root = Path(temporary).resolve(); validation = root / 'scripts/validation'; validation.mkdir(parents=True)
            source = root / 'candidate'; (source / 'scripts/ci').mkdir(parents=True)
            (root / 'scripts/ci').mkdir(parents=True)
            paths = {}
            for name in RUNNER.CORE_HELPERS:
                path = validation / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
                paths[name] = path
            controls = [root / 'scripts/ci' / name for name in ('obsidian-drive.mjs', 'obsidian-evidence.mjs', 'obsidian-redirect.mjs')]
            for path in controls: path.write_text('exact ' + path.name)
            observer = source / 'scripts/ci/observer.mjs'; observer.write_text('exact observer')
            with patch.object(RUNNER, 'HERE', validation):
                inventory = RUNNER.driver_inventory('core', source)
                self.assertEqual(len(inventory), len(RUNNER.CORE_HELPERS) + 4)
                for path in [*paths.values(), *controls, observer]:
                    original = path.read_bytes(); path.write_bytes(original + b' changed')
                    with self.assertRaisesRegex(RUNNER.StageFailure, 'driver_changed'):
                        RUNNER.recheck_drivers('core', source, inventory)
                    path.write_bytes(original)
                RUNNER.recheck_drivers('core', source, inventory)

    def test_postmkdir_port_failure_retains_actionable_result(self):
        with tempfile.TemporaryDirectory(prefix='obsync-port-preflight-') as temporary:
            root = Path(temporary).resolve(); config = root / 'config.json'; output = root / 'fresh-output'
            RUNNER.save(config, {'source': str(Path(__file__).resolve().parents[2]), 'sourceHead': HEAD, 'android': {'port': 5586}})
            with patch.object(sys, 'argv', ['mobile-acceptance.py', '--config', str(config), '--out', str(output), '--runs', '1', '--mode', 'core']), \
                 patch.object(RUNNER.shutil, 'disk_usage', return_value=type('Space', (), {'free': 30 * 1024**3})()):
                with self.assertRaisesRegex(RUNNER.StageFailure, 'android_emulator_port_5554_to_5584_even'):
                    RUNNER.main()
            result = json.loads((output / 'result.json').read_text())
            self.assertEqual(result['result'], 'FAIL')
            self.assertEqual(result['firstFailure'], 'android_emulator_port_5554_to_5584_even')
            self.assertEqual(result['failureClass'], 'AUTOMATION_FAILURE')
            self.assertEqual(result['completedRuns'], 0)
            self.assertFalse(list(output.glob('attempt-*')))

    def test_three_core_runs_never_advertise_full_acceptance(self):
        rows = [{'attempt': str(i), 'result': 'CORE_ONLY', 'cleanup': 'PASS'} for i in range(3)]
        result = RUNNER.summary(rows, 3, 'core', HEAD)
        self.assertEqual(result['result'], 'CORE_ONLY')
        self.assertEqual(result['fullAcceptance'], 'NOT_RUN')
        self.assertFalse(result['threeFreshFullRunsPassed'])
        for index in range(3):
            changed = [dict(row) for row in rows]; changed[index]['result'] = 'FAIL'
            self.assertEqual(RUNNER.summary(changed, 3, 'core', HEAD)['result'], 'FAIL')

    def test_full_three_requires_fresh_successful_clean_attempts(self):
        rows = [{'attempt': str(i), 'result': 'FULL_PASS', 'cleanup': 'PASS'} for i in range(3)]
        self.assertTrue(RUNNER.summary(rows, 3, 'full', HEAD)['threeFreshFullRunsPassed'])
        for field, value in [('result', 'CORE_ONLY'), ('cleanup', 'UNKNOWN'), ('attempt', '0')]:
            changed = [dict(row) for row in rows]; changed[1][field] = value
            self.assertFalse(RUNNER.summary(changed, 3, 'full', HEAD)['threeFreshFullRunsPassed'])
        self.assertFalse(RUNNER.summary(rows[:2], 3, 'full', HEAD)['threeFreshFullRunsPassed'])
        self.assertEqual(set(RUNNER.FULL_JOURNEYS), set(RUNNER.IMPLEMENTED_FULL_JOURNEYS))

    def test_full_receipt_requires_every_independent_phase_file(self):
        with tempfile.TemporaryDirectory(prefix='obsync-full-admission-') as temporary:
            root = Path(temporary).resolve(); (root / 'evidence').mkdir(mode=0o700)
            main = {'schema': 1, 'sourceHead': HEAD, 'result': 'PASS', 'journeys': list(RUNNER.FULL_NATIVE_PHASES)}
            RUNNER.save(root / 'evidence/full-native-journeys.json', main)
            for phase in RUNNER.FULL_NATIVE_PHASES:
                RUNNER.save(root / 'evidence' / ('full-' + phase + '.json'), {'schema':1,'sourceHead': HEAD, 'result': 'PASS',**phase_fixture()[phase]})
            RUNNER.full_journey_receipt(root, HEAD)
            for phase,facts in phase_fixture().items():
                path=root/'evidence'/('full-'+phase+'.json');original=path.read_bytes()
                for key,value in facts.items():
                    for broken in ({k:v for k,v in facts.items() if k!=key}, facts|{key:not value if type(value) is bool else True if type(value) is int else 'PASS'}):
                        path.write_text(json.dumps({'schema':1,'sourceHead':HEAD,'result':'PASS',**broken}))
                        with self.assertRaises(RUNNER.StageFailure,msg=phase+':'+key):RUNNER.full_journey_receipt(root,HEAD)
                    path.write_bytes(original)
            for phase,key,value in [('quiet','elapsedMs',212999),('restart','desktopLaunchToIdleMs',120001),
                ('restart','androidLaunchToIdleMs',-1),('rotation-recovery','postrotationLaunchToIdleMs',120001),
                ('selected-rename','desktopOriginWatchMs',299999),('selected-rename','androidOriginWatchMs',299999),
                ('selected-rename','androidRenameElapsedMs',180000)]:
                path=root/'evidence'/('full-'+phase+'.json');original=path.read_bytes()
                path.write_text(json.dumps({'schema':1,'sourceHead':HEAD,'result':'PASS',**(phase_fixture()[phase]|{key:value})}))
                with self.assertRaises(RUNNER.StageFailure):RUNNER.full_journey_receipt(root,HEAD)
                path.write_bytes(original)
            for phase in RUNNER.FULL_NATIVE_PHASES:
                path = root / 'evidence' / ('full-' + phase + '.json'); original = path.read_bytes(); path.unlink()
                with self.assertRaises(FileNotFoundError): RUNNER.full_journey_receipt(root, HEAD)
                path.write_bytes(original); path.chmod(0o600)
                path.write_text(json.dumps({'result': 'PASS', 'sourceHead': 'b' * 40}))
                with self.assertRaises(RUNNER.StageFailure): RUNNER.full_journey_receipt(root, HEAD)
                path.write_bytes(original)

    def test_cleanup_labels_follow_measured_runtime_cleanup_not_target_kind(self):
        self.assertEqual(RUNNER.summary([],3,'full',HEAD)['deviceFixtureCleanup'],'NOT_RUN')
        for cleanup in ('FAIL','UNKNOWN',None):
            row={'attempt':'01','result':'FAIL','cleanup':cleanup}
            result=RUNNER.summary([row],3,'full',HEAD)
            self.assertEqual(result['deviceFixtureCleanup'],'UNKNOWN');self.assertEqual(result['result'],'FAIL')
        result=RUNNER.summary([{'attempt':'01','result':'FAIL','cleanup':'PASS'}],3,'full',HEAD)
        self.assertEqual(result['deviceFixtureCleanup'],'OWNED_RUNTIME_REMOVED');self.assertEqual(result['result'],'FAIL')
        self.assertEqual(RUNNER.summary([],1,'core',HEAD,'usb')['deviceFixtureCleanup'],'NOT_ASSERTED')

    def test_cleanup_requires_every_resulting_state_fact(self):
        proof = {'cleanup': 'PASS', 'ownedGroupsRemaining': 0, 'runtimeAbsent': True,
                 'privateAbsent': True, 'manifestAbsent': True}
        self.assertTrue(RUNNER.clean_controller(proof))
        for field in proof:
            changed = dict(proof); changed.pop(field)
            self.assertFalse(RUNNER.clean_controller(changed), field)

    def test_controller_failure_names_installation_and_never_copies_diagnostics(self):
        proof = {'result':'PASS','sourceHead':HEAD,'cleanup':'PASS','ownedGroupsRemaining':0,
                 'runtimeAbsent':True,'privateAbsent':True,'manifestAbsent':True}
        RUNNER.require_android_controller(proof,0,HEAD)
        for change,code,expected in [({'result':'FAIL','failure':{'stage':'install','detail':'private value'}},1,'install'),
                                    ({'result':'FAIL','failure':{'stage':'private value'}},1,'terminal'),
                                    ({},1,'terminal'),({'cleanup':'FAIL'},0,'cleanup'),
                                    ({'sourceHead':'b'*40},0,'source')]:
            with self.subTest(expected=expected),self.assertRaises(RUNNER.StageFailure) as failure:
                RUNNER.require_android_controller(proof|change,code,HEAD)
            self.assertEqual(failure.exception.stage,'android_controller_'+expected)
            self.assertEqual(failure.exception.failure_class,'UNCLASSIFIED')

    def test_attempt_cleanup_requires_both_started_controllers(self):
        clean = {'cleanup':'PASS','ownedGroupsRemaining':0,'runtimeAbsent':True,'privateAbsent':True,'manifestAbsent':True}
        with tempfile.TemporaryDirectory(prefix='obsync-cleanup-admission-') as temporary:
            android=Path(temporary).resolve()/'android'
            self.assertEqual(RUNNER.attempt_cleanup(clean,android),'PASS')
            (android/'evidence').mkdir(parents=True)
            self.assertEqual(RUNNER.attempt_cleanup(clean,android),'UNKNOWN')
            receipt=android/'evidence/result.json';RUNNER.save(receipt,clean)
            self.assertEqual(RUNNER.attempt_cleanup(clean,android),'PASS')
            for change in [{'cleanup':'FAIL'},{'ownedGroupsRemaining':1},{'runtimeAbsent':False}]:
                receipt.write_text(json.dumps(clean|change))
                self.assertEqual(RUNNER.attempt_cleanup(clean,android),'FAIL')
            self.assertEqual(RUNNER.attempt_cleanup(clean|{'cleanup':'FAIL'},android),'FAIL')

    def test_first_failed_step_retained_and_generic_negative_stays_observed(self):
        with tempfile.TemporaryDirectory(prefix='obsync-runner-control-') as temporary:
            attempt = Path(temporary).resolve()
            for name in ['private', 'evidence']: (attempt / name).mkdir(mode=0o700)
            steps = RUNNER.Steps(attempt, HEAD)
            steps.run('positive', [sys.executable, '-c', 'print(\'{"result":"PASS"}\')'])
            steps.run('generic-negative', [sys.executable, '-c', 'print(\'{"result":"FAIL"}\'); raise SystemExit(1)'],
                      ('FAIL',), negative=True)
            observed = json.loads((attempt / 'evidence/002-generic-negative.json').read_text())
            self.assertEqual(observed['result'], 'OBSERVED')
            with self.assertRaisesRegex(RUNNER.StageFailure, 'wrong-result'):
                steps.run('wrong-result', [sys.executable, '-c', 'print(\'{"result":"OBSERVED"}\')'])
            failed = json.loads((attempt / 'evidence/003-wrong-result.json').read_text())
            self.assertEqual(failed['result'], 'FAIL')
            self.assertEqual(failed['failureClass'], 'UNCLASSIFIED')
            self.assertTrue((attempt / 'evidence/001-positive.json').exists())
            with self.assertRaisesRegex(RUNNER.StageFailure, 'missing-json'):
                steps.run('missing-json', [sys.executable, '-c', 'print("not a receipt")'])
            self.assertEqual(json.loads((attempt / 'evidence/004-missing-json.json').read_text())['result'], 'FAIL')
            with self.assertRaisesRegex(RUNNER.StageFailure, 'timed-out'):
                steps.run('timed-out', [sys.executable, '-c', 'import time; time.sleep(30)'], timeout=.1)
            timeout = json.loads((attempt / 'evidence/005-timed-out.json').read_text())
            self.assertEqual(timeout['result'], 'FAIL')
            self.assertEqual(timeout['helperFailure'], 'helper_timeout')
            steps.run('leader-exited-with-live-descendant', [sys.executable, '-c',
                'import subprocess,sys; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); print(\'{"result":"PASS"}\')'])
            with self.assertRaises(RUNNER.StageFailure) as rejected:
                steps.run('independent-mismatch', [sys.executable, '-c', 'print(\'{"result":"FAIL","failureClass":"OUTCOME_MISMATCH"}\'); raise SystemExit(1)'])
            self.assertEqual(rejected.exception.failure_class, 'OUTCOME_MISMATCH')
            mismatch = json.loads((attempt / 'evidence/007-independent-mismatch.json').read_text())
            self.assertEqual(mismatch['failureClass'], 'OUTCOME_MISMATCH')
            self.assertEqual(mismatch['childFailureClass'], 'OUTCOME_MISMATCH')
            with self.assertRaises(RUNNER.StageFailure) as generic:
                steps.run('generic-refusal', [sys.executable, '-c', 'print(\'{"result":"FAIL","failureClass":"AUTOMATION_OR_ORACLE_REFUSAL"}\'); raise SystemExit(1)'])
            self.assertEqual(generic.exception.failure_class, 'AUTOMATION_OR_ORACLE_REFUSAL')


if __name__ == '__main__': unittest.main()
