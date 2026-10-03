"""Closed CLI release archive. Build/audit tooling only; no extraction or execution."""
from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import struct
import zipfile
from pathlib import Path

CLI_MAX_BYTES = 8 * 1024 * 1024
CLI_RUNTIME = {"name": "native-rust", "version": "1.98.0", "delivery": "included"}
CLI_PLATFORMS = ("linux-amd64", "linux-arm64", "darwin-arm64", "windows-amd64")


def cli_files(platform: str) -> list[str]:
    if platform not in CLI_PLATFORMS:
        raise ValueError("unsupported CLI platform")
    return sorted(["LICENSE", "README.md", "VERSION", "obsync.exe" if platform == "windows-amd64" else "obsync"])


def member_mode(name: str) -> int:
    return 0o700 if name in ("obsync", "obsync.exe") else 0o600


def _object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate CLI manifest field")
        value[key] = item
    return value


def cli_archive_record(data: bytes | None, version: str, source_sha: str, platform: str) -> dict:
    files = cli_files(platform)
    if not isinstance(data, bytes) or not 0 < len(data) <= CLI_MAX_BYTES:
        raise ValueError("CLI archive is required and bounded")
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha) or source_sha == "0" * 40:
        raise ValueError("CLI source SHA is invalid")
    if len(data) < 22:
        raise ValueError("CLI archive is truncated")
    signature, disk, central_disk, disk_count, count, size, offset, comment = struct.unpack('<4s4H2IH', data[-22:])
    if signature != b'PK\x05\x06' or disk or central_disk or disk_count != count or comment or offset + size + 22 != len(data):
        raise ValueError("CLI archive framing is invalid")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if count != len(entries) or not entries or entries[0].header_offset != 0:
            raise ValueError("CLI archive framing is invalid")
        if [entry.filename for entry in entries] != sorted([*files, "package-manifest.json"]):
            raise ValueError("CLI archive requires its exact ordered inventory")
        if sum(entry.file_size for entry in entries) > CLI_MAX_BYTES:
            raise ValueError("CLI uncompressed byte budget exceeded")
        for entry in entries:
            if (entry.flag_bits & 1 or entry.extra or entry.comment or
                    entry.date_time != (1980, 1, 1, 0, 0, 0) or
                    entry.external_attr >> 16 != stat.S_IFREG | member_mode(entry.filename) or
                    entry.compress_type != zipfile.ZIP_DEFLATED or entry.file_size <= 0):
                raise ValueError("CLI member type, mode, framing or size is invalid")
        raw = archive.read("package-manifest.json")
        if len(raw) > 16384:
            raise ValueError("CLI manifest exceeds its budget")
        manifest = json.loads(raw, object_pairs_hook=_object)
        if (set(manifest) != {"schema_version", "version", "platform", "source_sha", "candidate", "files"} or
                manifest["schema_version"] != 2 or isinstance(manifest["schema_version"], bool) or
                manifest["version"] != version or manifest["platform"] != platform or
                manifest["source_sha"] != source_sha or manifest["candidate"] is not False):
            raise ValueError("CLI package must bind exact version, native platform and protected source")
        if not isinstance(manifest["files"], list) or len(manifest["files"]) != len(files):
            raise ValueError("CLI manifest inventory is invalid")
        for name, item in zip(files, manifest["files"]):
            if not isinstance(item, dict) or set(item) != {"name", "size", "sha256"}:
                raise ValueError("CLI file record is invalid")
            member = archive.read(name)
            if (item["name"] != name or isinstance(item["size"], bool) or item["size"] != len(member) or
                    item["sha256"] != hashlib.sha256(member).hexdigest()):
                raise ValueError("CLI member differs from its bound inventory")
        if archive.read("VERSION").decode().strip() != version:
            raise ValueError("CLI VERSION differs from the release")
    return {"name": f"obsync-cli-{version}-{platform}.zip", "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
            "size": len(data), "content_type": "application/zip", "runtime": dict(CLI_RUNTIME),
            "manifest_sha256": hashlib.sha256(raw).hexdigest()}


def pack_cli(source: Path, output: Path, platform: str) -> None:
    files = cli_files(platform)
    actual = sorted(str(path.relative_to(source)) for path in source.rglob("*") if not path.is_dir())
    if actual != sorted([*files, "package-manifest.json"]):
        raise ValueError("CLI build directory inventory is invalid")
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        total = 0
        for name in actual:
            path = source / name
            if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
                raise ValueError("CLI archive source must be regular unlinked files")
            with path.open("rb") as stream:
                member = stream.read(CLI_MAX_BYTES + 1)
            total += len(member)
            if total > CLI_MAX_BYTES:
                raise ValueError("CLI build exceeds its budget")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | member_mode(name)) << 16
            archive.writestr(info, member, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    output.write_bytes(result.getvalue())


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--platform", choices=CLI_PLATFORMS, required=True)
    args = parser.parse_args()
    pack_cli(args.source, args.output, args.platform)
    cli_archive_record(args.output.read_bytes(), args.version, args.source_sha, args.platform)
