"""A refusal must not destroy what it refused about.

WHY THIS FILE EXISTS. `scripts/ci/compose-e2e.sh` and `scripts/ci/helm-e2e.sh`
create real infrastructure and tear it down from an EXIT trap. An adversarial
review found the ownership error that shape invites: both armed an
unconditional teardown for a FIXED name before preflight, so the refusal
"something of this name already exists" exited THROUGH the teardown and removed
it. The compose file declares non-external named volumes for the blobs, the
journal and the terminator's certificate authority, so on a self-hoster's own
host that refusal could take a running deployment and its data with it.

`test_selfhosting_contract.py` rule 7 checks that a workflow running one of
these scripts carries an `if: always()` step. That is a statement about the
WORKFLOW, and the review is right that it is not this property. This file
pins the property itself, three ways:

  1. **Names.** Every object an invocation creates carries a run id, so no
     name it removes can be another run's or a deployment that was already
     there. The scripts derive it from `OBSYNC_E2E_RUN_ID` when a workflow
     supplies one and from the pid otherwise.
  2. **Order.** The EXIT trap is armed only after preflight, and the teardown
     it runs is guarded by a `created` marker set immediately BEFORE the first
     command that makes anything -- so a partial creation is still torn down,
     and a preflight refusal reaches neither.
  3. **Behaviour, executed.** Each refusal path is DRIVEN, with `docker`,
     `kind`, `helm`, `kubectl`, `curl` and `openssl` replaced by shims that
     record every call, and the recording must contain no destructive verb at
     all -- no `compose down`, no `rm`, no `volume rm`, no `network rm`, no
     `kind delete`, no `helm uninstall`, no `kubectl delete`.

The shims make this hermetic: no container, cluster, volume or network is
created or removed by this suite, on a runner or on a laptop. What is executed
is the real script, unmodified, with its refusals reached for real.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
WORKFLOWS = ROOT / ".github" / "workflows"

RUN_ID = "testrun-7f3a"
# The scripts name every object `obsync-e2e-<run id>`; this suite asserts that
# shape rather than reimplementing it, because a fixed name is exactly the
# mutation it exists to catch.
EXPECTED_PREFIX = f"obsync-e2e-{RUN_ID}"
RUN_ID_VARIABLE = "OBSYNC_E2E_RUN_ID"

# What a refusal may never do. Each entry is (program, the argument that
# destroys something), matched against a recorded call's whole argument list.
DESTRUCTIVE = (
    ("docker", "down"),
    ("docker", "rm"),
    ("docker", "prune"),
    ("kind", "delete"),
    ("helm", "uninstall"),
    ("helm", "delete"),
    ("kubectl", "delete"),
)

# A shim records its call and answers from the environment. It is deliberately
# dumb: every decision a case needs is one variable, so a reader can see which
# refusal a case drives without reading shell.
SHIM = """#!/usr/bin/env bash
printf '%s\\t%s\\n' "$(basename "$0")" "$*" >> "${SHIM_LOG}"
program="$(basename "$0")"
case "${program}" in
  docker)
    case "$1" in
      compose) [ "$2" = version ] && exit 0 ;;
      image) [ "${SHIM_IMAGE_MISSING:-0}" = 1 ] && exit 1 ;;
      container) [ "${SHIM_CONTAINER_EXISTS:-0}" = 1 ] && exit 0; exit 1 ;;
      network)
        case "$2" in
          ls) printf '%s\\n' "${SHIM_NETWORKS:-}" ;;
          inspect) printf '%s\\n' "${SHIM_NETWORK_HOLDER:-}" ;;
        esac
        ;;
    esac
    ;;
  kind)
    case "$1" in
      version) printf '%s\\n' "${SHIM_KIND_VERSION:-0.0.0}" ;;
      get) printf '%s\\n' "${SHIM_CLUSTERS:-}" ;;
    esac
    ;;
