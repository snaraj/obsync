"""Wrong source, runtime, content, inventory and old-release inputs must refuse."""
import copy
import hashlib
import io
import json
import stat
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


def cli_bundle(version='1.2.0', source_sha=SHA, mutate=None, extra=None):
    files = {name: b'fixture\n' for name in cli.CLI_FILES}
    files['VERSION'] = f'{version}\n'.encode()
    files['cli/shared/package.json'] = b'{"type":"commonjs"}\n'
    manifest = dict(schema_version=1, version=version, runtime='26.10.0', source_sha=source_sha,
                    source_digest='b' * 64, candidate=False,
                    files=[dict(name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest())
                           for name, data in sorted(files.items())])
    if mutate:
        mutate(manifest)
    files['package-manifest.json'] = (json.dumps(manifest) + '\n').encode()
    if extra:
        files.update(extra)
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    return result.getvalue()


class CliReleaseContract(unittest.TestCase):
    def test_exact_package_and_old_release_boundary(self):
        data = cli_bundle()
        record = cli.cli_archive_record(data, '1.2.0', SHA)
        self.assertEqual(record['name'], 'obsync-cli-1.2.0.zip')
        self.assertEqual(record['runtime'], cli.CLI_RUNTIME)
        self.assertEqual(record['digest'], digest(data))
        with tempfile.TemporaryDirectory() as temporary:
            plugin = bundle('1.2.0')
            args = manifest_arguments(version='1.2.0', source_sha=SHA, plugin_bundle=plugin,
                                      plugin_digest=digest(plugin), server_archives={
                platform: release.build_server_archive(server_tree(Path(temporary), platform, plugin), '1.2.0', platform)
                for platform in release.RELEASE_MANIFEST_PLATFORMS})
            with self.assertRaises(release.ContractError):
                release.build_release_manifest(**args)
            manifest = release.build_release_manifest(**args, cli_bundle=data)
            self.assertEqual(manifest['artifacts']['cli_bundle'], record)
            release.validate_release_manifest_record(manifest, **args, cli_bundle=data)
            changed = copy.deepcopy(manifest)
            changed['artifacts']['cli_bundle']['runtime']['version'] = '26.9.0'
            with self.assertRaises(release.ContractError):
                release.validate_release_manifest_record(changed, **args, cli_bundle=data)
        old = bundle('0.1.11')
        with self.assertRaises(release.ContractError):
            release.build_release_manifest(**manifest_arguments(version='0.1.11', plugin_bundle=old,
                plugin_digest=digest(old)), cli_bundle=data)

    def test_source_runtime_candidate_fields_and_content_refuse(self):
        for mutation in [lambda m: m.update(source_sha='c' * 40), lambda m: m.update(runtime='26.9.0'),
                         lambda m: m.update(candidate=True), lambda m: m.update(extra=True),
                         lambda m: m.update(source_digest='0' * 64),
                         lambda m: m['files'][0].update(size=1), lambda m: m['files'][0].update(sha256='0' * 64)]:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                cli.cli_archive_record(cli_bundle(mutate=mutation), '1.2.0', SHA)
        for extra in [{'../outside': b'x'}, {'cli/unknown.mjs': b'x'}, {'VERSION': b'1.3.0\n'}]:
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                cli.cli_archive_record(cli_bundle(extra=extra), '1.2.0', SHA)
        with self.assertRaises(ValueError):
            cli.cli_archive_record(b'x' * (cli.CLI_MAX_BYTES + 1), '1.2.0', SHA)

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
            cli.pack_cli(source, first)
            cli.pack_cli(source, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            cli.cli_archive_record(first.read_bytes(), '1.2.0', SHA)
            (source / 'VERSION').unlink()
            (source / 'VERSION').symlink_to(root / 'outside')
            with self.assertRaises(ValueError):
                cli.pack_cli(source, second)
