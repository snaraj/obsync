"""The static server archives: packing, binding, inventory, and the 1.1.4 boundary.

Real tarballs built by the same function the publisher runs, and hostile ones
built entry by entry, because the read-only audit reads a downloaded archive.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import gzip
import hashlib
import io
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_contract as contract  # noqa: E402
from test_community_release import bundle, digest  # noqa: E402
from test_release_contract import locks, manifest_arguments  # noqa: E402

SERVER_VERSION = "1.1.4"
AMD64, ARM64 = contract.RELEASE_MANIFEST_PLATFORMS


def elf(platform: str, word: int = 2) -> bytes:
    """An ELF header for `platform`'s machine; nothing else about it is read."""
    header = bytearray(b"\x7fELF" + bytes([word, 1, 1]) + bytes(57))
    header[18:20] = contract.SERVER_ARCHIVE_MACHINES[platform].to_bytes(2, "little")
    return bytes(header) + b"SENTINEL-SERVER-BINARY"


def server_tree(root: Path, platform: str, plugin: bytes) -> Path:
    """One `server-dist` export, laid out as the Dockerfile stage writes it."""
    tree = Path(tempfile.mkdtemp(dir=root)) / platform.replace("/", "-")
    (tree / "dashboard").mkdir(parents=True)
    (tree / "plugin").mkdir()
    (tree / "obsyncd").write_bytes(elf(platform))
    (tree / "obsyncd.service").write_text("[Service]\nExecStart=/opt/obsync/obsyncd serve\n")
    (tree / "LICENSE").write_text("SENTINEL LICENSE\n")
    (tree / "dashboard/index.html").write_text("<!doctype html>\n")
    (tree / "dashboard/app.js").write_text("// sentinel\n")
    with zipfile.ZipFile(io.BytesIO(plugin)) as archive:
        for name in contract.PLUGIN_FILES:
            (tree / "plugin" / name).write_bytes(archive.read(name))
    return tree


def server_archives(root: Path, version: str = SERVER_VERSION, plugin: bytes | None = None) -> dict:
    plugin = bundle(version) if plugin is None else plugin
    return {platform: contract.build_server_archive(server_tree(root, platform, plugin), version, platform)
            for platform in contract.RELEASE_MANIFEST_PLATFORMS}


def fixed_bundle(version: str) -> bytes:
    """A plugin bundle whose bytes do not depend on the clock."""
    with zipfile.ZipFile(io.BytesIO(bundle(version))) as archive:
        return bundle(version, {zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0)): archive.read(name)
                                for name in contract.PLUGIN_FILES})


def server_arguments(root: Path, version: str = SERVER_VERSION) -> dict:
    data = bundle(version)
    return manifest_arguments(version=version, plugin_digest=digest(data), plugin_bundle=data,
                              server_archives=server_archives(root, version, data))


def entries(data: bytes) -> list[tuple[tarfile.TarInfo, bytes | None]]:
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        return [(item, archive.extractfile(item).read() if item.isreg() else None) for item in archive]


def pack(members: list[tuple[tarfile.TarInfo, bytes | None]]) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
        for info, data in members:
            info = copy.copy(info)
            if data is not None:
                info.size = len(data)
            archive.addfile(info, io.BytesIO(data) if data is not None else None)
    return raw.getvalue()


class TempRoot(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)


