"""Wrong source, runtime, content, inventory and old-release inputs must refuse."""
import copy
import hashlib
import io
import importlib.util
import json
import os
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cli_package_contract as cli
import release_contract as release
from test_community_release import bundle, digest
from test_release_contract import manifest_arguments
from test_server_archives import server_tree

SHA = 'a' * 40


class NativeStartupBudgets(unittest.TestCase):
    def test_slow_cold_launch_cannot_hide_in_fast_warm_samples(self):
        spec = importlib.util.spec_from_file_location('cli_native', Path(__file__).with_name('cli-native.py'))
        native = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(native)
        self.assertEqual(native.startup_result([5] * 35)['warm_p95_ms'], 5)
        for samples in ([1001] + [5] * 34, [5] * 33 + [251, 251]):
            with self.subTest(samples=samples), self.assertRaises(AssertionError):
                native.startup_result(samples)


class NativePackagePreparation(unittest.TestCase):
    def test_workflow_packages_hardlinked_cargo_output_and_binds_release_source(self):
        from test_release_contract import Repository, workflow
        root = Path(__file__).resolve().parents[2]
        script = workflow('cli-native.yml')['jobs']['native']['steps'][1]['run']
        script = script[script.index('binary="target/'):]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            repo = Repository(directory)
            names = ['cli/build.py', 'cli/README.md', 'scripts/ci/cli_package_contract.py', 'LICENSE', 'VERSION']
            source = repo.commit({**{name: (root / name).read_text() for name in names},
                                  '.gitignore': 'target/\nrunner-*/\n__pycache__/\n'})
            binary = directory / 'target/synthetic/release/obsync'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'synthetic compiled bytes\n')
            os.link(binary, binary.with_name('cargo-deps-copy'))
            self.assertEqual(binary.stat().st_nlink, 2)
            for event, sha, success in [('pull_request', source, True), ('push', source, True),
                                         ('push', '0' * 40, False), ('push', '', False)]:
                runner = directory / f'runner-{event}-{sha}'
                runner.mkdir()
                result = subprocess.run(['/bin/bash', '-euc', script], cwd=directory,
                    env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'target': 'synthetic',
                         'platform': 'linux-amd64', 'RUNNER_OS': 'Linux', 'RUNNER_TEMP': str(runner),
                         'GITHUB_OUTPUT': str(runner / 'output'), 'GITHUB_EVENT_NAME': event,
                         'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': sha}, capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
                if success:
                    package = runner / 'cli-package'
                    self.assertEqual((package / 'obsync').read_bytes(), binary.read_bytes())
                    self.assertEqual((package / 'obsync').stat().st_nlink, 1)
                    manifest = json.loads((package / 'package-manifest.json').read_text())
                    self.assertEqual(manifest['source_sha'], source)
                    self.assertEqual(manifest['candidate'], event != 'push')
                else:
                    self.assertFalse((runner / 'cli-package').exists())


def cli_bundle(version='1.1.6', source_sha=SHA, mutate=None, extra=None,
               entry_mutate=None, platform='linux-amd64', file_payloads=None, encode_manifest=json.dumps):
    files = {name: b'fixture\n' for name in cli.cli_files(platform)}
    files['VERSION'] = f'{version}\n'.encode()
    if file_payloads:
        files.update(file_payloads)
    manifest = dict(schema_version=2, version=version, platform=platform, source_sha=source_sha,
                    candidate=False,
                    files=[dict(name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest())
                           for name, data in sorted(files.items())])
    if mutate:
        mutate(manifest)
    files['package-manifest.json'] = (encode_manifest(manifest) + '\n').encode()
    if extra:
        files.update(extra)
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | cli.member_mode(name)) << 16
            if entry_mutate:
                entry_mutate(info)
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    return result.getvalue()


