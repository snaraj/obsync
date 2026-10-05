#!/usr/bin/env python3
"""Own a disposable, loopback-only desktop lab; never attach to an existing app."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
REPO = Path(os.environ["OBSYNC_LAB_SOURCE"]).expanduser().resolve()
COMMON = Path(subprocess.check_output(["git", "-C", str(REPO), "rev-parse",
              "--path-format=absolute", "--git-common-dir"], text=True).strip()).parent


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def external(path):
    path = Path(path).expanduser().resolve()
    if any(path == repo or repo in path.parents or path in repo.parents for repo in (REPO, COMMON)):
        raise ValueError("lab data must be outside the repository and its ancestors")
    return path


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def identity(pid):
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=,command="],
                            capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def reap(pid):
    try:
        os.waitpid(pid, os.WNOHANG)  # reap an up failure's own child, if any
    except ChildProcessError:
        pass


def owned_identity(record):
    reap(record["pid"])
    current = identity(record["pid"])
    if current is not None and current != record["identity"]:
        # During exit macOS can briefly report a changed command before the
        # child is reapable. Wait only for absence or the original identity;
        # a persistent different identity is never signalled.
        for _ in range(20):
            reap(record["pid"])
            current = identity(record["pid"])
            if current is None or current == record["identity"]:
                return current
            time.sleep(.05)
        raise RuntimeError("recorded process identity changed; no signal sent")
    return current


def group_alive(pid):
    reap(pid)
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS returns EPERM for an all-zombie group if exit races the reap.
        # Recheck after reaping our child; a real permission denial still raises.
        for _ in range(20):
            reap(pid)
            try:
                os.killpg(pid, 0)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                time.sleep(.05)
        raise RuntimeError("group absence cannot be verified after EPERM; no cleanup authorized")


def load(run):
    state = json.loads((run / "lab.json").read_text())
    if state.get("format") != 1 or state.get("run") != str(run):
        raise ValueError("not this lab's run manifest")
    for name, record in state["processes"].items():
        argv = record.get("argv", [])
        if name == "server":
            valid = argv == [str(run / "runtime/build/obsyncd"), "serve"]
        elif name in "ABC" and len(name) == 1:
            device = state["devices"].get(name, {})
            valid = device.get("userdata") == str(run / "runtime" / name / "userdata") and \
                device.get("vault") == str(run / "runtime" / name / ("Lab-" + name)) and \
                f"--user-data-dir={device.get('userdata')}" in argv
        elif name == "intermediary":
            valid = len(argv) == 5 and argv[1:] == [str(HERE / "intermediary.mjs"), str(state.get("front_port")), str(state["server_port"]), str(run / "private/faults.json")]
        else:
            valid = False
        if not valid or not isinstance(record.get("pid"), int) or record["pid"] <= 1 or not record.get("identity"):
            raise ValueError("process manifest does not describe an owned lab command")
    return state


def launch(run, state, name, argv, env=None):
    identity(os.getpid())  # require process inspection before creating anything
    with (run / "private" / (name + ".log")).open("ab") as log:
        child = subprocess.Popen(argv, stdout=log, stderr=log, env=env,
                                 start_new_session=True, stdin=subprocess.DEVNULL)
    try:
        recorded_identity = identity(child.pid)
        for _ in range(20):
            time.sleep(.05)
            current = identity(child.pid)
            if current == recorded_identity:
                break
            recorded_identity = current
        else:
            raise RuntimeError("new process identity did not settle")
        if recorded_identity is None:
            raise RuntimeError("new process exited before its identity was recorded")
    except BaseException:
        child.terminate()
        child.wait(timeout=5)
        raise
    record = {"pid": child.pid, "identity": recorded_identity, "argv": argv}
    state["processes"][name] = record
    save(run / "lab.json", state)
    return child


def wait_http(child, address, predicate, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("lab process exited; inspect its private log locally")
        try:
            with urllib.request.urlopen(address, timeout=1) as response:
                if predicate(json.load(response)):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.2)
    raise TimeoutError("lab readiness deadline; private logs retained")


def up(args, run):
    if run.exists() and any(run.iterdir()):
        raise ValueError("up requires a new or empty run directory")
    if shutil.disk_usage(run.parent).free < 20 * 1024 ** 3:
        raise ValueError("less than 20 GiB free; refusing a new lab")
    source = Path(args.source_repo).expanduser().resolve()
    binary, plugin, obsidian = (Path(p).expanduser().resolve() for p in
                                (args.binary, args.plugin, args.obsidian))
    for path in [binary, obsidian] + [plugin / f for f in ("main.js", "manifest.json", "styles.css")]:
        if not path.is_file():
            raise ValueError("a required built artifact or Obsidian executable is missing")
    fixture = external(args.fixture) if args.fixture else None
    if fixture:
        from fixture import verify
        verify(fixture)
    run.mkdir(mode=0o700, parents=True, exist_ok=True)
    run.chmod(0o700)
    for name in ("runtime", "private", "evidence"):
        (run / name).mkdir(mode=0o700)
    build = run / "runtime" / "build"
    build.mkdir()
    shutil.copy2(binary, build / "obsyncd")
    (build / "plugin").mkdir()
    for name in ("main.js", "manifest.json", "styles.css"):
        shutil.copy2(plugin / name, build / "plugin" / name)
    shutil.copytree(source / "dashboard", build / "dashboard")
    state = {"format": 1, "run": str(run), "processes": {}, "devices": {},
             "server_port": port(), "source_head": subprocess.check_output(
                 ["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip(),
             "source_dirty": bool(subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"])),
             "artifacts": {}}
    for path in [build / "obsyncd"] + sorted((build / "plugin").glob("*")):
        if path.is_file():
            state["artifacts"][str(path.relative_to(build))] = hashlib.sha256(path.read_bytes()).hexdigest()
    save(run / "lab.json", state)
    try:
        state["url"] = f"http://127.0.0.1:{state['server_port']}"
        state["transport"] = "loopback HTTP functional rehearsal; TLS performance NOT_RUN"
        if args.faults:
            state["front_port"] = port()
            save(run / "private/faults.json", {"walkCuts": 0, "chunkDelayMs": 0})
            launch(run, state, "intermediary", [shutil.which("node"), str(HERE / "intermediary.mjs"), str(state["front_port"]), str(state["server_port"]), str(run / "private/faults.json")])
            state["url"] = f"http://127.0.0.1:{state['front_port']}"
        server = run / "runtime" / "server"
        server.mkdir()
        for name in ("blobs", "journal"):
            (server / name).mkdir()
        env = {"PATH": os.defpath, "OBSYNC_EDGE": "none",
               "OBSYNC_LISTEN": f"127.0.0.1:{state['server_port']}",
               "OBSYNC_PUBLIC_URL": state["url"],
               "OBSYNC_BLOBS_DIR": str(server / "blobs"), "OBSYNC_JOURNAL_DIR": str(server / "journal"),
               "OBSYNC_BLOBS_CAPACITY": "20GiB", "OBSYNC_JOURNAL_CAPACITY": "8GiB",
               "OBSYNC_DASHBOARD_DIR": str(build / "dashboard"), "OBSYNC_PLUGIN_DIR": str(build / "plugin")}
        child = launch(run, state, "server", [str(build / "obsyncd"), "serve"], env)
        wait_http(child, f"http://127.0.0.1:{state['server_port']}/readyz", lambda answer: answer.get("ready") is True)
        for name in "ABC"[:args.devices]:
            device = run / "runtime" / name
            vault = device / ("Lab-" + name)
            userdata = device / "userdata"
            userdata.mkdir(parents=True)
            shutil.copytree(build / "plugin", vault / ".obsidian/plugins/obsync-private-sync")
            if fixture and name == "A":
                shutil.copytree(fixture / "Speed", vault / "Speed")
            save(vault / ".obsidian/community-plugins.json", ["obsync-private-sync"])
            save(userdata / "obsidian.json", {"updateDisabled": True})
            cdp_port = port()
            state["devices"][name] = {"vault": str(vault), "userdata": str(userdata), "port": cdp_port}
            child = launch(run, state, name, [str(obsidian), f"--user-data-dir={userdata}",
                           f"--remote-debugging-port={cdp_port}", "--remote-debugging-address=127.0.0.1",
                           "--use-mock-keychain"])
            wait_http(child, f"http://127.0.0.1:{cdp_port}/json/version", lambda answer: "Browser" in answer)
        save(run / "evidence/build.json", {key: state[key] for key in ("source_head", "source_dirty", "artifacts", "transport")})
    except BaseException:
        down(run, state)
        raise
def stop(record):
    pid = record["pid"]
    if not group_alive(pid):
        return
    current = owned_identity(record)
    # A process group created by this run includes its app helpers. Its id is
    # not reusable while a member remains; no name-based process kill is used.
    if current is None:
        raise RuntimeError("leader exited but its process group remains; inspect the owned group before cleanup")
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        # Exit can race the signal on macOS. Only actual group absence
        # resolves that race; a live permission denial remains an error.
        for _ in range(20):
            time.sleep(.05)
            if not group_alive(pid):
                return
        raise
    for _ in range(150):
        if not group_alive(pid):
            return
        time.sleep(.1)
    os.killpg(pid, signal.SIGKILL)
    for _ in range(50):
        if not group_alive(pid):
            return
        time.sleep(.1)
    raise RuntimeError("owned process group remains after termination; runtime preserved")


def down(run, state=None):
    state = state or load(run)
    recovered = False
    holder = state.get("holder")
    if holder and holder["pid"] != os.getpid():
        current = owned_identity(holder)
        if current is not None:
            # The holder reaps its children and exits after cleaning its runtime.
            # Waiting here proves a one-command down leaves no launcher behind.
            (run / "private/stop.json").write_text("{}\n")
            for _ in range(600):
                current = owned_identity(holder)
                if current is None:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError("launcher shutdown deadline; runtime retained for inspection")
            state = load(run)
            if not state.get("stopped"):
                # A helper can finish exiting between the holder's identity
                # check and its final cleanup. Resume only after independent
                # absence proof, without signalling an uncertain identity.
                if any(group_alive(record["pid"]) for record in state["processes"].values()):
                    raise RuntimeError("launcher exited with owned groups still present; runtime preserved")
                recovered = True
    failures = []
    for name, record in reversed(list(state["processes"].items())):
        try:
            stop(record)
        except (OSError, RuntimeError) as error:
            failures.append(f"{name}: {type(error).__name__}")
    if failures:
        raise RuntimeError("cleanup incomplete (" + ", ".join(failures) + "); runtime preserved")
    leftovers = [name for name, record in state["processes"].items() if group_alive(record["pid"])]
    if leftovers:
        raise RuntimeError("owned process groups remain; runtime preserved")
    # Delete only the directory created by up, after process absence proof.
    runtime = run / "runtime"
    if runtime.is_symlink():
        raise ValueError("runtime became a symlink; refusing cleanup")
    if runtime.exists():
        shutil.rmtree(runtime)
    state["stopped"] = True
    save(run / "lab.json", state)
    result = {"process_groups_remaining": 0, "runtime_exists": runtime.exists(),
              "holder_remaining": int(bool(holder and identity(holder["pid"]))),
              "controller_finished_cleanup_after_absence_proof": recovered,
              "retained": ["private", "evidence", "lab.json"]}
    save(run / "evidence/teardown.json", result)
    print(json.dumps(result))


def restart(run, name):
    state = load(run)
    if name not in state["devices"] or state.get("stopped"):
        raise ValueError("not an active owned device")
    holder = state.get("holder")
    if not holder:
        raise ValueError("restart requires a lab started with the current --hold helper")
    if holder["pid"] != os.getpid():
        if identity(holder["pid"]) != holder["identity"]:
            raise ValueError("owning launcher is no longer running")
        request = run / "private/restart.json"
        with request.open("x") as out:
            json.dump({"device": name}, out)
        previous = state["processes"][name]["pid"]
        for _ in range(450):
            state = load(run)
            if state["processes"][name]["pid"] != previous:
                print(json.dumps({"restarted": name}))
                return
            time.sleep(.1)
        raise TimeoutError("owning launcher did not complete restart; inspect private log")
    old = state["processes"][name]
    stop(old)
    child = launch(run, state, name, old["argv"])
    wait_http(child, f"http://127.0.0.1:{state['devices'][name]['port']}/json/version", lambda answer: "Browser" in answer)
    print(json.dumps({"restarted": name}))


def desktop(run, scenario="desktop"):
    # A separate holder services restart requests and can be observed absent
    # before this one-command rehearsal reports successful teardown.
    command = [sys.executable, "-B", str(HERE / "lab.py"), "up", *sys.argv[2:], "--hold"]
    holder = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        if not select.select([holder.stdout], [], [], 90)[0]:
            raise TimeoutError("desktop launcher readiness deadline")
        if json.loads(holder.stdout.readline()).get("ready") is not True:
            raise RuntimeError("desktop launcher did not report readiness")
        commands = ["init", "setup-first"] if scenario == "stage" else ["init", "setup-first", "pair"]
        if scenario == "desktop":
            commands += ["notes", "restart", "sweep"]
        for command in commands:
            result = subprocess.run(["node", str(HERE / "journeys.mjs"), str(run), command], timeout=180)
            if result.returncode:
                raise RuntimeError("desktop journey failed; prior evidence retained")
        if scenario in ("stage", "cotype", "editor", "throttle"):
            driver = {"stage": "stage-profile.mjs", "cotype": "cotype.mjs", "editor": "editor-save.mjs", "throttle": "throttle.mjs"}[scenario]
            subprocess.run(["node", str(HERE / driver), str(run)], timeout=1500 if scenario == "editor" else 420, check=True)
    finally:
        try:
            if (run / "lab.json").exists():
                down(run)
            else:
                holder.terminate()
        finally:
            holder.wait(timeout=10)
            rest = holder.stdout.read()
            if rest and (run / "private").is_dir():
                (run / "private/holder.log").write_text(rest)
    # Reaching this point requires both the scenario and teardown to succeed.
    # Discard every disposable account, history, profile and private log.
    from finalize import finalize
    finalize(run)
    if scenario in ("editor", "throttle"):
        path = run / ("evidence/editor-save.json" if scenario == "editor" else "evidence/throttle.json")
        result = json.loads(path.read_text())
        if result.get("result") != "SCENARIO_PASS" or (scenario == "editor" and result.get("hooksRemoved") is not True):
            raise RuntimeError("editor experiment did not complete")
        result.update(result="PASS", teardown="PASS: teardown.json and final-cleanup.json")
        save(path, result)
    save(run / "evidence/workflow.json", {"result": "PASS", "scenario": scenario,
         "runtimeAndPrivateFixturesAbsent": True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["up", "desktop", "stage", "cotype", "editor", "throttle", "down", "status", "restart"])
    parser.add_argument("--run", required=True, help="dedicated external run directory")
    parser.add_argument("--binary", default=str(REPO / "target/release/obsyncd"))
    parser.add_argument("--source-repo", default=str(REPO), help="checkout that supplied the built artifacts")
    parser.add_argument("--plugin", default=str(REPO / "plugin/dist"))
    parser.add_argument("--fixture", help="verified external sentinel fixture, copied only into device A")
    parser.add_argument("--obsidian", default="/Applications/Obsidian.app/Contents/MacOS/Obsidian")
    parser.add_argument("--devices", type=int, choices=range(4), default=2)
    parser.add_argument("--faults", action="store_true", help="optional owned streaming intermediary; private faults.json controls bounded feed cuts/chunk delay")
    parser.add_argument("--hold", action="store_true", help="keep the tool session alive; Ctrl-C/TERM tears down")
    parser.add_argument("--device", choices=list("ABC"), default="A")
    args = parser.parse_args()
    os.umask(0o077)
    run = external(args.run)
    if args.command in ("desktop", "stage", "cotype", "editor", "throttle"):
        if args.devices != 2:
            raise ValueError("the desktop rehearsal requires exactly two lab devices")
        desktop(run, args.command)
    elif args.command == "up":
        up(args, run)
        state = load(run)
        if args.hold:
            state["holder"] = {"pid": os.getpid(), "identity": identity(os.getpid())}
            save(run / "lab.json", state)
            def interrupted(_signal, _frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, interrupted)
        print(json.dumps({"ready": True, "devices": list(state["devices"]), "run": str(run)}), flush=True)
        if args.hold:
            try:
                while not load(run).get("stopped"):
                    request = run / "private/stop.json"
                    if request.exists():
                        request.unlink()
                        return
                    for record in load(run)["processes"].values():
                        group_alive(record["pid"])  # reap children stopped by an external down
                    request = run / "private/restart.json"
                    if request.exists():
                        name = json.loads(request.read_text())["device"]
                        request.unlink()
                        restart(run, name)
                    time.sleep(.1)
            except KeyboardInterrupt:
                pass
            finally:
                if not load(run).get("stopped"):
                    down(run)
    elif args.command == "down":
        down(run)
    elif args.command == "restart":
        restart(run, args.device)
    else:
        state = load(run)
        print(json.dumps({name: {"same_identity": identity(record["pid"]) == record["identity"],
                                "group_alive": group_alive(record["pid"])}
                          for name, record in state["processes"].items()}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f"lab refused: {error}", file=sys.stderr)
        sys.exit(1)