class Packing(TempRoot):
    def test_the_same_tree_always_packs_to_the_same_rooted_bytes(self):
        plugin = bundle(SERVER_VERSION)
        tree = server_tree(self.root, ARM64, plugin)
        first = contract.build_server_archive(tree, SERVER_VERSION, ARM64)
        for path in tree.rglob("*"):
            path.touch()  # a fresh export has fresh timestamps; the bytes must not care
        self.assertEqual(first, contract.build_server_archive(tree, SERVER_VERSION, ARM64))
        self.assertEqual(first[4:8], bytes(4), "the gzip header carries no time")
        top = f"obsync-server-{SERVER_VERSION}-linux-arm64"
        members = entries(first)
        self.assertEqual([info.name for info, _ in members], sorted(info.name for info, _ in members))
        self.assertEqual(members[0][0].name, top)
        for info, _ in members:
            with self.subTest(member=info.name):
                self.assertEqual((info.uid, info.gid, info.mtime), (0, 0, contract.SERVER_ARCHIVE_MTIME))
                self.assertTrue(info.name == top or info.name.startswith(top + "/"))
                self.assertEqual(info.mode, 0o755 if info.isdir() or info.name.endswith("/obsyncd") else 0o644)

    def test_a_link_in_the_export_is_refused_rather_than_followed(self):
        tree = server_tree(self.root, ARM64, bundle(SERVER_VERSION))
        (tree / "dashboard/elsewhere.js").symlink_to(tree / "LICENSE")
        with self.assertRaisesRegex(contract.ContractError, "other than files and directories"):
            contract.build_server_archive(tree, SERVER_VERSION, ARM64)

    def test_names_follow_the_tag_and_platform(self):
        self.assertEqual(contract.server_archive_asset_name("1.1.4", AMD64),
                         "obsync-server-1.1.4-linux-amd64.tar.gz")
        for tag, platform in (("v1.1.4", AMD64), ("1.1.4", "linux/arm/v7"), ("1.1.4", "linux_amd64")):
            with self.subTest(tag=tag, platform=platform), self.assertRaises(contract.ContractError):
                contract.server_archive_asset_name(tag, platform)


