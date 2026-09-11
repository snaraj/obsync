"""Native distribution and the immutable legacy boundary, using real ZIPs and Git."""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import json
import stat
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_contract as contract
from test_release_contract import Repository, locks, manifest_arguments

VERSION = "0.1.11"


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def bundle(version=VERSION, files=None):
    contents = {
        "main.js": b"module.exports = class NativeFixture {};\n",
        "manifest.json": json.dumps({
            "id": "obsync" if tuple(map(int, version.split("."))) <= (0, 1, 11) else "obsync-private-sync",
            "version": version,
        }).encode(),
        "styles.css": b".obsync-fixture { display: block; }\n",
    }
    if files is not None:
        contents = files
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            archive.writestr(name, data)
    return target.getvalue()


def native_arguments(data=None):
    data = bundle() if data is None else data
    return manifest_arguments(version=VERSION, plugin_digest=digest(data), plugin_bundle=data)


class NativeReleaseEvidence(unittest.TestCase):
    def test_plugin_identity_is_closed_at_the_directory_transition(self):
        for version, expected_id in (("0.1.10", "obsync"), ("0.1.11", "obsync"),
                                     ("0.1.12", "obsync-private-sync"),
                                     ("0.2.0", "obsync-private-sync"), ("1.0.0", "obsync-private-sync")):
            parsed = contract.Version.parse(version)
            with self.subTest(version=version):
                self.assertEqual(parsed.plugin_id, expected_id)
                contract.validate_snapshot(locks(version))
                data = bundle(version)
                contract.plugin_asset_records(data, parsed, digest(data))
            for wrong_id in ("obsync", "obsync-private-sync", "another", None):
                if wrong_id == expected_id:
                    continue
                with self.subTest(version=version, wrong_id=wrong_id):
                    manifest = json.dumps({"version": version} if wrong_id is None else
                                          {"id": wrong_id, "version": version}).encode()
                    files = locks(version)
                    files["manifest.json"] = manifest.decode()
                    with self.assertRaisesRegex(contract.ContractError, "manifest identity"):
                        contract.validate_snapshot(files)
                    data = bundle(version, {"main.js": b"fixture", "manifest.json": manifest,
                                            "styles.css": b"fixture"})
                    with self.assertRaisesRegex(contract.ContractError, "manifest identity"):
                        contract.plugin_asset_records(data, parsed, digest(data))

    def test_valid_plugin_id_cannot_hide_a_different_bundle_version(self):
        for expected, wrong in (("0.1.11", "0.1.10"), ("0.1.12", "0.2.0")):
            with self.subTest(expected=expected, wrong=wrong):
                data = bundle(wrong)
                with self.assertRaisesRegex(contract.ContractError, "manifest identity/version"):
                    contract.plugin_asset_records(data, contract.Version.parse(expected), digest(data))

    def test_cli_reads_at_most_the_archive_budget_plus_one_byte(self):
        data = bundle()
        budget = contract.PLUGIN_BUNDLE_MAX_BYTES
        requested = []

        class Reader(io.BytesIO):
            def read(self, size=-1):
                requested.append(size)
                if size < 0 or size > contract.PLUGIN_BUNDLE_MAX_BYTES + 1:
                    raise AssertionError("unbounded archive input read")
                return super().read(size)

        class InputPath:
            def __init__(self, payload):
                self.payload = payload

            def open(self, mode):
                if mode != "rb":
                    raise AssertionError("archive input must be binary")
                return Reader(self.payload)

            def read_bytes(self):
                with self.open("rb") as stream:
                    return stream.read()

        try:
            contract.PLUGIN_BUNDLE_MAX_BYTES = len(data)
            for extra in [b"", b"trailing bytes beyond the budget"]:
                with self.subTest(oversize=bool(extra)):
                    args = argparse.Namespace(**native_arguments(data))
                    args.plugin_bundle = InputPath(data + extra)
                    parsed = contract._manifest_arguments(args)
                    self.assertEqual(requested[-1], len(data) + 1)
                    if extra:
                        self.assertEqual(len(parsed["plugin_bundle"]), len(data) + 1)
                        with self.assertRaisesRegex(contract.ContractError, "bounded plugin bundle"):
                            contract.build_release_manifest(**parsed)
                    else:
                        contract.build_release_manifest(**parsed)
        finally:
            contract.PLUGIN_BUNDLE_MAX_BYTES = budget

    def test_legacy_evidence_and_notes_are_byte_identical_to_the_previous_publisher(self):
        record = contract.build_release_manifest(**manifest_arguments())
        self.assertEqual(hashlib.sha256(contract._canonical_json(record)).hexdigest(),
                         "84da035e3c85227390cde3a1097319f3030cc6a47df93c070ef9e72a5f3655f4")
        self.assertEqual(hashlib.sha256(contract.build_release_notes(record).encode()).hexdigest(),
                         "69747a9d5e85eb803eeee27ba20b98b24e770ab72f461f979287367d14596aa5")

    def test_release_and_image_names_diverge_only_after_the_legacy_boundary(self):
        for version, tag in [("0.1.10", "v0.1.10"), (VERSION, VERSION), ("1.0.0", "1.0.0")]:
            parsed = contract.Version.parse(version)
            self.assertEqual(parsed.tag, tag)
            self.assertEqual(parsed.image_tag, "v" + version)
            self.assertEqual(contract.release_version(tag), parsed)
            self.assertEqual(contract.plugin_bundle_asset_name(tag), f"obsync-plugin-{tag}.zip")
        for tag in ["0.1.10", "v0.1.11", "v1.0.0", "01.1.11", "0.1.11-rc.1", " 0.1.11"]:
            with self.subTest(tag=tag), self.assertRaises(contract.ContractError):
                contract.release_version(tag)

    def test_native_files_bind_to_the_same_bundle_with_exact_sizes_and_types(self):
        args = native_arguments()
        record = contract.build_release_manifest(**args)
        self.assertEqual(record["schema"], contract.COMMUNITY_MANIFEST_SCHEMA)
        self.assertEqual(record["release"], {"version": VERSION, "tag": VERSION})
        self.assertEqual(record["artifacts"]["image"]["tag"], "v" + VERSION)
        self.assertEqual(record["artifacts"]["chart"]["tag"], VERSION)
        with zipfile.ZipFile(io.BytesIO(args["plugin_bundle"])) as archive:
            expected = {name: {"digest": digest(archive.read(name)), "size": len(archive.read(name)),
                               "content_type": content_type}
                        for name, content_type in contract.PLUGIN_FILES.items()}
        self.assertEqual(record["artifacts"]["plugin_files"], expected)
        contract.validate_release_manifest_record(record, **args)

    def test_missing_bundle_or_wrong_digest_cannot_select_legacy_evidence(self):
        args = native_arguments()
        for override, reason in [({"plugin_bundle": None}, "bounded plugin bundle"),
                                 ({"plugin_bundle": b""}, "bounded plugin bundle"),
                                 ({"plugin_digest": "sha256:" + "f" * 64}, "expected digest")]:
            with self.subTest(override=list(override)), self.assertRaisesRegex(contract.ContractError, reason):
                contract.build_release_manifest(**{**args, **override})

    def test_foreign_missing_extra_empty_or_non_file_archive_members_are_refused(self):
        with zipfile.ZipFile(io.BytesIO(bundle())) as archive:
            good = {name: archive.read(name) for name in archive.namelist()}
        bad = [bundle("0.1.10"), bundle(files={**good, "extra.txt": b"extra"}),
               bundle(files={name: data for name, data in good.items() if name != "main.js"}),
               bundle(files={**good, "main.js": b""}),
               bundle(files={**good, "manifest.json": b"not JSON"}),
               bundle(files={**good, "manifest.json": b'{"id":"another","version":"0.1.11"}'}),
               b"not a ZIP"]
        link = zipfile.ZipInfo("main.js")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        bad.append(bundle(files={link: good["main.js"], "manifest.json": good["manifest.json"],
                                 "styles.css": good["styles.css"]}))
        for data in bad:
            with self.subTest(size=len(data)), self.assertRaises(contract.ContractError):
                contract.build_release_manifest(**native_arguments(data))

    def test_archive_and_expanded_budgets_are_independent(self):
        budget = contract.PLUGIN_BUNDLE_MAX_BYTES
        try:
            data = bundle()
            contract.PLUGIN_BUNDLE_MAX_BYTES = len(data) - 1
            with self.assertRaisesRegex(contract.ContractError, "bounded plugin bundle"):
                contract.build_release_manifest(**native_arguments(data))
            data = bundle(files={"main.js": b"x" * 4000,
                                 "manifest.json": b'{"id":"obsync","version":"0.1.11"}',
                                 "styles.css": b"x"})
            contract.PLUGIN_BUNDLE_MAX_BYTES = len(data) + 1
            with self.assertRaisesRegex(contract.ContractError, "expanded plugin bundle"):
                contract.build_release_manifest(**native_arguments(data))
        finally:
            contract.PLUGIN_BUNDLE_MAX_BYTES = budget

    def test_encrypted_member_metadata_is_refused_before_reading_the_member(self):
        data = bytearray(bundle())
        # Mark the first ordinary member encrypted in both ZIP headers. No
        # password or encrypted payload is involved: this is a metadata refusal.
        for signature, offset in [(b"PK\x03\x04", 6), (b"PK\x01\x02", 8)]:
            position = data.index(signature) + offset
            flags = struct.unpack_from("<H", data, position)[0]
            struct.pack_into("<H", data, position, flags | 1)
        with self.assertRaisesRegex(contract.ContractError, "ordinary unencrypted"):
            contract.build_release_manifest(**native_arguments(bytes(data)))

    def test_directory_spelling_is_refused_even_with_regular_file_mode_bits(self):
        member = zipfile.ZipInfo("main.js/")
        member.external_attr = (stat.S_IFREG | 0o600) << 16
        data = bundle(files={member: b"x", "styles.css": b"x",
                             "manifest.json": b'{"id":"obsync","version":"0.1.11"}'})
        with self.assertRaises(contract.ContractError):
            contract.build_release_manifest(**native_arguments(data))

    def test_v2_evidence_cannot_be_downgraded_or_have_a_file_digest_changed(self):
        args = native_arguments()
        good = contract.build_release_manifest(**args)
        for action in ["schema", "files", "digest", "image"]:
            bad = copy.deepcopy(good)
            if action == "schema":
                bad["schema"] = contract.RELEASE_MANIFEST_SCHEMA
            elif action == "files":
                del bad["artifacts"]["plugin_files"]
            elif action == "digest":
                bad["artifacts"]["plugin_files"]["main.js"]["digest"] = "sha256:" + "f" * 64
            else:
                bad["artifacts"]["image"]["tag"] = VERSION
            with self.subTest(action=action), self.assertRaises(contract.ContractError):
                contract.validate_release_manifest_record(bad, **args)