esac
exit 0
"""

PROGRAMS = ("docker", "kind", "helm", "kubectl", "curl", "openssl")


class Recording:
    """One executed refusal: its exit status, its output and every call made."""

    def __init__(self, status: int, output: str, calls: list[tuple[str, str]]):
        self.status = status
        self.output = output
        self.calls = calls


def drive(script: str, argument: str, environment: dict[str, str]) -> Recording:
    """Run one script with shimmed tools, and record what it called."""
    with tempfile.TemporaryDirectory() as scratch:
        binaries = Path(scratch) / "bin"
        binaries.mkdir()
        log = Path(scratch) / "calls.log"
        log.touch()
        for program in PROGRAMS:
            path = binaries / program
            path.write_text(SHIM, encoding="utf-8")
            path.chmod(0o755)
        env = dict(os.environ)
        env.update(environment)
        env["PATH"] = f"{binaries}{os.pathsep}{env.get('PATH', '')}"
        env["SHIM_LOG"] = str(log)
        env[RUN_ID_VARIABLE] = RUN_ID
        # Off a runner the mask directive would be the one place a token could
        # be printed; these cases never reach a token, and this keeps the
        # recording free of workflow syntax either way.
        env.pop("GITHUB_ACTIONS", None)
        completed = subprocess.run(
            [str(HERE / script), argument],
            capture_output=True,
            text=True,
            cwd=ROOT,
            env=env,
            timeout=120,
        )
        calls = []
        for line in log.read_text(encoding="utf-8").splitlines():
            program, _, arguments = line.partition("\t")
            calls.append((program, arguments))
        return Recording(
            completed.returncode, completed.stdout + completed.stderr, calls
        )


def destructive_calls(recording: Recording) -> list[tuple[str, str]]:
    """Every recorded call that removes something, whatever it names."""
    found = []
    for program, arguments in recording.calls:
        words = arguments.split()
        for shim, verb in DESTRUCTIVE:
            if program == shim and verb in words:
                found.append((program, arguments))
                break
    return found


def unnamed_calls(recording: Recording) -> list[tuple[str, str]]:
    """Calls that name a project or a cluster without this run's id."""
    found = []
    for program, arguments in recording.calls:
        for flag in ("--project-name", "--name", "--filter"):
            for index, word in enumerate(arguments.split()):
                if word != flag:
                    continue
                value = arguments.split()[index + 1 : index + 2]
                if value and EXPECTED_PREFIX not in value[0] and "obsync" in value[0]:
                    found.append((program, arguments))
    return found


class ComposeRefusalsPreserveWhatTheyRefuseAbout(unittest.TestCase):
    """`compose-e2e.sh`, driven to each preflight refusal."""

    def assert_harmless(self, recording: Recording) -> None:
        self.assertEqual(recording.status, 1, recording.output)
        self.assertEqual(destructive_calls(recording), [], recording.output)
        self.assertEqual(unnamed_calls(recording), [], recording.output)

    def test_a_refusal_about_an_existing_container_removes_nothing(self):
        # THE finding: the documented commands name two containers, so a run
        # that found them standing used to exit through `compose down
        # --volumes` for the project that owns them.
        recording = drive(
            "compose-e2e.sh",
            "obsync-e2e-fixture:local",
            {"SHIM_CONTAINER_EXISTS": "1"},
        )
        self.assert_harmless(recording)
        self.assertIn("already exists", recording.output)

    def test_a_refusal_about_a_missing_image_removes_nothing(self):
        recording = drive(
            "compose-e2e.sh", "obsync-e2e-fixture:local", {"SHIM_IMAGE_MISSING": "1"}
        )
        self.assert_harmless(recording)
        self.assertIn("this script builds nothing", recording.output)

    def test_a_refusal_about_a_held_subnet_removes_nothing(self):
        recording = drive(
            "compose-e2e.sh",
            "obsync-e2e-fixture:local",
            {
                "SHIM_NETWORKS": "abc123",
                "SHIM_NETWORK_HOLDER": "somebody-elses_obsync",
            },
        )
        self.assert_harmless(recording)

    def test_the_project_this_run_owns_carries_its_run_id(self):
        # Non-vacuity for `unnamed_calls`: the run must actually NAME a project
        # somewhere, or the assertion above judges an empty set.
        recording = drive(
            "compose-e2e.sh",
            "obsync-e2e-fixture:local",
            {"SHIM_CONTAINER_EXISTS": "1"},
        )
        named = [
            arguments
            for _, arguments in recording.calls
            if EXPECTED_PREFIX in arguments
        ]
        self.assertTrue(named, recording.calls)


