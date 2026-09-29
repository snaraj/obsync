#!/usr/bin/env python3
"""Reproduce the static-server-archive release guard probes from the repository root.

Each probe mutates one guard and must make the named suite fail with an
assertion (a unittest `FAIL:`), not merely an error. Sources are restored from
their exact starting bytes in finally, including on failure or interrupt.
Never run beside another editor in this worktree.
"""
from pathlib import Path
import os
import subprocess

CONTRACT = "scripts/ci/release_contract.py"
VERIFIER = "scripts/ci/verify-native-provenance.sh"
PUBLISHER = ".github/workflows/release-publisher.yml"
AUDIT = ".github/workflows/release-audit.yml"
UNIT = ("test_server_archives.py", None)
PUBLISH = ("test_native_publication_steps.py", "server_release_publishes")
EXPORT = ("test_native_publication_steps.py", "server_export_is_reproducible")
AUDITED = ("test_native_publication_steps.py", "audit_of_a_server_release")
CASES = [
    ("version-boundary", CONTRACT, "return (self.major, self.minor, self.patch) >= SERVER_ARCHIVES_FROM", "return False", UNIT),
    ("predates-refused", CONTRACT, "    elif server_archives is not None:\n", "    elif False:\n", UNIT),
    ("archive-budget", CONTRACT, "if not 0 < len(data) <= SERVER_ARCHIVE_MAX_BYTES:", "if not data:", UNIT),
    ("one-top-directory", CONTRACT, "if (parts[0] != top or item.name in seen", "if (item.name in seen", UNIT),
    ("no-repeats", CONTRACT, "if (parts[0] != top or item.name in seen", "if (parts[0] != top", UNIT),
    ("entry-budget", CONTRACT, " or len(seen) >= SERVER_ARCHIVE_MAX_ENTRIES\n", "\n", UNIT),
    ("no-dot-segments", CONTRACT, "or any(part in {\"\", \".\", \"..\"} for part in parts)):", "or False):", UNIT),
    ("root-owned-unwritable", CONTRACT, "if item.uid or item.gid or item.mode & 0o7022 or (", "if (", UNIT),
    ("executable-binary", CONTRACT, "inner == \"obsyncd\" and item.mode & 0o777 != 0o755):", "False):", UNIT),
    ("regular-files-only", CONTRACT, "if (not item.isreg() or expanded", "if (expanded", UNIT),
    ("expanded-budget", CONTRACT, "expanded > SERVER_ARCHIVE_MAX_BYTES or", "False or", UNIT),
    ("closed-inventory", CONTRACT, "(inner not in SERVER_ARCHIVE_FILES and not inner.startswith(\"dashboard/\"))):", "False):", UNIT),
    ("required-files", CONTRACT, "if any(not files.get(member) for member in SERVER_ARCHIVE_FILES):", "if False:", UNIT),
    ("elf-machine", CONTRACT, "or machine != SERVER_ARCHIVE_MACHINES[platform]:", ":", UNIT),
    ("elf-64-bit", CONTRACT, "if binary[:5] != b\"\\x7fELF\\x02\" or", "if binary[:4] != b\"\\x7fELF\" or", UNIT),
    ("same-plugin", CONTRACT, "record, \"native plugin asset\").get(\"digest\"):", "record, \"native plugin asset\").get(\"digest\") and False:", UNIT),
    ("fixed-time", CONTRACT, "SERVER_ARCHIVE_MTIME, 0, 0, \"root\", \"root\")", "int(path.stat().st_mtime), 0, 0, \"root\", \"root\")", UNIT),
    ("root-owner", CONTRACT, "SERVER_ARCHIVE_MTIME, 0, 0, \"root\", \"root\")", "SERVER_ARCHIVE_MTIME, 65532, 65532, \"root\", \"root\")", UNIT),
    ("gzip-no-time", CONTRACT, "fileobj=packed, mtime=0,", "fileobj=packed, mtime=None,", UNIT),
    ("export-links-refused", CONTRACT, "if path.is_symlink() or not (path.is_dir() or path.is_file()):", "if not (path.is_dir() or path.is_file()):", UNIT),
    ("inventory-by-version", CONTRACT, "    if version.server_archives:\n        # Non-legacy", "    if False:\n        # Non-legacy", UNIT),
    ("inventory-names", CONTRACT, "if (record.get(\"name\") != name or isinstance(size, bool)", "if (isinstance(size, bool)", UNIT),
    ("notes-rows", CONTRACT, "            servers += f\"| Server ({platform})", "            servers += \"\" and f\"| Server ({platform})", UNIT),
    ("verifier-archives", VERIFIER, "\"${directory}/styles.css\" \\\n  \"${archives[@]}\"; do", "\"${directory}/styles.css\"; do", AUDITED),
    ("publisher-evidence", PUBLISHER, "--plugin-digest \"${PLUGIN_DIGEST}\" --plugin-bundle \"${PLUGIN_PATH}\"\n                  \"${server[@]}\")", "--plugin-digest \"${PLUGIN_DIGEST}\" --plugin-bundle \"${PLUGIN_PATH}\")", EXPORT),
    ("publisher-uploads", PUBLISHER, "            assets+=(\"${SERVER_AMD64}\" \"${SERVER_ARM64}\")\n", "", PUBLISH),
    ("publisher-content-type", PUBLISHER, "                *.tar.gz) content_type=application/gzip ;;\n", "", PUBLISH),
    ("audit-evidence", AUDIT, "              server+=(--server-archive \"linux/${arch}=${observed}\")\n", "", AUDITED),
    ("audit-provenance", AUDIT, "            SERVER_ARCHIVES=\"${server_archives}\" \\\n", "", AUDITED),
]


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    try:
        for name, path, old, new, (suite, pattern) in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                command = ["python3", "-B", "-m", "unittest", "discover", "-s", "scripts/ci", "-p", suite]
                if pattern:
                    command += ["-k", pattern]
                result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, timeout=600, check=False,
                                        env={**os.environ, "PYTHON_COLORS": "0", "NO_COLOR": "1"})
                failed = [line for line in result.stdout.splitlines() if "FAIL:" in line]
                ran = [line for line in result.stdout.splitlines() if line.startswith("Ran ")]
                killed = result.returncode != 0 and bool(failed)
                print(f"{name}: {'KILLED' if killed else 'NOT A KILL'} "
                      f"{len(failed)} failing / {ran[-1] if ran else 'no run'}", flush=True)
                if killed:
                    print("  " + "\n  ".join(sorted(set(failed))[:3]), flush=True)
                else:
                    failures.append(name)
                    print(result.stdout[-3000:], flush=True)
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} release probes were killed by an assertion.")


if __name__ == "__main__":
    main()