class NativeReleaseInventory(unittest.TestCase):
    def setUp(self):
        self.args = native_arguments()
        self.evidence = contract.build_release_manifest(**self.args)
        self.manifest = contract._canonical_json(self.evidence)
        self.actor = {"login": "github-actions[bot]", "id": 41898282}
        self.assets = [
            {"name": f"obsync-{VERSION}-release-manifest.json", "size": len(self.manifest),
             "digest": digest(self.manifest), "content_type": "application/json"},
            {"name": f"obsync-plugin-{VERSION}.zip", "digest": self.args["plugin_digest"],
             "content_type": "application/zip"},
            *[{"name": name, **record} for name, record in self.evidence["artifacts"]["plugin_files"].items()],
        ]
        for asset in self.assets:
            asset.update(uploader=self.actor, state="uploaded")
        self.expected = dict(tag=VERSION, title="obsync " + VERSION, body="notes",
                             manifest=self.manifest, plugin_digest=self.args["plugin_digest"])
        self.record = dict(author=self.actor, tag_name=VERSION, name="obsync " + VERSION,
                           body="notes", prerelease=False, draft=False, immutable=True, assets=self.assets)

    def test_all_five_files_are_required_in_the_published_release(self):
        contract.validate_release_record(self.record, **self.expected)
        for index in range(5):
            bad = {**self.record, "assets": self.assets[:index] + self.assets[index + 1:]}
            with self.subTest(index=index), self.assertRaises(contract.ContractError):
                contract.validate_release_record(bad, **self.expected)

    def test_each_native_file_requires_exact_identity_bytes_size_type_and_uploader(self):
        for index in range(2, 5):
            for field, value in [("name", "foreign.js"), ("digest", "sha256:" + "f" * 64),
                                 ("size", 0), ("content_type", "text/plain"),
                                 ("uploader", {"login": "someone", "id": 1}), ("state", "starter")]:
                bad = copy.deepcopy(self.record)
                bad["assets"][index][field] = value
                with self.subTest(index=index, field=field), self.assertRaises(contract.ContractError):
                    contract.validate_release_record(bad, **self.expected)

    def test_native_release_cannot_use_v1_schema_or_duplicate_a_native_asset(self):
        old = copy.deepcopy(self.evidence)
        old["schema"] = contract.RELEASE_MANIFEST_SCHEMA
        with self.assertRaisesRegex(contract.ContractError, "v2 evidence"):
            contract.validate_release_record(self.record, **{**self.expected, "manifest": contract._canonical_json(old)})
        bad = copy.deepcopy(self.record)
        bad["assets"][3] = bad["assets"][2]
        with self.assertRaisesRegex(contract.ContractError, "duplicated"):
            contract.validate_release_record(bad, **self.expected)

    def test_evidence_metadata_cannot_make_invalid_native_asset_records_match(self):
        for field, value in [("size", True), ("size", "1"), ("size", 0),
                             ("size", contract.PLUGIN_BUNDLE_MAX_BYTES + 1),
                             ("content_type", "text/plain"), ("digest", "invalid")]:
            evidence = copy.deepcopy(self.evidence)
            evidence["artifacts"]["plugin_files"]["main.js"][field] = value
            manifest = contract._canonical_json(evidence)
            record = copy.deepcopy(self.record)
            record["assets"][0].update(size=len(manifest), digest=digest(manifest))
            record["assets"][2][field] = value
            reason = "native plugin asset digest" if field == "digest" else "size or content type"
            with self.subTest(field=field, value=value), self.assertRaisesRegex(contract.ContractError, reason):
                contract.validate_release_record(record, **{**self.expected, "manifest": manifest})

    def test_evidence_requires_the_complete_native_map_and_object_records(self):
        for change in ["absent", "missing", "extra", "non-object"]:
            evidence = copy.deepcopy(self.evidence)
            files = evidence["artifacts"]["plugin_files"]
            if change == "absent":
                del evidence["artifacts"]["plugin_files"]
            elif change == "missing":
                del files["main.js"]
            elif change == "extra":
                files["unexpected.js"] = files["main.js"]
            else:
                files["main.js"] = []
            with self.subTest(change=change), self.assertRaises(contract.ContractError):
                contract.validate_release_record(
                    self.record, **{**self.expected, "manifest": contract._canonical_json(evidence)})


