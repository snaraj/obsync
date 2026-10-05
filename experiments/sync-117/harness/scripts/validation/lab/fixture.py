#!/usr/bin/env python3
"""Create or verify reusable sentinel notes outside the repository."""
import argparse
import hashlib
import json
from pathlib import Path

from lab import external, save

LINE = "SPEED SENTINEL: fixture text for the obsync lab, repeated to give the note a realistic size.\n"


def note(number):
    return f"# Note {number:05d}\n\n" + LINE * 16


def verify(folder):
    record = json.loads((folder / "fixture.json").read_text())
    count = record.get("notes")
    if record.get("format") != 1 or not isinstance(count, int) or not 1 <= count <= 100000:
        raise ValueError("not a supported sentinel fixture")
    expected = {Path("Speed") / f"F{i // 100:03d}" / f"Note {i:05d}.md" for i in range(count)}
    actual = {p.relative_to(folder) for p in folder.rglob("*") if p.is_file() and p != folder / "fixture.json"}
    if actual != expected or any(p.is_symlink() for p in folder.rglob("*")):
        raise ValueError("fixture contains unexpected paths or links")
    digest = hashlib.sha256()
    size = 0
    for i, path in enumerate(sorted(expected)):
        content = (folder / path).read_bytes()
        if content != note(i).encode():
            raise ValueError("fixture sentinel bytes changed")
        digest.update(str(path).encode() + b"\0" + content)
        size += len(content)
    if record.get("sha256") != digest.hexdigest() or record.get("bytes") != size:
        raise ValueError("fixture digest differs")
    return record


def create(folder, count, reuse=True):
    if not 1 <= count <= 100000:
        raise ValueError("notes must be between 1 and 100000")
    if folder.exists():
        if not reuse:
            raise ValueError("generated fixture already exists")
        record = verify(folder)
        if record["notes"] != count:
            raise ValueError("existing fixture has another count")
        return record
    folder.mkdir(parents=True, mode=0o700)
    digest = hashlib.sha256()
    size = 0
    for i in range(count):
        relative = Path("Speed") / f"F{i // 100:03d}" / f"Note {i:05d}.md"
        target = folder / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        content = note(i).encode()
        target.write_bytes(content)
        digest.update(str(relative).encode() + b"\0" + content)
        size += len(content)
    record = {"format": 1, "notes": count, "bytes": size, "sha256": digest.hexdigest()}
    save(folder / "fixture.json", record)
    return record


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("--notes", type=int, default=7700)
    args = parser.parse_args()
    print(json.dumps(create(external(args.directory), args.notes)))