class HelmRefusalsPreserveWhatTheyRefuseAbout(unittest.TestCase):
    """`helm-e2e.sh`, driven to each preflight refusal."""

    def setUp(self):
        version = ""
        for line in (HERE / "install-kind.sh").read_text(encoding="utf-8").splitlines():
            if line.startswith("KIND_VERSION="):
                version = line.split("=", 1)[1].lstrip("v")
        self.assertTrue(version, "install-kind.sh declares no KIND_VERSION")
        self.pinned = version
        self.image = f"ghcr.io/snaraj/obsync:v{(ROOT / 'VERSION').read_text().strip()}"

    def assert_harmless(self, recording: Recording) -> None:
        self.assertEqual(recording.status, 1, recording.output)
        self.assertEqual(destructive_calls(recording), [], recording.output)
        self.assertEqual(unnamed_calls(recording), [], recording.output)

    def test_a_refusal_about_an_existing_cluster_deletes_nothing(self):
        # THE finding: refusing a cluster of this name used to exit through
        # `kind delete cluster --name` for that very cluster.
        recording = drive(
            "helm-e2e.sh",
            self.image,
            {
                "SHIM_KIND_VERSION": self.pinned,
                "SHIM_CLUSTERS": EXPECTED_PREFIX,
            },
        )
        self.assert_harmless(recording)
        self.assertIn("already exists", recording.output)

    def test_a_refusal_about_the_kind_pin_deletes_nothing(self):
        recording = drive(
            "helm-e2e.sh", self.image, {"SHIM_KIND_VERSION": "0.0.1"}
        )
        self.assert_harmless(recording)
        self.assertIn("this repository pins", recording.output)

    def test_a_refusal_about_the_image_deletes_nothing(self):
        recording = drive(
            "helm-e2e.sh",
            "ghcr.io/snaraj/obsync:v0.0.0-not-this-release",
            {"SHIM_KIND_VERSION": self.pinned},
        )
        self.assert_harmless(recording)

    def test_the_cluster_this_run_owns_carries_its_run_id(self):
        # Non-vacuity: the refusal must NAME this run's cluster. `kind get
        # clusters` takes no name, so the recording cannot show it and the
        # refusal itself is where the name appears -- which is also the line a
        # reader of a red run sees.
        recording = drive(
            "helm-e2e.sh",
            self.image,
            {"SHIM_KIND_VERSION": self.pinned, "SHIM_CLUSTERS": EXPECTED_PREFIX},
        )
        self.assertIn(EXPECTED_PREFIX, recording.output)


class TheScriptsBindTeardownToWhatTheyCreated(unittest.TestCase):
    """Order and ownership, read off the source the cases above executed."""

    SCRIPTS = ("compose-e2e.sh", "helm-e2e.sh")

    def source(self, name: str) -> str:
        return (HERE / name).read_text(encoding="utf-8")

    def test_the_trap_is_armed_after_the_preflight_refusals(self):
        for name in self.SCRIPTS:
            with self.subTest(script=name):
                text = self.source(name)
                trap = text.index("trap cleanup EXIT")
                first_deny = text.index("|| deny ")
                self.assertLess(
                    first_deny,
                    trap,
                    f"{name} arms its teardown before a refusal can happen",
                )

    def test_the_teardown_is_guarded_by_the_created_marker(self):
        for name, verb in (
            ("compose-e2e.sh", "compose down"),
            ("helm-e2e.sh", "kind delete cluster"),
        ):
            with self.subTest(script=name):
                text = self.source(name)
                cleanup = text[text.index("cleanup() {") : text.index("# The documented text")]
                self.assertIn('if [ -n "${created}" ]; then', cleanup)
                self.assertIn(verb, cleanup)
                self.assertLess(
                    cleanup.index('if [ -n "${created}" ]; then'),
                    cleanup.index(verb),
                    f"{name} tears down before it asks what it created",
                )

    def test_the_marker_is_set_before_anything_is_created(self):
        # The anchor is the COMMAND that creates, named exactly and required to
        # be unique, so a comment mentioning it cannot satisfy this test.
        for name, creator in (
            ("compose-e2e.sh", 'run_documented "${up_command}" > "${scratch}/up.log"'),
            ("helm-e2e.sh", 'kind create cluster --name "${CLUSTER}"'),
        ):
            with self.subTest(script=name):
                text = self.source(name)
                self.assertEqual(text.count(creator), 1, f"{name}: {creator!r} is not unique")
                armed = text.index("created='cluster'" if "helm" in name else "created='project'")
                self.assertLess(armed, text.index(creator), f"{name} creates before it says so")
                self.assertLess(text.index("created=''"), armed)

    def test_every_name_the_scripts_own_is_derived_from_the_run_id(self):
        for name in self.SCRIPTS:
            with self.subTest(script=name):
                text = self.source(name)
                self.assertIn(f'${{{RUN_ID_VARIABLE}:-', text)
                self.assertIn('obsync-e2e-${run_id}', text)