class CliReleaseContract(unittest.TestCase):
    def test_archive_metadata_and_platform_binding(self):
        for change in [lambda entry: setattr(entry, 'external_attr', (stat.S_IFREG | 0o644) << 16),
                       lambda entry: setattr(entry, 'date_time', (2000, 1, 1, 0, 0, 0)),
                       lambda entry: setattr(entry, 'comment', b'synthetic comment')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                cli.cli_archive_record(cli_bundle(entry_mutate=change), '1.1.6', SHA, 'linux-amd64')
        with self.assertRaises(ValueError):
            cli.cli_archive_record(cli_bundle(platform='windows-amd64'), '1.1.6', SHA, 'linux-amd64')
        wrong_disk = bytearray(cli_bundle())
        struct.pack_into('<H', wrong_disk, len(wrong_disk) - 18, 1)
        with self.assertRaises(ValueError):
            cli.cli_archive_record(bytes(wrong_disk), '1.1.6', SHA, 'linux-amd64')

    def test_exact_package_and_old_release_boundary(self):
        data = cli_bundle()
        record = cli.cli_archive_record(data, '1.1.6', SHA, 'linux-amd64')
        self.assertEqual(record['name'], 'obsync-cli-1.1.6-linux-amd64.zip')
        self.assertEqual(record['runtime'], cli.CLI_RUNTIME)
        self.assertEqual(record['digest'], digest(data))
        with tempfile.TemporaryDirectory() as temporary:
            plugin = bundle('1.1.6')
            args = manifest_arguments(version='1.1.6', source_sha=SHA, plugin_bundle=plugin,
                                      plugin_digest=digest(plugin), server_archives={
                platform: release.build_server_archive(server_tree(Path(temporary), platform, plugin), '1.1.6', platform)
                for platform in release.RELEASE_MANIFEST_PLATFORMS})
            with self.assertRaises(release.ContractError):
                release.build_release_manifest(**args)
            archives = {p: cli_bundle(platform=p) for p in cli.CLI_PLATFORMS}
            manifest = release.build_release_manifest(**args, cli_archives=archives)
            self.assertEqual(manifest['artifacts']['cli_archives']['linux-amd64'], record)
            release.validate_release_manifest_record(manifest, **args, cli_archives=archives)
            changed = copy.deepcopy(manifest)
            changed['artifacts']['cli_archives']['linux-amd64']['runtime']['version'] = '26.9.0'
            with self.assertRaises(release.ContractError):
                release.validate_release_manifest_record(changed, **args, cli_archives=archives)

            def uploaded(evidence):
                raw = release._canonical_json(evidence)
                actor = {'login': 'github-actions[bot]', 'id': 41898282}
                artifacts = evidence['artifacts']
                assets = [dict(name='obsync-1.1.6-release-manifest.json', size=len(raw), digest=digest(raw),
                               content_type='application/json'),
                          dict(name='obsync-plugin-1.1.6.zip', size=len(plugin), digest=digest(plugin),
                               content_type='application/zip')]
                assets += [dict(name=name, **entry) for name, entry in artifacts['plugin_files'].items()]
                assets += [dict(entry, content_type='application/gzip') for entry in artifacts['server_archives'].values()]
                # Keep the upload inventory fixed when testing a foreign declaration.
                assets += [{key: artifacts['cli_archives'][p][key] for key in ('name', 'size', 'digest', 'content_type')}
                           for p in cli.CLI_PLATFORMS]
                for entry in assets:
                    entry.update(uploader=actor, state='uploaded')
                record = dict(author=actor, tag_name='1.1.6', name='obsync 1.1.6', body='synthetic notes',
                              prerelease=False, draft=False, immutable=True, assets=assets)
                release.validate_release_record(record, tag='1.1.6', title='obsync 1.1.6', body='synthetic notes',
                                                manifest=raw, plugin_digest=digest(plugin))

            uploaded(manifest)
            for field in ('platform', 'runtime', 'size', 'record-fields', 'manifest-digest'):
                changed = copy.deepcopy(manifest)
                clients = changed['artifacts']['cli_archives']
                if field == 'platform':
                    clients['foreign'] = copy.deepcopy(clients['linux-amd64'])
                elif field == 'runtime':
                    clients['linux-amd64']['runtime']['version'] = '0.0.0'
                elif field == 'record-fields':
                    clients['linux-amd64']['unexpected'] = True
                elif field == 'manifest-digest':
                    clients['linux-amd64']['manifest_sha256'] = '0' * 64
                else:
                    # Mirrored upload size must not bypass the fixed producer budget.
                    clients['linux-amd64']['size'] = cli.CLI_MAX_BYTES + 1
                with self.subTest(declaration=field), self.assertRaises(release.ContractError):
                    uploaded(changed)
        old = bundle('0.1.11')
        with self.assertRaises(release.ContractError):
            release.build_release_manifest(**manifest_arguments(version='0.1.11', plugin_bundle=old,
                plugin_digest=digest(old)), cli_archives={'linux-amd64': data})

    def test_source_runtime_candidate_fields_and_content_refuse(self):
        for mutation in [lambda m: m.update(source_sha='c' * 40), lambda m: m.update(platform='windows-amd64'),
                         lambda m: m.update(candidate=True), lambda m: m.update(extra=True),
                         lambda m: m.update(source_sha='0' * 40),
                         lambda m: m['files'][0].update(size=1), lambda m: m['files'][0].update(sha256='0' * 64)]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                cli.cli_archive_record(cli_bundle(mutate=mutation), '1.1.6', SHA, 'linux-amd64')
        for extra in [{'../outside': b'x'}, {'cli/unknown.mjs': b'x'}, {'VERSION': b'1.3.0\n'}]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                cli.cli_archive_record(cli_bundle(extra=extra), '1.1.6', SHA, 'linux-amd64')
        with self.assertRaises(ValueError):
            cli.cli_archive_record(b'x' * (cli.CLI_MAX_BYTES + 1), '1.1.6', SHA, 'linux-amd64')
        expanded = cli_bundle(file_payloads={'LICENSE': b'x' * cli.CLI_MAX_BYTES})
        self.assertLess(len(expanded), cli.CLI_MAX_BYTES)
        with self.assertRaises(ValueError):
            cli.cli_archive_record(expanded, '1.1.6', SHA, 'linux-amd64')
        duplicate = cli_bundle(encode_manifest=lambda m: '{"candidate":false,' + json.dumps(m)[1:])
        with self.assertRaises(ValueError):
            cli.cli_archive_record(duplicate, '1.1.6', SHA, 'linux-amd64')

    def test_real_packer_is_deterministic_and_matches_validator(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            with zipfile.ZipFile(io.BytesIO(cli_bundle())) as archive:
                for name in archive.namelist():
                    target = source / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.read(name))
            first, second = root / 'first.zip', root / 'second.zip'
            cli.pack_cli(source, first, "linux-amd64")
            cli.pack_cli(source, second, "linux-amd64")
            self.assertEqual(first.read_bytes(), second.read_bytes())
            cli.cli_archive_record(first.read_bytes(), '1.1.6', SHA, 'linux-amd64')
            (source / 'VERSION').unlink()
            (root / 'outside').write_bytes(b'1.1.6\n')
            (source / 'VERSION').symlink_to(root / 'outside')
            with self.assertRaises(ValueError):
                cli.pack_cli(source, second, "linux-amd64")


class NativePublicationAcceptance(unittest.TestCase):
    def run_record(self, **overrides):
        run = dict(id=7, name=release.EXPECTED_CLI_WORKFLOW,
                   path=release.EXPECTED_CLI_WORKFLOW_PATH, event='push',
                   head_branch='main', head_sha=SHA, status='completed', conclusion='success',
                   repository={'full_name': 'snaraj/obsync'}, head_repository={'full_name': 'snaraj/obsync'})
        run.update(overrides)
        return {'total_count': 1, 'workflow_runs': [run]}

    def test_only_exact_native_source_run_can_authorize(self):
        def resolve(record):
            return release.classify_cli_run_record(record, expected_repository='snaraj/obsync', expected_source_sha=SHA)
        self.assertEqual(resolve(self.run_record()), 7)
        self.assertIsNone(resolve({'total_count': 0, 'workflow_runs': []}))
        self.assertIsNone(resolve(self.run_record(status='in_progress', conclusion=None)))
        for override in ({'head_sha': 'c' * 40}, {'event': 'workflow_dispatch'},
                         {'head_branch': 'candidate'}, {'conclusion': 'failure'}, {'conclusion': 'cancelled'},
                         {'name': release.EXPECTED_CODEQL_WORKFLOW}, {'path': release.EXPECTED_CODEQL_WORKFLOW_PATH},
                         {'repository': {'full_name': 'example/other'}},
                         {'head_repository': {'full_name': 'example/other'}}, {'status': 'queued'}, {'id': True}):
            with self.subTest(override=override), self.assertRaises(release.ContractError):
                resolve(self.run_record(**override))
        partial = self.run_record(); partial['total_count'] = 2
        with self.assertRaises(release.ContractError): resolve(partial)
        duplicate = self.run_record(); duplicate['workflow_runs'] *= 2; duplicate['total_count'] = 2
        with self.assertRaises(release.ContractError): resolve(duplicate)

    def test_every_native_job_must_finish_successfully_at_this_source(self):
        from test_release_contract import jobs_record
        def check(record):
            return release.validate_cli_jobs_record(record, expected_run_id=7, expected_source_sha=SHA)
        self.assertEqual(check(jobs_record(release.EXPECTED_CLI_JOBS, run_id=7)), SHA)
        for name in release.EXPECTED_CLI_JOBS:
            for conclusion in (None, 'failure', 'skipped', 'cancelled'):
                record = jobs_record(release.EXPECTED_CLI_JOBS, run_id=7)
                next(item for item in record['jobs'] if item['name'] == name)['conclusion'] = conclusion
                with self.subTest(name=name, conclusion=conclusion), self.assertRaises(release.ContractError): check(record)
            missing = {key: value for key, value in release.EXPECTED_CLI_JOBS.items() if key != name}
            with self.assertRaises(release.ContractError): check(jobs_record(missing, run_id=7))
        for record in (jobs_record(release.EXPECTED_CLI_JOBS, run_id=8),
                       jobs_record(release.EXPECTED_CLI_JOBS, run_id=7, source_sha='c' * 40)):
            with self.assertRaises(release.ContractError): check(record)

    def test_native_matrix_and_publisher_bind_the_acceptance_checks(self):
        from test_release_contract import workflow
        native = workflow('cli-native.yml')
        self.assertEqual(set(native['jobs']), {'native'})
        job = native['jobs']['native']
        self.assertEqual({f'native ({os})' for os in job['strategy']['matrix']['os']}, set(release.EXPECTED_CLI_JOBS))
        steps = [step.get('run', '') for step in job['steps']]
        self.assertTrue(any('cargo test -p obsync-cli --locked' in step for step in steps))
        self.assertTrue(any('scripts/ci/cli-native.py --package' in step for step in steps))
        self.assertTrue(any('& scripts/ci/cli-windows-native.ps1 -Package' in step for step in steps))
        publisher = workflow('release-publisher.yml')['jobs']
        authority = '\n'.join(step.get('run', '') for step in publisher['authorize']['steps'])
        for required in ('actions/workflows/cli-native.yml/runs', 'cli-run-record', 'cli-jobs-record'):
            self.assertIn(required, authority)
        self.assertEqual(publisher['publish']['needs'], 'authorize')
