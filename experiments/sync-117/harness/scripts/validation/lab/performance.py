#!/usr/bin/env python3
"""Alternate shown/minimized first-sync samples in a coordinator-declared quiet window."""
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import threading
import time

from fixture import create, verify
from lab import HERE, down, external, identity, load, save
from finalize import finalize


def top_samples(run, stop):
    """Only processes in this run's app process group; no global process inventory."""
    state = load(run)
    record = state["processes"]["A"]
    with (run / "evidence/top.txt").open("w") as output:
        while not stop.is_set():
            if identity(record["pid"]) != record["identity"]:
                return
            group = subprocess.run(["ps", "-g", str(record["pid"]), "-o", "pid="], capture_output=True, text=True, check=True)
            pids = [value for value in group.stdout.split() if value.isdigit()]
            if not pids:
                return
            command = ["top", "-l", "2", "-s", "1", "-stats", "pid,cpu,idlew,power"]
            for pid in pids:
                command += ["-pid", pid]
            output.write(f"sample_at={time.time()}\n")
            output.flush()
            subprocess.run(command, stdout=output, stderr=output, timeout=15, check=True)
            output.flush()
            stop.wait(10)


def finish_sample(run, launcher, monitor, stop):
    """A collector failure must not bypass app/server/holder teardown."""
    stop.set()
    failures = []
    if monitor:
        try:
            monitor.join(timeout=20)
        except BaseException as error:
            failures.append(type(error).__name__)
    try:
        if (run / "lab.json").exists():
            down(run)
        else:
            launcher.terminate()
    except BaseException as error:
        failures.append(type(error).__name__)
    try:
        launcher.wait(timeout=10)
    except BaseException as error:
        failures.append(type(error).__name__)
    if monitor and monitor.is_alive():
        failures.append("CollectorStillAlive")
    if failures:
        raise RuntimeError("sample cleanup incomplete: " + ", ".join(failures))
    if (run / "lab.json").exists():
        finalize(run)
    elif any((run / name).exists() or (run / name).is_symlink() for name in ("runtime", "private")):
        raise RuntimeError("startup left unmanifested fixtures; inspect before cleanup")


def discard_generated_fixture(batch, fixture, original, created_here, results):
    if not created_here:
        return {"createdHere": False, "removed": False, "callerSuppliedFixturePreserved": True}
    if any(not row.get("cleanupCompleted") for row in results):
        return {"createdHere": True, "removed": False, "reason": "sample cleanup unresolved"}
    if fixture.is_symlink() or verify(fixture) != original:
        raise RuntimeError("generated fixture changed; inspect before deletion")
    shutil.rmtree(fixture)
    return {"createdHere": True, "removed": not fixture.exists(), "callerSuppliedFixturePreserved": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-repo", required=True)
    parser.add_argument("--run", required=True, help="new external batch directory")
    parser.add_argument("--fixture", help="existing caller-owned sentinel directory; never deleted")
    parser.add_argument("--notes", type=int, default=7700)
    parser.add_argument("--pairs", type=int, choices=[1, 3], default=3, help="one pair calibrates tooling; acceptance requires three")
    args = parser.parse_args()
    source = Path(args.source_repo).expanduser().resolve()
    batch = external(args.run)
    if batch.exists():
        raise ValueError("batch directory already exists; prior results are immutable")
    os.umask(0o077)
    batch.mkdir(parents=True, mode=0o700)
    created_here = args.fixture is None
    fixture = batch / "fixture" if created_here else external(args.fixture)
    fixture_record = create(fixture, args.notes, reuse=False) if created_here else verify(fixture)
    if fixture_record["notes"] != args.notes:
        raise ValueError("caller fixture note count differs")
    save(batch / "fixture.json", {**fixture_record, "createdHere": created_here})
    results = []
    try:
        for index, mode in enumerate(["shown", "minimized"] * args.pairs, 1):
            run = batch / f"{index}-{mode}"
            record = {"sample": index, "mode": mode, "startLoad": os.getloadavg(), "started": time.time(), "result": "FAIL"}
            save(batch / "in-progress.json", record)
            command = [sys.executable, "-B", str(HERE / "lab.py"), "up", "--run", str(run), "--source-repo", str(source),
                       "--binary", str(source / "target/release/obsyncd"), "--plugin", str(source / "plugin/dist"),
                       "--fixture", str(fixture), "--devices", "1", "--hold"]
            launcher = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            monitor = None
            monitor_errors = []
            stop = threading.Event()
            try:
                if not select.select([launcher.stdout], [], [], 90)[0]:
                    raise TimeoutError("launcher readiness deadline")
                ready = json.loads(launcher.stdout.readline())
                if ready.get("ready") is not True:
                    raise RuntimeError("launcher did not report readiness")
                save(run / "evidence/start.json", record)
                with (run / "evidence/journeys.log").open("w") as output:
                    subprocess.run(["node", str(HERE / "journeys.mjs"), str(run), "init"], check=True, stdout=output, stderr=output, timeout=90)
                    subprocess.run(["node", str(HERE / "performance.mjs"), str(run), "prepare", mode, str(args.notes)], check=True, stdout=output, stderr=output, timeout=45)
                    def monitor_metrics():
                        try:
                            top_samples(run, stop)
                        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                            monitor_errors.append(type(error).__name__)
                    monitor = threading.Thread(target=monitor_metrics)
                    monitor.start()
                    subprocess.run(["node", str(HERE / "journeys.mjs"), str(run), "setup-first"], check=True, stdout=output, stderr=output, timeout=90)
                    subprocess.run(["node", str(HERE / "performance.mjs"), str(run), "measure", mode, str(args.notes)], check=True, stdout=output, stderr=output, timeout=4500)
                metrics = json.loads((run / "evidence/performance.json").read_text())
                record.update({key: metrics[key] for key in ("notesPerSecond", "syncNowMs", "seventhOverFirst", "savesPer100Notes", "minimizedMs")})
                record["result"] = "PASS"
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                record["reason"] = type(error).__name__
            finally:
                stop.set()
                try:
                    finish_sample(run, launcher, monitor, stop)
                    record["cleanupCompleted"] = True
                    if monitor_errors:
                        record.update({"result": "FAIL", "metricCollectorErrors": monitor_errors})
                except BaseException as error:
                    record.update({"result": "FAIL", "teardownFailure": type(error).__name__})
                    raise
                finally:
                    record.update({"durationSeconds": time.time() - record["started"], "endLoad": os.getloadavg()})
                    results.append(record)
                    save(batch / "results.json", results)
                    print(json.dumps(record), flush=True)
    finally:
        cleanup = discard_generated_fixture(batch, fixture, fixture_record, created_here, results)
        save(batch / "fixture-cleanup.json", cleanup)
    passed = len(results) == args.pairs * 2 and all(r["result"] == "PASS" for r in results)
    save(batch / "workflow.json", {"result": "PASS" if passed else "FAIL", "scenario": "performance",
         "runtimeAndPrivateFixturesAbsent": all(r.get("cleanupCompleted") for r in results),
         "generatedFixtureAbsent": cleanup.get("removed") if created_here else None})
    return 0 if len(results) == args.pairs * 2 and all(r["result"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
