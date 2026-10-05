#!/usr/bin/env python3
"""Issue 319: setup profiling and fixed-budget selection coverage under bounded load."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

from lab import external, save


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-repo", required=True, help="already-built checkout")
    parser.add_argument("--run", required=True, help="new external output directory")
    parser.add_argument("--mode", choices=["baseline", "baseline-full", "candidate"], required=True)
    parser.add_argument("--image", required=True, help="node:26.10.0-bookworm-slim@sha256:<digest>")
    args = parser.parse_args()
    if not re.fullmatch(r"node:26\.10\.0-bookworm-slim@sha256:[0-9a-f]{64}", args.image):
        raise ValueError("the exact Node image tag AND immutable digest are required")
    source, run = Path(args.source_repo).resolve(), external(args.run)
    if not (source / "plugin/build/main.js").is_file():
        raise ValueError("build the candidate plugin before the bounded run")
    package = json.loads((source / "plugin/package.json").read_text())
    compiler = json.loads((source / "plugin/node_modules/typescript/package.json").read_text())
    if compiler["version"] != package["devDependencies"]["typescript"]:
        raise ValueError("the source checkout must contain its exact pinned TypeScript compiler")
    if run.exists():
        raise ValueError("run directory already exists; never overwrite prior results")
    if shutil.disk_usage(run.parent).free < 20 * 1024 ** 3:
        raise ValueError("less than 20 GiB free")
    os.umask(0o077)
    run.mkdir(parents=True, mode=0o700)
    (run / "evidence").mkdir()
    save(run / "evidence/campaign.json", {"mode": args.mode})
    name = "obsync-load319-" + uuid.uuid4().hex[:12]
    existed = docker("image", "inspect", args.image, check=False).returncode == 0
    started = False
    try:
        if not existed:
            docker("pull", args.image)
        image_id = docker("image", "inspect", args.image, "--format", "{{.Id}}").stdout.strip()
        tracked = subprocess.check_output(["git", "-C", str(source), "ls-files", "-z"], text=True).split("\0")
        save(run / "evidence/source-files.json", [path for path in tracked if path])
        save(run / "evidence/build.json", {"sourceHead": subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip(),
             "sourceDirty": bool(subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"])),
             "image": args.image, "imageId": image_id, "cpu": 4, "memoryGiB": 8, "workers": 40,
             "container": name, "scratch": "container-native tmpfs, 2 GiB maximum"})
        command = ["run", "--name", name, "--cpus=4", "--memory=8g", "--memory-swap=8g", "--pids-limit=1024",
                   "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                   "--user", f"{os.getuid()}:{os.getgid()}",
                   "--mount", f"type=bind,src={source},dst=/source,readonly",
                   "--mount", f"type=bind,src={Path(__file__).with_suffix('.mjs')},dst=/runner.mjs,readonly",
                   "--mount", f"type=bind,src={run / 'evidence'},dst=/evidence",
                   "--tmpfs", "/scratch:rw,nosuid,nodev,noexec,size=2g,mode=1777",
                   args.image, "node", "/runner.mjs"]
        started = True
        with (run / "evidence/container.log").open("w") as log:
            result = subprocess.run(["docker", *command], stdout=log, stderr=log, timeout=45 * 15 * 60 + 60, check=False)
        print(json.dumps({"exit": result.returncode, "results": str(run / "evidence/results.json")}))
        return result.returncode
    finally:
        if started:
            docker("rm", "-f", name)
        container_absent = docker("container", "inspect", name, check=False).returncode != 0
        if not container_absent:
            raise RuntimeError("owned load container remains; scratch retained")
        removed_image = existed or docker("image", "rm", args.image, check=False).returncode == 0
        save(run / "evidence/teardown.json", {"containerAbsent": container_absent, "scratchAbsent": container_absent,
             "imagePreexisted": existed, "newImageRemoved": removed_image})
        if not removed_image:
            raise RuntimeError("task-pulled image remains in use; recorded without deleting shared images")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"bounded load run failed: {error}", file=sys.stderr)
        sys.exit(1)