class Evidence(TempRoot):
    def test_a_server_release_binds_both_archives_by_name_digest_and_size(self):
        args = server_arguments(self.root)
        record = contract.build_release_manifest(**args)
        archives = record["artifacts"]["server_archives"]
        self.assertEqual(set(archives), {AMD64, ARM64})
        for platform, data in args["server_archives"].items():
            self.assertEqual(archives[platform], {
                "name": contract.server_archive_asset_name(SERVER_VERSION, platform),
                "digest": digest(data), "size": len(data)})
        contract.validate_release_manifest_record(record, **args)
        notes = contract.build_release_notes(record, locks(SERVER_VERSION, ["1.1.3"])["CHANGELOG.md"])
        for platform in (AMD64, ARM64):
            self.assertIn(f"| Server ({platform}) | `{archives[platform]['name']}` "
                          f"(`{archives[platform]['digest']}`) |", notes)
        self.assertIn("gh attestation verify", notes)

    def test_a_server_release_requires_one_archive_per_platform(self):
        args = server_arguments(self.root)
        for archives in (None, {}, {AMD64: args["server_archives"][AMD64]},
                         {**args["server_archives"], "linux/arm/v7": b"x"}):
            with self.subTest(archives=None if archives is None else sorted(archives)):
                with self.assertRaisesRegex(contract.ContractError, "one archive per production platform"):
                    contract.build_release_manifest(**{**args, "server_archives": archives})

    def test_a_changed_archive_digest_cannot_pass_as_the_evidence(self):
        args = server_arguments(self.root)
        record = contract.build_release_manifest(**args)
        for field, value in (("digest", "sha256:" + "f" * 64), ("size", 1), ("name", "foreign.tar.gz")):
            bad = copy.deepcopy(record)
            bad["artifacts"]["server_archives"][AMD64][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(contract.ContractError, "canonical"):
                contract.validate_release_manifest_record(bad, **args)
        swapped = {AMD64: args["server_archives"][ARM64], ARM64: args["server_archives"][AMD64]}
        with self.assertRaises(contract.ContractError):
            contract.validate_release_manifest_record(record, **{**args, "server_archives": swapped})

    def test_releases_before_the_boundary_refuse_archives_and_keep_their_bytes(self):
        data = fixed_bundle("1.1.3")
        args = manifest_arguments(version="1.1.3", plugin_digest=digest(data), plugin_bundle=data)
        record = contract.build_release_manifest(**args)
        self.assertNotIn("server_archives", record["artifacts"])
        # The 1.1.3 evidence and notes, byte for byte as the publisher before
        # this change produced them: the audit re-derives immutable releases.
        self.assertEqual(hashlib.sha256(contract._canonical_json(record)).hexdigest(),
                         "6521443fcdefcf867a55366a91ddc3589dab704dc03289b22bd814f0bc19ddaf")
        notes = contract.build_release_notes(record, locks("1.1.3", ["1.1.2"])["CHANGELOG.md"])
        self.assertEqual(hashlib.sha256(notes.encode()).hexdigest(),
                         "5d4104f010f12090f5f027882e5c1c61a248f0433600c65efdd6b0f28bf7bbee")
        with self.assertRaisesRegex(contract.ContractError, "predates the server archives"):
            contract.build_release_manifest(**{**args, "server_archives": server_archives(self.root, "1.1.3")})


class Inventory(TempRoot):
    ACTOR = {"login": "github-actions[bot]", "id": 41898282}

    def release(self, version, evidence, args, archives=None):
        manifest = contract._canonical_json(evidence)
        tag = evidence["release"]["tag"]
        assets = [
            {"name": f"obsync-{tag}-release-manifest.json", "size": len(manifest),
             "digest": digest(manifest), "content_type": "application/json"},
            {"name": f"obsync-plugin-{tag}.zip", "digest": args["plugin_digest"],
             "content_type": "application/zip"},
            *[{"name": name, **record} for name, record in evidence["artifacts"]["plugin_files"].items()],
            *[{"name": contract.server_archive_asset_name(tag, platform), "size": len(data),
               "digest": digest(data), "content_type": "application/gzip"}
              for platform, data in (archives or {}).items()],
        ]
        for asset in assets:
            asset.update(uploader=self.ACTOR, state="uploaded")
        record = dict(author=self.ACTOR, tag_name=tag, name="obsync " + tag, body="notes",
                      prerelease=False, draft=False, immutable=True, assets=assets)
        expected = dict(tag=tag, title="obsync " + tag, body="notes", manifest=manifest,
                        plugin_digest=args["plugin_digest"])
        return record, expected

    def accepted(self, record, expected):
        try:
            contract.validate_release_record(record, **expected)
        except contract.ContractError as exc:
            self.fail(f"the exact release was refused: {exc}")

    def test_a_server_release_carries_exactly_seven_assets(self):
        args = server_arguments(self.root)
        record, expected = self.release(SERVER_VERSION, contract.build_release_manifest(**args),
                                        args, args["server_archives"])
        self.accepted(record, expected)
        for index in (5, 6):
            with self.subTest(dropped=record["assets"][index]["name"]):
                bad = {**record, "assets": record["assets"][:index] + record["assets"][index + 1:]}
                with self.assertRaisesRegex(contract.ContractError, "exact versioned asset inventory"):
                    contract.validate_release_record(bad, **expected)
        for field, value in (("digest", "sha256:" + "f" * 64), ("size", 1),
                             ("content_type", "application/octet-stream"), ("name", "foreign.tar.gz")):
            bad = copy.deepcopy(record)
            bad["assets"][6][field] = value
            with self.subTest(field=field), self.assertRaises(contract.ContractError):
                contract.validate_release_record(bad, **expected)

    def test_evidence_must_name_both_archives_with_their_own_names(self):
        args = server_arguments(self.root)
        evidence = contract.build_release_manifest(**args)
        for change, refusal in (("absent", "server archive assets must be a JSON object"),
                                ("missing", "one server archive per production platform"),
                                ("renamed", "name or size is invalid"),
                                ("oversize", "name or size is invalid")):
            bad = copy.deepcopy(evidence)
            if change == "absent":
                del bad["artifacts"]["server_archives"]
            elif change == "missing":
                del bad["artifacts"]["server_archives"][ARM64]
            elif change == "renamed":
                bad["artifacts"]["server_archives"][ARM64]["name"] = "obsync-server.tar.gz"
            else:
                bad["artifacts"]["server_archives"][ARM64]["size"] = contract.SERVER_ARCHIVE_MAX_BYTES + 1
            record, expected = self.release(SERVER_VERSION, bad, args, args["server_archives"])
            with self.subTest(change=change), self.assertRaisesRegex(contract.ContractError, refusal):
                contract.validate_release_record(record, **expected)

    def test_a_release_before_the_boundary_refuses_archive_assets(self):
        data = bundle("1.1.3")
        args = manifest_arguments(version="1.1.3", plugin_digest=digest(data), plugin_bundle=data)
        evidence = contract.build_release_manifest(**args)
        record, expected = self.release("1.1.3", evidence, args)
        self.accepted(record, expected)
        record, expected = self.release("1.1.3", evidence, args, server_archives(self.root, "1.1.3"))
        with self.assertRaisesRegex(contract.ContractError, "exact versioned asset inventory"):
            contract.validate_release_record(record, **expected)


class HostileArchives(TempRoot):
    """What the audit may download. Each shape is refused before it is trusted."""

    def setUp(self):
        super().setUp()
        self.plugin = bundle(SERVER_VERSION)
        self.files = contract.plugin_asset_records(self.plugin, contract.Version.parse(SERVER_VERSION),
                                                   digest(self.plugin))
        self.good = server_archives(self.root, plugin=self.plugin)
        self.top = f"obsync-server-{SERVER_VERSION}-linux-amd64"

    def records(self, amd64: bytes) -> dict:
        return contract.server_archive_records({**self.good, AMD64: amd64},
                                               contract.Version.parse(SERVER_VERSION), self.files)

    def edited(self, name: str, **changes) -> bytes:
        members = []
        for info, data in entries(self.good[AMD64]):
            if info.name == f"{self.top}/{name}":
                info = copy.copy(info)
                data = changes.pop("data", data)
                for field, value in changes.items():
                    setattr(info, field, value)
            members.append((info, data))
        return pack(members)

    def added(self, info: tarfile.TarInfo, data: bytes | None = None) -> bytes:
        info.uid = info.gid = 0
        info.mode = info.mode or 0o644
        return pack(entries(self.good[AMD64]) + [(info, data)])

    def test_the_good_archives_are_accepted(self):
        self.assertEqual(set(self.records(self.good[AMD64])), {AMD64, ARM64})

    def test_entries_outside_the_one_directory_or_repeated_are_refused(self):
        for name in ("../escape", f"{self.top}/../escape", "/etc/passwd", "other/obsyncd",
                     f"{self.top}//LICENSE", f"{self.top}/./LICENSE", f"{self.top}/LICENSE"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(contract.ContractError, "outside its directory or repeated"):
                    self.records(self.added(tarfile.TarInfo(name), b"x"))

    def test_links_devices_and_foreign_files_are_refused(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE,
                     tarfile.GNUTYPE_SPARSE, tarfile.CONTTYPE, tarfile.AREGTYPE):
            info = tarfile.TarInfo(f"{self.top}/dashboard/extra.js")
            info.type, info.linkname = kind, f"{self.top}/LICENSE"
            with self.subTest(kind=kind), self.assertRaisesRegex(contract.ContractError, "foreign, linked"):
                self.records(self.added(info))
        for name in ("extra.bin", "plugin/extra.js", "bin/obsyncd"):
            with self.subTest(name=name), self.assertRaisesRegex(contract.ContractError, "foreign, linked"):
                self.records(self.added(tarfile.TarInfo(f"{self.top}/{name}"), b"x"))
        # A dashboard file the release has not seen before is the dashboard's
        # own business: new stylesheets ship without a contract edit.
        self.records(self.added(tarfile.TarInfo(f"{self.top}/dashboard/new.css"), b"x"))

    def test_extension_headers_are_refused(self):
        """The publisher writes USTAR; a PAX or GNU header would rename or resize an entry."""
        member = tarfile.TarInfo(f"{self.top}/dashboard/extra.css")
        member.mode, member.pax_headers = 0o644, {"comment": "x"}
        shapes = {
            "pax member": (tarfile.PAX_FORMAT, {}, member),
            "pax global": (tarfile.PAX_FORMAT, {"comment": "x"}, tarfile.TarInfo(f"{self.top}/dashboard/extra.css")),
            "gnu long name": (tarfile.GNU_FORMAT, {}, tarfile.TarInfo(f"{self.top}/dashboard/{'x' * 120}.css")),
        }
        for label, (form, overall, info) in shapes.items():
            info.mode = 0o644
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode="w:gz", format=form, pax_headers=overall) as archive:
                for entry, data in entries(self.good[AMD64]) + [(info, b"x")]:
                    entry = copy.copy(entry)
                    entry.size = len(data) if data is not None else 0
                    archive.addfile(entry, io.BytesIO(data) if data is not None else None)
            with self.subTest(shape=label), self.assertRaisesRegex(contract.ContractError, "not plain USTAR"):
                self.records(packed.getvalue())

    def test_owner_and_mode_must_keep_the_program_unwritable_by_its_user(self):
        for name, change in (("LICENSE", {"uid": 65532}), ("LICENSE", {"gid": 65532}),
                             ("dashboard/index.html", {"mode": 0o664}), ("LICENSE", {"mode": 0o646}),
                             ("obsyncd", {"mode": 0o4755}), ("obsyncd", {"mode": 0o644}),
                             ("dashboard", {"mode": 0o775})):
            with self.subTest(name=name, change=change):
                with self.assertRaisesRegex(contract.ContractError, "owner or mode"):
                    self.records(self.edited(name, **change))

    def test_every_required_file_must_be_present_and_nonempty(self):
        for name in contract.SERVER_ARCHIVE_FILES:
            with self.subTest(name=name):
                kept = [(info, data) for info, data in entries(self.good[AMD64])
                        if info.name != f"{self.top}/{name}"]
                with self.assertRaisesRegex(contract.ContractError, "lacks a required file"):
                    self.records(pack(kept))
                with self.assertRaisesRegex(contract.ContractError, "lacks a required file"):
                    self.records(self.edited(name, data=b""))

    def test_the_binary_must_be_a_64_bit_executable_for_its_own_platform(self):
        for data in (elf(ARM64), elf(AMD64, word=1), b"#!/bin/sh\n" + bytes(64)):
            with self.subTest(head=data[:20]):
                with self.assertRaisesRegex(contract.ContractError, "for its platform"):
                    self.records(self.edited("obsyncd", data=data))

    def test_the_plugin_files_must_be_the_released_plugin(self):
        for name in contract.PLUGIN_FILES:
            with self.subTest(name=name):
                with self.assertRaisesRegex(contract.ContractError, "differ from the released plugin"):
                    self.records(self.edited(f"plugin/{name}", data=b"another plugin"))

    def test_unreadable_and_oversized_archives_are_refused(self):
        # A stream cut short of its gzip trailer still inflates to the whole
        # tar, and an extractor reports it as damaged all the same.
        for data in (b"not gzip", self.good[AMD64][:-40], self.good[AMD64][:-8], b"",
                     self.good[AMD64] + gzip.compress(b"x")):
            with self.subTest(size=len(data)), self.assertRaisesRegex(contract.ContractError, "unreadable|empty"):
                self.records(data)
        budgets = contract.SERVER_ARCHIVE_MAX_BYTES, contract.SERVER_ARCHIVE_MAX_ENTRIES
        try:
            contract.SERVER_ARCHIVE_MAX_BYTES = len(self.good[AMD64]) - 1
            with self.assertRaisesRegex(contract.ContractError, "is empty or exceeds its budget"):
                self.records(self.good[AMD64])
            contract.SERVER_ARCHIVE_MAX_BYTES = budgets[0]
            big = self.added(tarfile.TarInfo(f"{self.top}/dashboard/big.bin"), bytes(4096))
            contract.SERVER_ARCHIVE_MAX_BYTES = len(big) + 1
            with self.assertRaisesRegex(contract.ContractError, "exceeds its budget once decompressed"):
                self.records(big)
            # Metadata counts as well as files (review of c4668d4): every
            # file fits the budget and only the header describing one breaks it.
            contract.SERVER_ARCHIVE_MAX_BYTES = budgets[0]
            extra = tarfile.TarInfo(f"{self.top}/dashboard/extra.css")
            extra.mode, extra.size, extra.pax_headers = 0o644, 1, {"comment": "x" * (1 << 20)}
            packed = io.BytesIO()
            with tarfile.open(fileobj=packed, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
                for info, data in entries(self.good[AMD64]) + [(extra, b"x")]:
                    archive.addfile(info, io.BytesIO(data) if data is not None else None)
            contract.SERVER_ARCHIVE_MAX_BYTES = len(gzip.decompress(self.good[AMD64])) + 4096
            self.assertLess(len(packed.getvalue()), contract.SERVER_ARCHIVE_MAX_BYTES)
            with self.assertRaisesRegex(contract.ContractError, "exceeds its budget once decompressed"):
                self.records(packed.getvalue())
            contract.SERVER_ARCHIVE_MAX_BYTES = budgets[0]
            contract.SERVER_ARCHIVE_MAX_ENTRIES = len(entries(self.good[AMD64])) - 1
            with self.assertRaisesRegex(contract.ContractError, "outside its directory or repeated"):
                self.records(self.good[AMD64])
        finally:
            contract.SERVER_ARCHIVE_MAX_BYTES, contract.SERVER_ARCHIVE_MAX_ENTRIES = budgets


class CommandLine(TempRoot):
    def test_the_publisher_command_writes_the_archive_the_contract_accepts(self):
        plugin = bundle(SERVER_VERSION)
        tree = server_tree(self.root, AMD64, plugin)
        output, printed = self.root / "out.tar.gz", io.StringIO()
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(contract.main(["server-archive", "--source", str(tree), "--tag", SERVER_VERSION,
                                            "--platform", AMD64, "--output", str(output)]), 0)
            self.assertNotEqual(contract.main(["server-archive", "--source", str(tree), "--tag", "v1.1.4",
                                               "--platform", AMD64, "--output", str(output)]), 0)
        self.assertEqual(output.read_bytes(), contract.build_server_archive(tree, SERVER_VERSION, AMD64))
        self.assertEqual(printed.getvalue(), digest(output.read_bytes()) + "\n")

    def test_archive_arguments_are_one_path_per_platform_and_bounded(self):
        args = server_arguments(self.root)
        paths = {}
        for platform, data in args["server_archives"].items():
            paths[platform] = self.root / platform.replace("/", "-")
            paths[platform].write_bytes(data)
        namespace = argparse.Namespace(**{key: value for key, value in args.items()
                                          if key != "server_archives"})
        namespace.plugin_bundle = self.root / "plugin.zip"
        namespace.plugin_bundle.write_bytes(args["plugin_bundle"])
        namespace.server_archive = [f"{platform}={path}" for platform, path in paths.items()]
        parsed = contract._manifest_arguments(namespace)
        self.assertEqual(parsed["server_archives"], args["server_archives"])
        for entries_ in ([f"{AMD64}={paths[AMD64]}", f"{AMD64}={paths[AMD64]}"], [AMD64], [f"{AMD64}="]):
            namespace.server_archive = entries_
            with self.subTest(entries=entries_), self.assertRaisesRegex(contract.ContractError, "PLATFORM=PATH"):
                contract._manifest_arguments(namespace)
        budget = contract.SERVER_ARCHIVE_MAX_BYTES
        try:
            contract.SERVER_ARCHIVE_MAX_BYTES = 10
            namespace.server_archive = [f"{AMD64}={paths[AMD64]}"]
            self.assertEqual(len(contract._manifest_arguments(namespace)["server_archives"][AMD64]), 11)
        finally:
            contract.SERVER_ARCHIVE_MAX_BYTES = budget


if __name__ == "__main__":
    unittest.main()