class HistoricalManifestLayout(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Repository(Path(directory.name))
        self.root = self.repo.root
        self.repo.commit({"README.md": "genesis\n"})
        old = locks("0.1.10")
        old["plugin/manifest.json"] = old.pop("manifest.json")
        self.base = self.repo.commit(old, "last legacy layout")

    def test_historical_window_and_docs_only_push_still_validate(self):
        intent = contract.discover_transition_window(self.root, self.base).intent
        self.assertEqual(intent.tag, "v0.1.10")
        head = self.repo.commit({"README.md": "updated docs\n"})
        self.assertEqual(contract.classify_transition(self.root, self.base, head, first_parent=True)["class"],
                         "no-artifact")

    def test_exact_next_patch_can_move_the_canonical_manifest(self):
        self.repo.git("rm", "plugin/manifest.json")
        head = self.repo.commit(locks(VERSION, ["0.1.10"]))
        result = contract.classify_transition(self.root, self.base, head, first_parent=True)
        self.assertEqual((result["class"], result["tag"]), ("artifact", VERSION))
        self.assertEqual(contract.discover_transition_window(self.root, head).intent.tag, VERSION)

    def test_new_versions_cannot_keep_the_legacy_path_or_duplicate_it(self):
        new = locks(VERSION, ["0.1.10"])
        duplicate = self.repo.commit(new)
        with self.assertRaisesRegex(contract.ContractError, "duplicate"):
            contract._git_file(self.root, duplicate, "manifest.json")
        with self.assertRaisesRegex(contract.ContractError, "duplicate"):
            contract._locks_present(self.root, duplicate)
        with self.assertRaisesRegex(contract.ContractError, "duplicate"):
            contract.discover_transition_window(self.root, duplicate)
        self.repo.git("rm", "manifest.json")
        head = self.repo.commit({"plugin/manifest.json": new["manifest.json"]})
        with self.assertRaisesRegex(contract.ContractError, "root plugin manifest"):
            contract.discover_transition_window(self.root, head)

    def test_direct_snapshot_rejects_a_second_manifest(self):
        files = locks(VERSION)
        files["plugin/manifest.json"] = files["manifest.json"]
        with self.assertRaisesRegex(contract.ContractError, "canonical root"):
            contract.validate_snapshot(files)


if __name__ == "__main__":
    unittest.main()
