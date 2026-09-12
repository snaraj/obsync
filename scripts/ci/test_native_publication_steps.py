"""Execute native-release publication against a closed, file-backed REST model.

The real workflow shell and release validator run. Only gh/curl/sleep are
replaced; unexpected calls fail, and the model never opens a network socket.
Lost responses, partial uploads and changed download bytes must be settled
from readback before publication can count as success.
"""

import base64
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml
import release_contract as contract
from test_community_release import VERSION, bundle, digest, native_arguments
from test_release_contract import Repository, locks, main_run_record

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/release-publisher.yml"

REST_MODEL = r'''#!/usr/bin/env python3
import base64, hashlib, json, os, sys
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

args = sys.argv[1:]
tool = Path(sys.argv[0]).name
path = Path(os.environ['MODEL_STATE'])
state = json.loads(path.read_text())
scenario = os.environ.get('MODEL_SCENARIO', '')
actor = {'login': 'github-actions[bot]', 'id': 41898282}
def done(code=0, output=''):
    path.write_text(json.dumps(state))
    sys.stdout.write(output)
    raise SystemExit(code)
def argument(flag):
    return args[args.index(flag) + 1]
def record(operation):
    state['calls'].append(operation)
if tool == 'sleep':
    done()
if tool == 'docker':
    assert args[:2] == ['buildx', 'build'] and argument('--target') == 'bundle'
    assert argument('--platform') == 'linux/amd64'
    prefix = 'type=local,dest='
    assert argument('--output').startswith(prefix)
    destination = Path(argument('--output')[len(prefix):])
    assert destination.parent == Path(os.environ['RUNNER_TEMP'])
    destination.mkdir()
    for member in Path(os.environ['PLUGIN_DIRECTORY']).iterdir():
        assert member.is_file() and member.name in ('main.js', 'manifest.json', 'styles.css')
        (destination / member.name).write_bytes(member.read_bytes())
    record('export-bundle'); done()
if tool in ('cosign', 'trivy'):
    assert args[-1] in state['signed_targets']
    record(tool + ':' + args[-1]); done()
if tool == 'gh':
    if args[:2] == ['attestation', 'verify']:
        member = Path(args[2])
        record('attestation:' + member.name)
        path.write_text(json.dumps(state))
        expected = state['provenance']
        required = {
            '--repo': 'snaraj/obsync',
            '--cert-identity': 'https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main',
            '--cert-oidc-issuer': 'https://token.actions.githubusercontent.com',
            '--source-ref': 'refs/heads/main',
            '--source-digest': expected['source_sha'],
            '--signer-digest': expected['source_sha'],
            '--predicate-type': 'https://slsa.dev/provenance/v1',
        }
        assert all(argument(flag) == value for flag, value in required.items())
        assert '--deny-self-hosted-runners' in args
        assert hashlib.sha256(member.read_bytes()).hexdigest() == expected['files'][member.name]
        if '--bundle' in args:
            assert Path(argument('--bundle')).read_text() == 'SENTINEL-BUILD-BUNDLE'
        done(1 if scenario == 'attestation:' + member.name else 0)
    if args[:2] == ['api', '--method'] and args[2] == 'GET':
        record('read-api:' + args[-1])
        done(output=json.dumps(state['api'][args[-1]]))
    if args[:2] == ['release', 'create']:
        assert state['release'] is None
        assert '--draft' in args and '--verify-tag' in args
        record('create')
        state['release'] = dict(id=42, author=actor, tag_name=args[2], name=argument('--title'),
                                body=Path(argument('--notes-file')).read_text(), draft=True,
                                immutable=False, prerelease=False, assets=[])
        if scenario.startswith('release-id:'):
            state['release']['id'] = json.loads(scenario.split(':', 1)[1])
        done(1 if scenario == 'lost-create-response' else 0)
    if args[:2] == ['release', 'edit']:
        assert args[2] == os.environ['TAG'] and '--draft=false' in args
        assert state['release']['draft'] and len(state['release']['assets']) == 5
        record('publish')
        state['release'].update(draft=False, immutable=True)
        done(1 if scenario == 'lost-publish-response' else 0)
    raise AssertionError('Unexpected gh operation')
assert tool == 'curl', 'Unexpected tool'
url = urlsplit(args[-1])
if url.netloc == 'ghcr.io':
    assert url.scheme == 'https'
    if url.path == '/token':
        done(output='{"token":"SENTINEL"}')
    record('alias:' + url.path)
    done(output='Docker-Content-Digest: ' + state['aliases'][url.path] + '\r\n')
output = Path(argument('--output'))
if '--data-binary' in args:
    record('upload-request')
    path.write_text(json.dumps(state))
    assert url.scheme == 'https' and url.netloc == 'uploads.github.com'
    assert url.path == '/repos/snaraj/obsync/releases/42/assets'
    name = parse_qs(url.query)['name'][0]
    assert not any(item['name'] == name for item in state['release']['assets'])
    assert state['release']['draft'] and not state['release']['immutable']
    record('upload:' + name)
    if scenario == 'upload-refused' and name == 'styles.css':
        output.write_text('{}'); done(22)
    data = Path(argument('--data-binary')[1:]).read_bytes()
    content_type = next(value.split(': ', 1)[1] for value in args if value.startswith('Content-Type: '))
    file_digest = 'sha256:' + hashlib.sha256(data).hexdigest()
    asset = dict(name=name, uploader=actor, state='uploaded', size=len(data),
                 digest=file_digest, content_type=content_type,
                 url='https://api.github.com/model-assets/' + name)
    if scenario == 'foreign-digest' and name == 'main.js':
        asset['digest'] = 'sha256:' + 'f' * 64
    state['release']['assets'].append(asset)
    state['files'][name] = base64.b64encode(data).decode()
    output.write_text(json.dumps(asset)); done()
assert url.scheme == 'https' and url.netloc == 'api.github.com'
if url.path.startswith('/model-assets/'):
    name = url.path.rsplit('/', 1)[1]
    record('download:' + name)
    data = base64.b64decode(state['files'][name])
    if (scenario == 'changed-download' and name == 'main.js') or scenario == 'changed:' + name:
        data += b'changed'
    output.write_bytes(data); done()
if url.path == '/repos/snaraj/obsync/releases/tags/' + os.environ['TAG']:
    record('read-release')
    release = state['release']
    # GitHub's by-tag endpoint does not resolve an unpublished draft.
    present = release is not None and not release['draft']
    output.write_text(json.dumps(release if present else {}))
    done(output='200' if present else '404')
if url.path == '/repos/snaraj/obsync/releases' and url.query == 'per_page=100':
    record('list-releases')
    output.write_text(json.dumps([] if state['release'] is None else [state['release']]))
    done(output='200')
raise AssertionError('Unexpected REST operation')
'''