class TheSetupTokenNeverReachesAnArgumentVector(unittest.TestCase):
    """The one request whose query carries the credential, executed.

    `compose-e2e.sh` argues, where it reads the token, that "an argument would
    put a credential in this runner's process table" -- and then signed in with
    the token inside a URL it handed to `curl` as an argument. A mask covers a
    LOG; `ps` reads argv. So the sign-in describes the request to curl on
    STDIN, and this drives the real function with a sentinel token against a
    recording shim: the token may appear in nothing curl was given and in
    nothing the run printed.
    """

    SENTINEL = "5e6e7c1ad0f04b2b9a1e3c7d8f0b2a45e6e7c1ad0f04b2b9a1e3c7d8f0b2a455"
    FUNCTION = re.compile(r"^sign_in\(\) \{.*?^\}", re.MULTILINE | re.DOTALL)

    def drive_sign_in(self) -> tuple[str, str, str]:
        """(recorded argv, recorded stdin, everything the shell printed)."""
        source = (HERE / "compose-e2e.sh").read_text(encoding="utf-8")
        function = self.FUNCTION.search(source)
        self.assertIsNotNone(function, "compose-e2e.sh declares no sign_in function")
        with tempfile.TemporaryDirectory() as scratch:
            binaries = Path(scratch) / "bin"
            binaries.mkdir()
            argv_log = Path(scratch) / "argv.log"
            stdin_log = Path(scratch) / "stdin.log"
            shim = binaries / "curl"
            shim.write_text(
                "#!/usr/bin/env bash\n"
                f'printf "%s\\n" "$*" >> "{argv_log}"\n'
                f'cat >> "{stdin_log}"\n'
                'printf "200"\n',
                encoding="utf-8",
            )
            shim.chmod(0o755)
            script = (
                f'PATH="{binaries}:$PATH"\n'
                f'scratch="{scratch}"\n'
                'HOST=obsync-e2e.invalid\n'
                'HTTPS_PORT=18543\n'
                f'token="{self.SENTINEL}"\n'
                f"{function.group(0)}\n"
                f'sign_in "{scratch}/body" "{scratch}/cookies"\n'
            )
            completed = subprocess.run(
                ["bash", "-c", script], capture_output=True, text=True, timeout=60
            )
            return (
                argv_log.read_text(encoding="utf-8") if argv_log.exists() else "",
                stdin_log.read_text(encoding="utf-8") if stdin_log.exists() else "",
                completed.stdout + completed.stderr,
            )

    def test_the_token_is_in_no_argument_and_no_printed_line(self):
        argv, stdin, printed = self.drive_sign_in()
        self.assertNotIn(self.SENTINEL, argv, f"the token was passed as an argument: {argv}")
        self.assertNotIn(self.SENTINEL, printed, "the token was printed")
        # Non-vacuity: the request really was made, and really carried the
        # token -- on the channel that is not argv.
        self.assertIn("--config -", argv)
        self.assertIn(self.SENTINEL, stdin)
        self.assertIn("/login", stdin)

    def test_no_line_of_the_script_hands_the_token_to_another_program(self):
        # The sign-in is the executed case; this is the whole file. A line that
        # STARTS a program and mentions the token puts it in that program's
        # argv. `printf` is a bash builtin and forks nothing, which is why the
        # pipelines that feed stdin are the shape used everywhere here.
        source = (HERE / "compose-e2e.sh").read_text(encoding="utf-8")
        external = re.compile(r"^\s*(?:curl|docker|kubectl|helm|python3|awk|sed|jq|env)\b")
        offenders = [
            line
            for line in source.splitlines()
            if "${token}" in line and external.match(line)
        ]
        self.assertEqual(offenders, [], offenders)


class TheWorkflowCleanupsNameTheSameRun(unittest.TestCase):
    """A cleanup step that names a FIXED project or cluster is the same bug."""

    def jobs(self):
        found = []
        for path in sorted(WORKFLOWS.glob("*.yml")):
            document = miniyaml.load_one(path.read_text(encoding="utf-8"))
            jobs = document.get("jobs") if isinstance(document, dict) else None
            if not isinstance(jobs, dict):
                continue
            for name, job in jobs.items():
                if not isinstance(job, dict):
                    continue
                steps = [s for s in job.get("steps", []) if isinstance(s, dict)]
                runs = "\n".join(s["run"] for s in steps if isinstance(s.get("run"), str))
                if "scripts/ci/compose-e2e.sh" in runs or "scripts/ci/helm-e2e.sh" in runs:
                    found.append((path.name, name, job, runs))
        return found

    def test_there_is_something_to_judge(self):
        self.assertTrue(self.jobs())

    def test_each_job_supplies_the_run_id(self):
        for workflow, name, job, _ in self.jobs():
            with self.subTest(workflow=workflow, job=name):
                environment = job.get("env")
                self.assertIsInstance(environment, dict, f"{workflow}:{name} declares no env")
                self.assertIn(RUN_ID_VARIABLE, environment)

    def test_no_cleanup_step_names_a_fixed_project_or_cluster(self):
        fixed = re.compile(r"obsync-e2e(?![-a-z0-9]*\$\{)|=obsync\b|--name obsync\b")
        for workflow, name, job, runs in self.jobs():
            steps = [s for s in job.get("steps", []) if isinstance(s, dict)]
            always = [s for s in steps if str(s.get("if", "")).strip() == "always()"]
            self.assertTrue(always, f"{workflow}:{name} has no always() step")
            for step in always:
                command = step.get("run")
                if not isinstance(command, str):
                    continue
                with self.subTest(workflow=workflow, job=name):
                    self.assertIn(RUN_ID_VARIABLE, command)
                    self.assertIsNone(
                        fixed.search(command),
                        f"{workflow}:{name} names a fixed object: {command}",
                    )


if __name__ == "__main__":
    unittest.main()