class NativePublicationSteps(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        document = miniyaml.load_one(WORKFLOW.read_text())
        cls.steps = {step.get('name'): step for job in document['jobs'].values()
                     for step in job.get('steps', [])}
        for name in ['bash', 'jq', 'python3', 'sha256sum']:
            if shutil.which(name) is None:
                raise AssertionError(f'{name} is required for the real publication shell')

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        bins, temp, files = [self.root / name for name in ['bin', 'temp', 'files']]
        for path in [bins, temp, files]:
            path.mkdir()
        for name in ['gh', 'curl', 'sleep', 'cosign', 'trivy', 'docker']:
            path = bins / name
            path.write_text(REST_MODEL)
            path.chmod(0o755)
        data = bundle()
        archive = self.root / f'obsync-plugin-{VERSION}.zip'
        archive.write_bytes(data)
        with zipfile.ZipFile(archive) as source:
            for name in contract.PLUGIN_FILES:
                (files / name).write_bytes(source.read(name))
        args = native_arguments(data)
        evidence = self.root / f'obsync-{VERSION}-release-manifest.json'
        evidence.write_bytes(contract._canonical_json(contract.build_release_manifest(**args)))
        self.state = self.root / 'state.json'
        self.state.write_text(json.dumps(dict(release=None, files={}, calls=[])))
        self.env = dict(PATH=f'{bins}{os.pathsep}{os.environ["PATH"]}', LANG='C',
                        RUNNER_TEMP=str(temp), MODEL_STATE=str(self.state),
                        GH_TOKEN='SENTINEL', GITHUB_API_URL='https://api.github.com',
                        GITHUB_REPOSITORY='snaraj/obsync', SOURCE_SHA=args['source_sha'],
                        MAIN_RUN_ID=str(args['main_run_id']), VERSION=VERSION, TAG=VERSION,
                        IMAGE=args['image'], CHART=args['chart'], IMAGE_DIGEST=args['image_digest'],
                        CHART_DIGEST=args['chart_digest'], PLUGIN_DIGEST=digest(data),
                        PLUGIN_PATH=str(archive), PLUGIN_DIRECTORY=str(files), MANIFEST_PATH=str(evidence))

    def run_step(self, scenario=''):
        step = self.steps['Stage, verify, and publish the exact GitHub release']
        return subprocess.run(['bash', '--noprofile', '--norc', '-e'], input=step['run'],
                              cwd=ROOT, env={**self.env, 'MODEL_SCENARIO': scenario},
                              capture_output=True, text=True, timeout=30)

    def test_absent_release_is_sealed_only_after_all_five_byte_readbacks(self):
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(self.state.read_text())
        self.assertTrue(state['release']['immutable'])
        calls = state['calls']
        before_publish = calls[:calls.index('publish')]
        self.assertEqual(len([call for call in before_publish if call.startswith('download:')]), 5)
        self.assertEqual(len([call for call in calls if call.startswith('download:')]), 10)
        self.assertEqual(calls.count('publish'), 1)

    def test_exported_bundle_and_files_feed_the_same_publication(self):
        output = self.root / 'export-output'
        result = subprocess.run(['bash', '-e'],
                                input=self.steps['Export the plugin bundle from the image build']['run'],
                                cwd=ROOT, env={**self.env, 'GITHUB_OUTPUT': str(output)},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        exported = dict(line.split('=', 1) for line in output.read_text().splitlines())
        self.env.update(PLUGIN_PATH=exported['path'], PLUGIN_DIRECTORY=exported['directory'],
                        PLUGIN_DIGEST=exported['digest'])
        output.unlink()
        result = subprocess.run(['bash', '-e'],
                                input=self.steps['Build the deterministic release evidence manifest']['run'],
                                cwd=ROOT, env={**self.env, 'GITHUB_OUTPUT': str(output)},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        generated = dict(line.split('=', 1) for line in output.read_text().splitlines())
        self.env['MANIFEST_PATH'] = generated['path']
        stage = self.steps['Stage, verify, and publish the exact GitHub release']
        self.assertEqual(stage['env']['PLUGIN_DIRECTORY'], '${{ steps.plugin.outputs.directory }}')
        self.assertEqual(self.run_step().returncode, 0)
        state = json.loads(self.state.read_text())
        for name in contract.PLUGIN_FILES:
            self.assertEqual(base64.b64decode(state['files'][name]),
                             (Path(exported['directory']) / name).read_bytes())

    def test_exact_immutable_rerun_performs_no_mutation(self):
        self.assertEqual(self.run_step().returncode, 0)
        initial = json.loads(self.state.read_text())
        result = self.run_step()
        self.assertEqual(result.returncode, 0, result.stderr)
        later = json.loads(self.state.read_text())['calls'][len(initial['calls']):]
        self.assertFalse(any(call == 'create' or call == 'publish' or call.startswith('upload:') for call in later))

    def test_lost_create_and_publish_responses_are_resolved_from_readback(self):
        for scenario in ['lost-create-response', 'lost-publish-response']:
            with self.subTest(scenario=scenario):
                self.state.write_text(json.dumps(dict(release=None, files={}, calls=[])))
                result = self.run_step(scenario)
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = json.loads(self.state.read_text())['calls']
                self.assertEqual(calls.count('create'), 1)
                self.assertEqual(calls.count('publish'), 1)

    def test_partial_upload_foreign_digest_and_changed_bytes_never_publish(self):
        for scenario in ['upload-refused', 'foreign-digest', 'changed-download']:
            with self.subTest(scenario=scenario):
                self.state.write_text(json.dumps(dict(release=None, files={}, calls=[])))
                result = self.run_step(scenario)
                self.assertNotEqual(result.returncode, 0)
                state = json.loads(self.state.read_text())
                self.assertNotIn('publish', state['calls'])
                self.assertFalse(state['release']['immutable'])

    def test_invalid_release_ids_refuse_before_any_asset_request(self):
        for release_id in [None, True, '42', 0, -1, 1.5]:
            with self.subTest(release_id=release_id):
                self.state.write_text(json.dumps(dict(release=None, files={}, calls=[])))
                result = self.run_step('release-id:' + json.dumps(release_id))
                self.assertNotEqual(result.returncode, 0)
                calls = json.loads(self.state.read_text())['calls']
                self.assertNotIn('upload-request', calls)
                self.assertNotIn('publish', calls)

    def test_image_tag_wiring_remains_separate_from_the_native_release_tag(self):
        image_state = self.steps['Classify an absent, complete, or burned image tag']
        self.assertEqual(image_state['env']['TAG'], '${{ steps.release.outputs.image_tag }}')
        builds = [step for step in self.steps.values()
                  if str(step.get('uses', '')).startswith('docker/build-push-action@')]
        self.assertEqual(len(builds), 1)
        self.assertIn('${{ steps.release.outputs.image_tag }}', builds[0]['with']['tags'])
        output = self.root / 'output'
        result = subprocess.run(['bash', '-e'], input=self.steps['Read the release locks']['run'],
                                cwd=ROOT, env={**self.env, 'GITHUB_OUTPUT': str(output)},
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = dict(line.split('=', 1) for line in output.read_text().splitlines())
        version = (ROOT / 'VERSION').read_text().strip()
        self.assertEqual(values, dict(version=version, tag=version, image_tag='v' + version))

    def prepare_audit(self, version=VERSION, source_version=None):
        """Build a real source ledger and coherent, immutable release records."""
        source = Path(tempfile.mkdtemp(dir=self.root))
        repo = Repository(source)
        repo.commit({'README.md': 'fixture\n'})
        old = locks('0.1.10')
        old['plugin/manifest.json'] = old.pop('manifest.json')
        source_sha = repo.commit(old)
        if not contract.Version.parse(version).legacy:
            repo.git('rm', 'plugin/manifest.json')
            for patch in range(11, contract.Version.parse(source_version or version).patch + 1):
                source_sha = repo.commit(locks(f'0.1.{patch}', [f'0.1.{old}' for old in range(patch - 1, 9, -1)]))
        scripts = source / 'scripts/ci'
        scripts.mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts/ci/release_contract.py', scripts)
        shutil.copy2(ROOT / 'scripts/ci/verify-native-provenance.sh', scripts)
        data = bundle(version)
        args = {**native_arguments(data), 'source_sha': source_sha, 'version': version}
        evidence = contract.build_release_manifest(**args)
        tag = evidence['release']['tag']
        files = {f'obsync-{tag}-release-manifest.json': contract._canonical_json(evidence),
                 f'obsync-plugin-{tag}.zip': data}
        if not contract.Version.parse(version).legacy:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                files.update({name: archive.read(name) for name in contract.PLUGIN_FILES})
        actor = {'login': 'github-actions[bot]', 'id': 41898282}
        assets = []
        for name, content in files.items():
            content_type = ('application/zip' if name.endswith('.zip') else
                            contract.PLUGIN_FILES.get(name, 'application/json'))
            assets.append(dict(name=name, size=len(content), digest=digest(content),
                               content_type=content_type, uploader=actor, state='uploaded',
                               url='https://api.github.com/model-assets/' + name))
        release = dict(author=actor, tag_name=tag, name='obsync ' + tag,
                       body=contract.build_release_notes(evidence), draft=False,
                       immutable=True, prerelease=False, assets=assets)
        tag_sha = 'b' * 40
        api = 'repos/snaraj/obsync/'
        tag_record = dict(sha=tag_sha, tag=tag, message=f'Release {tag} from {source_sha}',
                          object=dict(type='commit', sha=source_sha),
                          tagger=dict(name=actor['login'],
                                      email='41898282+github-actions[bot]@users.noreply.github.com',
                                      date=repo.git('show', '-s', '--format=%cI', source_sha)))
        state = dict(release=release, calls=[], files={name: base64.b64encode(data).decode()
                                                      for name, data in files.items()},
                     api={api + 'releases/latest': release,
                          api + 'actions/runs/42': main_run_record(head_sha=source_sha),
                          api + 'git/ref/tags/' + tag: dict(ref='refs/tags/' + tag,
                                                         object=dict(type='tag', sha=tag_sha)),
                          api + 'git/tags/' + tag_sha: tag_record},
                     aliases={f'/v2/snaraj/obsync/manifests/v{version}': args['image_digest'],
                              f'/v2/snaraj/charts/obsync/manifests/{version}': args['chart_digest']},
                     signed_targets=[args['image'] + '@' + args['image_digest'],
                                     args['chart'] + '@' + args['chart_digest']])
        state['provenance'] = dict(source_sha=source_sha, files={
            name: digest(content).split(':')[1] for name, content in files.items() if name in contract.PLUGIN_FILES})
        self.state.write_text(json.dumps(state))
        self.audit_root = source
        self.audit_environment = {**self.env, 'TAG': tag, 'GHCR_PASSWORD': 'SENTINEL',
                                  'GITHUB_ACTOR': actor['login'], 'GITHUB_SERVER_URL': 'https://github.com',
                                  'GITHUB_STEP_SUMMARY': str(source / 'summary')}

    def run_audit(self, scenario=''):
        document = miniyaml.load_one((ROOT / '.github/workflows/release-audit.yml').read_text())
        step = document['jobs']['audit']['steps'][-1]
        return subprocess.run(['bash', '--noprofile', '--norc', '-e'], input=step['run'],
                              cwd=self.audit_root, env={**self.audit_environment, 'MODEL_SCENARIO': scenario},
                              capture_output=True, text=True, timeout=30)

    def test_read_only_audit_revalidates_legacy_and_native_releases(self):
        for version in ['0.1.10', VERSION, '0.1.14', '0.1.15']:
            with self.subTest(version=version):
                self.prepare_audit(version)
                result = self.run_audit()
                self.assertEqual(result.returncode, 0, result.stderr)
                calls = json.loads(self.state.read_text())['calls']
                self.assertEqual(len([call for call in calls if call.startswith('download:')]),
                                 2 if version == '0.1.10' else 5)
                self.assertEqual(len([call for call in calls if call.startswith('cosign:')]), 2)
                self.assertEqual(len([call for call in calls if call.startswith('trivy:')]), 1)
                self.assertEqual([call for call in calls if call.startswith('attestation:')],
                                 ['attestation:' + name for name in contract.PLUGIN_FILES] if version == '0.1.15' else [])

    def test_new_release_audit_refuses_missing_native_build_provenance(self):
        for member in contract.PLUGIN_FILES:
            with self.subTest(member=member):
                self.prepare_audit('0.1.15')
                result = self.run_audit('attestation:' + member)
                self.assertNotEqual(result.returncode, 0)
                calls = json.loads(self.state.read_text())['calls']
                self.assertIn('attestation:' + member, calls)
                self.assertFalse(any(call.startswith('cosign:') for call in calls))

    def test_native_verifier_binds_each_exported_file_and_propagates_refusals(self):
        self.prepare_audit('0.1.15')
        state = json.loads(self.state.read_text())
        directory = Path(self.env['PLUGIN_DIRECTORY'])
        for member in contract.PLUGIN_FILES:
            (directory / member).write_bytes(base64.b64decode(state['files'][member]))
        proof = self.root / 'build-bundle.json'
        proof.write_text('SENTINEL-BUILD-BUNDLE')
        verify = self.steps['Verify the native build provenance before release publication']
        result = subprocess.run(['bash', '-e'], input=verify['run'], cwd=ROOT,
                                env={**self.env, 'SOURCE_SHA': state['provenance']['source_sha'],
                                     'ATTESTATION_BUNDLE': str(proof)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.state.read_text())['calls'],
                         ['attestation:' + name for name in contract.PLUGIN_FILES])
        command = ['bash', str(ROOT / 'scripts/ci/verify-native-provenance.sh'),
                   str(directory), state['provenance']['source_sha'], str(proof)]
        for scenario in ['', *['attestation:' + member for member in contract.PLUGIN_FILES]]:
            with self.subTest(scenario=scenario):
                result = subprocess.run(command, env={**self.env, 'MODEL_SCENARIO': scenario},
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, not scenario, result.stderr)
        for source, repository in [('invalid', 'snaraj/obsync'), (state['provenance']['source_sha'], 'other/repo')]:
            before = json.loads(self.state.read_text())['calls']
            command[3] = source
            result = subprocess.run(command, env={**self.env, 'GITHUB_REPOSITORY': repository}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(self.state.read_text())['calls'], before)
        command[3] = 'f' * 40
        self.assertNotEqual(subprocess.run(command, env=self.env, capture_output=True).returncode, 0)
        command[3] = state['provenance']['source_sha']
        proof.write_text('')
        before = json.loads(self.state.read_text())['calls']
        self.assertNotEqual(subprocess.run(command, env=self.env, capture_output=True).returncode, 0)
        self.assertEqual(json.loads(self.state.read_text())['calls'], before)

    def test_native_verifier_arguments_reach_the_real_gh_bundle_parser(self):
        # A local malformed bundle makes real gh stop after argument admission.
        # This proves CLI compatibility, not cryptography; a custom local root
        # and empty gh configuration keep this probe offline and credential-free.
        gh = shutil.which('gh')
        self.assertIsNotNone(gh, 'GitHub CLI is required for the native verifier argument regression')
        directory = self.root / 'parser-native'
        directory.mkdir()
        for member in contract.PLUGIN_FILES:
            (directory / member).write_text('PARSER-SENTINEL')
        proof = self.root / 'parser-bundle.json'
        proof.write_text('PARSER-SENTINEL')
        trusted = self.root / 'parser-root.json'
        trusted.write_text('{}')
        bins = self.root / 'real-cli'
        bins.mkdir()
        wrapper = bins / 'gh'
        wrapper.write_text('#!/bin/sh\nexec ' + shlex.quote(gh) + ' "$@" --custom-trusted-root ' +
                           shlex.quote(str(trusted)) + '\n')
        wrapper.chmod(0o755)
        config = self.root / 'empty-gh-config'
        config.mkdir()
        result = subprocess.run(['bash', str(ROOT / 'scripts/ci/verify-native-provenance.sh'),
                                 str(directory), 'a' * 40, str(proof)],
                                env={**os.environ, 'PATH': str(bins) + os.pathsep + os.environ['PATH'],
                                     'GITHUB_REPOSITORY': 'snaraj/obsync', 'GH_CONFIG_DIR': str(config),
                                     'GH_TOKEN': '', 'GITHUB_TOKEN': ''},
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('bundle content could not be parsed', result.stderr)
        self.assertNotIn('mutually exclusive', result.stderr)

    def test_native_provenance_is_mandatory_between_export_and_release(self):
        document = miniyaml.load_one(WORKFLOW.read_text())
        publish = document['jobs']['publish']
        self.assertEqual(publish['permissions'], {'contents': 'write', 'packages': 'write',
                                                  'id-token': 'write', 'attestations': 'write'})
        steps = publish['steps']
        attest = self.steps['Attest the native plugin build']
        self.assertEqual(attest['uses'], 'actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6')
        self.assertEqual([line.strip() for line in attest['with']['subject-path'].splitlines()],
                         ['${{ steps.plugin.outputs.directory }}/' + name for name in contract.PLUGIN_FILES])
        self.assertEqual({key: value for key, value in attest['with'].items() if key != 'subject-path'},
                         {'create-storage-record': False, 'push-to-registry': False})
        verify = self.steps['Verify the native build provenance before release publication']
        self.assertEqual(verify['env'], {
            'GH_TOKEN': '${{ secrets.GITHUB_TOKEN }}',
            'PLUGIN_DIRECTORY': '${{ steps.plugin.outputs.directory }}',
            'ATTESTATION_BUNDLE': '${{ steps.native_attestation.outputs.bundle-path }}'})
        for step in [attest, verify]:
            self.assertNotIn('if', step)
            self.assertNotIn('continue-on-error', step)
        export = self.steps['Export the plugin bundle from the image build']
        release = self.steps['Stage, verify, and publish the exact GitHub release']
        self.assertLess(steps.index(export), steps.index(attest))
        self.assertLess(steps.index(attest), steps.index(verify))
        self.assertLess(steps.index(verify), steps.index(release))
        self.assertEqual(steps[-1]['name'], 'Re-bind the immutable Release to the exact annotated tag')
        bind = self.steps['Bind protected workflow, authorized checkout, and committed locks']
        self.assertIn('--workflow-sha "${GITHUB_SHA}"', bind['run'])
        self.assertLess(steps.index(bind), steps.index(self.steps['Create or verify the exact annotated tag']))

    def test_audit_refuses_changed_native_bytes_and_a_coherent_but_wrong_source_version(self):
        for member in contract.PLUGIN_FILES:
            with self.subTest(member=member):
                self.prepare_audit()
                self.assertNotEqual(self.run_audit('changed:' + member).returncode, 0)
        self.prepare_audit('0.1.12', source_version=VERSION)
        self.assertNotEqual(self.run_audit().returncode, 0)


if __name__ == '__main__':
    unittest.main()
