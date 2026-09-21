"""The self-hosting guides are fixtures, and this is what holds them to it.

WHY. `test_onboarding_contract.py` proves the SHAPE of a documented command:
digest-only runs, both cosign flags, the tokenless token read. It cannot prove
the command WORKS, and no amount of prose can. So `compose-e2e` and `helm-e2e`
run the commands the guides show -- read out of the page at the commit under
test by `docs_blocks.py` -- and this file holds the coupling between the two
sides, which is the part neither the page nor the workflow can hold alone.

WHAT IS REFUSED, and why each one is the coupling rather than a style rule:

  1. a call with no block -- every `documented <name>` in an end-to-end script
     must name a `<!-- ci: <name> -->` block in the guide that script declares.
     Without this the coupling is a hope: a renamed block fails at 3 a.m. on a
     runner instead of here.

  2. a substitution the page does not show -- every `--substitute 'X=Y'` a
     script declares must find `X` in the block. This is the rule that catches
     the quiet edit: change `192.168.1.10` in the page and the substitution
     matches nothing, so the run would publish on an address nobody chose.
     `docs_blocks.py` refuses it at runtime too; this refuses it in the gate,
     where the diff is still on screen.

  3. a placeholder nobody replaces -- after every declared substitution the
     block may hold no `<placeholder>`. A block that still carries one is a
     command the workflow cannot run.

  4. a marked block nobody runs -- a `<!-- ci: … -->` marker that no script
     reads is decoration that will rot. The marker means "CI runs this", and
     the set of markers and the set of calls are therefore equal.

  5. a block that lost the property the run depends on -- the compose block
     must still name the compose file and carry the three assignments; the
     token blocks must still be the safe read; the volume block must still
     create BOTH directories `0700` and owned by 65532; the storage and values
     blocks must still resolve, agree on the class name, and agree on the
     paths the volume block prepares; the TLS front must still carry the three
     peer labels the values inject into the NetworkPolicy, must still reach
     the obsync Service, and must still lift the body ceiling a stock proxy
     applies; the Kubernetes token read must still come off a volume the
     storage block provisions. Each is a fact the end-to-end run needs and
     would otherwise discover by failing.

  6. a command copied instead of read -- an end-to-end script may not contain
     a literal of the command it is supposed to take from the page. A copy is
     how the two sides start to disagree while every test stays green.

  7. a workflow that can leave infrastructure behind -- a workflow running one
     of these scripts must declare a concurrency group, and every job that
     runs one must declare `timeout-minutes` and carry a step with
     `if: always()`. These scripts create compose projects and kind clusters
     on a shared runner: a cancelled job that cleans up nothing is the next
     run's refusal, and a job with no timeout is a cluster nobody deletes.
     The rule is derived from what a job RUNS, never from a list of workflow
     names, so a fourth end-to-end workflow is covered the day it is written.

EVERY RULE HAS A NEGATIVE TEST. `MutatedGuidesAreRefused` re-runs the same
functions over the real text with one property broken -- in memory, never on
disk -- so a rule that stopped being able to fail fails here instead.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docs_blocks  # noqa: E402
import miniyaml  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
WORKFLOWS = ROOT / ".github" / "workflows"

# The scripts that run documented text. Each declares the guide it reads in a
# `readonly GUIDE=` line, so this file states the SET and never the pairs.
SCRIPTS = ("compose-e2e.sh", "helm-e2e.sh")

GUIDE_DECLARATION = re.compile(r"^readonly GUIDE='(?P<guide>[^']+)'$", re.MULTILINE)
# A `documented <name>` INVOCATION, never the words in a comment: the scripts
# call it inside a command substitution, and prose about "the documented up"
# must not be read as a call. Everything up to the closing parenthesis belongs
# to the call, which is where its `--substitute` flags are.
CALL = re.compile(
    r"\$\(documented (?P<name>[a-z0-9][a-z0-9-]*)(?P<rest>[^)]*)\)"
)
SUBSTITUTION = re.compile(r"--substitute [\"'](?P<pair>[^\"']*)[\"']")
# What a substituted value stands in as while this suite judges a block. It is
# never a shell value: the script supplies those, and the only question here is
# whether the page still SHOWS what the script replaces.
STAND_IN = "SUBSTITUTED"

# Rule 5, per block. Each entry is one fact the end-to-end run depends on.
COMPOSE_FILE = "deploy/compose/docker-compose.yml"
TOKEN_PATH = ":/data/journal/v1/setup-token"
COMPOSE_ASSIGNMENTS = ("OBSYNC_IMAGE=", "OBSYNC_HOST=", "OBSYNC_BIND_ADDRESS=")
VOLUME_DIRECTORY = re.compile(
    r"^sudo install -d -m 0700 -o 65532 -g 65532 (?P<path>/\S+)$", re.MULTILINE
)
EXPECTED_VOLUME_DIRECTORIES = 2
# The Kubernetes token read: a plain read of the journal volume, on the node.
# `cat` and nothing else, because the image is distroless and every shape that
# needs a shell or a `tar` inside the container is a command that cannot work
# (chart/README.md section 4).
K8S_TOKEN_READ = re.compile(r"^sudo cat (?P<path>/\S+)/v1/setup-token$", re.MULTILINE)
# The one Service the terminator must reach, and the ceiling it must lift.
# Requirement 8: files of any size take one path, and a proxy's default 1 MiB
# body limit is a refusal the server never made.
FRONT_UPSTREAM = "http://obsync.obsidian.svc.cluster.local:8080"
FRONT_BODY_CEILING = "client_max_body_size 0;"
# The three labels `ingress.peer*` injects into the chart's NetworkPolicy. A
# terminator that does not carry all three is a connection that policy drops.
PEER_VALUES = ("peerNamespace", "peerAppName", "peerInstance")
PEER_LABELS = ("app.kubernetes.io/name", "app.kubernetes.io/instance")

# Rule 6: what each script may not contain, because it must read it instead.
FORBIDDEN_LITERALS = {
    "compose-e2e.sh": ("up -d", "docker cp", "tar -xO"),
    "helm-e2e.sh": (
        "install -d",
        "kind: PersistentVolume",
        "deploymentReady:",
        "setup-token",
        FRONT_BODY_CEILING,
        FRONT_UPSTREAM,
    ),
}

# Rule 7: the scripts whose workflows must clean up after themselves.
DISPOSABLE = ("compose-e2e.sh", "helm-e2e.sh", "distro-smoke.sh")


def scripts() -> dict[str, str]:
    return {name: (HERE / name).read_text(encoding="utf-8") for name in SCRIPTS}


def guide_of(text: str) -> str:
    found = GUIDE_DECLARATION.search(text)
    if found is None:
        raise AssertionError("an end-to-end script declares no `readonly GUIDE=`")
    return found.group("guide")


def calls(text: str) -> list[tuple[str, list[tuple[str, str]]]]:
    """Every `documented <name>` call in one script, with its substitutions."""
    found: list[tuple[str, list[tuple[str, str]]]] = []
    for match in CALL.finditer(text):
        pairs: list[tuple[str, str]] = []
        for substitution in SUBSTITUTION.finditer(match.group("rest")):
            shown, _, _ = substitution.group("pair").partition("=")
            pairs.append((shown, STAND_IN))
        found.append((match.group("name"), pairs))
    return found


def pages(sources: dict[str, str] | None = None) -> dict[str, str]:
    """The guides the scripts declare, read once."""
    if sources is None:
        sources = scripts()
    return {
        guide: (ROOT / guide).read_text(encoding="utf-8")
        for guide in {guide_of(text) for text in sources.values()}
    }


def _block_refusals(guide: str, name: str, language: str, body: str) -> list[str]:
    """Rule 5: the properties each named block must still carry."""
    found: list[str] = []
    if name == "compose-up":
        if COMPOSE_FILE not in body:
            found.append(f"{guide}: `{name}` no longer names {COMPOSE_FILE}")
        if "docker compose" not in body or " up" not in body:
            found.append(f"{guide}: `{name}` no longer runs `docker compose … up`")
        for assignment in COMPOSE_ASSIGNMENTS:
            if assignment not in body:
                found.append(f"{guide}: `{name}` no longer carries {assignment}")
    elif name == "compose-setup-token":
        if not body.strip().startswith("docker cp") or TOKEN_PATH not in body:
            found.append(f"{guide}: `{name}` is no longer a `docker cp` of {TOKEN_PATH}")
        if not body.strip().endswith("| tar -xO"):
            found.append(
                f"{guide}: `{name}` no longer ends in `| tar -xO`, so it is not the "
                "helper-free read the onboarding contract requires"
            )
    elif name == "compose-root-certificate":
        if "docker cp" not in body or "root.crt" not in body:
            found.append(f"{guide}: `{name}` no longer exports the terminator's root.crt")
    elif name == "k8s-token":
        if K8S_TOKEN_READ.search(body) is None:
            found.append(
                f"{guide}: `{name}` is no longer a plain `sudo cat …/v1/setup-token`: the "
                "image is distroless, so a read that needs a shell or a `tar` inside the "
                "container is a command nobody can run"
            )
    elif name == "k8s-volume-dirs":
        directories = VOLUME_DIRECTORY.findall(body)
        if len(directories) != EXPECTED_VOLUME_DIRECTORIES:
            found.append(
                f"{guide}: `{name}` prepares {len(directories)} directories as "
                f"`0700` owned by 65532, not {EXPECTED_VOLUME_DIRECTORIES}: the "
                "server refuses a volume it does not own"
            )
    elif name in {"k8s-storage", "k8s-values", "k8s-tls-front"}:
        if language != "yaml":
            found.append(f"{guide}: `{name}` is fenced as {language!r}, not yaml")
        try:
            miniyaml.loads(body)
        except miniyaml.YamlError as error:
            found.append(f"{guide}: `{name}` cannot be resolved: {error}")
    return found


def _kubernetes_refusals(pages_by_name: dict[str, str]) -> list[str]:
    """Rule 5, across the two Kubernetes blocks: they describe one deployment.

    The directories the page tells an operator to create, the volumes that
    point at them, and the class the claims ask for are three facts in three
    blocks, and a deployment works only when they agree. They are read here
    rather than discovered by a pod that stays `Pending`.
    """
    guide = "docs/kubernetes.md"
    text = pages_by_name.get(guide, "")
    if not text:
        return []
    found: list[str] = []
    try:
        blocks = docs_blocks.blocks(text)
    except docs_blocks.BlockError as error:
        return [f"{guide}: {error}"]
    for name in ("k8s-volume-dirs", "k8s-storage", "k8s-values", "k8s-tls-front", "k8s-token"):
        if name not in blocks:
            return [f"{guide}: no `<!-- ci: {name} -->` block"]
    directories = set(VOLUME_DIRECTORY.findall(blocks["k8s-volume-dirs"][1]))
    try:
        storage = miniyaml.loads(blocks["k8s-storage"][1])
        values = miniyaml.loads(blocks["k8s-values"][1])
    except miniyaml.YamlError as error:
        return [f"{guide}: a Kubernetes block cannot be resolved: {error}"]
    volumes = [
        document
        for document in storage
        if isinstance(document, dict) and document.get("kind") == "PersistentVolume"
    ]
    classes = [
        document
        for document in storage
        if isinstance(document, dict) and document.get("kind") == "StorageClass"
    ]
    if len(classes) != 1:
        found.append(f"{guide}: the storage block declares {len(classes)} StorageClass objects, not 1")
    if len(volumes) != EXPECTED_VOLUME_DIRECTORIES:
        found.append(
            f"{guide}: the storage block declares {len(volumes)} PersistentVolumes, "
            f"not the {EXPECTED_VOLUME_DIRECTORIES} the claims bind"
        )
    paths = {
        volume.get("spec", {}).get("local", {}).get("path")
        for volume in volumes
        if isinstance(volume.get("spec"), dict)
    }
    if paths != directories:
        found.append(
            f"{guide}: the PersistentVolumes point at {sorted(p for p in paths if p)} "
            f"and the documented directories are {sorted(directories)}: a volume whose "
            "directory nobody prepared is refused by the server, not created"
        )
    class_name = classes[0].get("metadata", {}).get("name") if classes else None
    declared = {
        volume.get("spec", {}).get("storageClassName")
        for volume in volumes
        if isinstance(volume.get("spec"), dict)
    }
    storage_values = values[0].get("storage") if values and isinstance(values[0], dict) else None
    requested = set()
    if isinstance(storage_values, dict):
        for claim in ("blobs", "journal"):
            entry = storage_values.get(claim)
            if isinstance(entry, dict):
                requested.add(entry.get("className"))
    if declared != {class_name} or requested != {class_name}:
        found.append(
            f"{guide}: the class is {class_name!r}, the volumes offer {sorted(d for d in declared if d)} "
            f"and the values ask for {sorted(r for r in requested if r)}: a claim that names "
            "another class binds nothing"
        )
    if values and isinstance(values[0], dict) and values[0].get("deploymentReady") is not True:
        found.append(
            f"{guide}: the values block no longer sets `deploymentReady: true`, so the "
            "chart renders zero replicas and the claims never bind"
        )
    found.extend(_front_refusals(guide, blocks, values))
    # The token is read off a volume this page provisions, so the path it names
    # must be one of the directories the volume block prepares. A page that
    # reads a token from somewhere else is a page whose steps do not compose.
    read = K8S_TOKEN_READ.findall(blocks["k8s-token"][1])
    if read and not set(read) <= directories:
        found.append(
            f"{guide}: the token is read from {sorted(set(read))}, which is not among the "
            f"volume directories this page prepares ({sorted(directories)}): a read nobody "
            "provisioned finds nothing"
        )
    return found


def _front_refusals(guide: str, blocks: dict, values: list) -> list[str]:
    """Rule 5, for the terminator: the peer the NetworkPolicy admits.

    The chart admits exactly ONE peer, by namespace label plus both of the
    workload's own labels (`chart/templates/network-policy.yaml`). Those three
    facts live in the values block, and the terminator that must carry them
    lives in another block on the same page. Two blocks that disagree render
    perfectly and drop every connection, which is the reference activation's
    own lesson and is why it is read here rather than discovered by a device
    that cannot reach the server.
    """
    found: list[str] = []
    try:
        front = miniyaml.loads(blocks["k8s-tls-front"][1])
    except miniyaml.YamlError as error:
        return [f"{guide}: the TLS-front block cannot be resolved: {error}"]
    peer = {}
    if values and isinstance(values[0], dict) and isinstance(values[0].get("ingress"), dict):
        peer = values[0]["ingress"]
    wanted = {name: peer.get(name) for name in PEER_VALUES}
    if not all(wanted.values()):
        found.append(f"{guide}: the values block no longer names all three `ingress.peer*` values: {wanted}")
        return found
    namespaces = {
        document.get("metadata", {}).get("namespace")
        for document in front
        if isinstance(document, dict) and document.get("kind") in {"ConfigMap", "Deployment", "Service"}
    }
    if namespaces != {wanted["peerNamespace"]}:
        found.append(
            f"{guide}: the TLS front is in {sorted(n for n in namespaces if n)} and the values "
            f"admit {wanted['peerNamespace']!r}: the NetworkPolicy names the namespace, so a "
            "terminator somewhere else is a connection the policy drops"
        )
    pods = [
        document.get("spec", {}).get("template", {}).get("metadata", {}).get("labels", {})
        for document in front
        if isinstance(document, dict) and document.get("kind") == "Deployment"
    ]
    if not pods:
        found.append(f"{guide}: the TLS-front block declares no Deployment to carry the peer labels")
        return found
    for labels in pods:
        carried = {key: labels.get(key) for key in PEER_LABELS}
        if carried != {
            "app.kubernetes.io/name": wanted["peerAppName"],
            "app.kubernetes.io/instance": wanted["peerInstance"],
        }:
            found.append(
                f"{guide}: the terminator's pods carry {carried} and the values admit "
                f"{wanted['peerAppName']!r}/{wanted['peerInstance']!r}: a policy naming two of "
                "the three reads narrow and behaves wide, and one that names none admits nothing"
            )
    configuration = "".join(
        str(value)
        for document in front
        if isinstance(document, dict) and document.get("kind") == "ConfigMap"
        for value in (document.get("data") or {}).values()
    )
    if FRONT_UPSTREAM not in configuration:
        found.append(
            f"{guide}: the terminator no longer proxies to {FRONT_UPSTREAM}: it terminates TLS "
            "for one Service and that is the one"
        )
    if FRONT_BODY_CEILING not in configuration:
        found.append(
            f"{guide}: the terminator no longer carries `{FRONT_BODY_CEILING}`, so a stock 1 MiB "
            "body ceiling refuses a large file the server would have taken (requirement 8)"
        )
    return found


def refusals(
    pages_by_name: dict[str, str] | None = None,
    sources: dict[str, str] | None = None,
) -> list[str]:
    """Every refusal the self-hosting coupling raises over these texts."""
    sources = scripts() if sources is None else sources
    pages_by_name = pages(sources) if pages_by_name is None else pages_by_name
    found: list[str] = []
    read: set[tuple[str, str]] = set()
    for script, text in sorted(sources.items()):
        guide = guide_of(text)
        page = pages_by_name.get(guide, "")
        if not page:
            found.append(f"{script}: reads {guide}, which is not a document in this repository")
            continue
        try:
            blocks = docs_blocks.blocks(page)
        except docs_blocks.BlockError as error:
            found.append(f"{guide}: {error}")
            continue
        for name, substitutions in calls(text):
            read.add((guide, name))
            if name not in blocks:
                found.append(
                    f"{script}: runs `{name}` from {guide}, which has no "
                    f"`<!-- ci: {name} -->` block"
                )
                continue
            language, body = blocks[name]
            found.extend(_block_refusals(guide, name, language, body))
            try:
                docs_blocks.extract(page, name, substitutions)
            except docs_blocks.BlockError as error:
                found.append(f"{script}: {guide}: {error}")
    # Rule 4: every marked block is read by some script.
    for guide, page in sorted(pages_by_name.items()):
        try:
            marked = docs_blocks.blocks(page)
        except docs_blocks.BlockError:
            continue
        for name in sorted(marked):
            if (guide, name) not in read:
                found.append(
                    f"{guide}: `<!-- ci: {name} -->` marks a block no end-to-end "
                    "script runs; the marker says CI runs it"
                )
    found.extend(_kubernetes_refusals(pages_by_name))
    return found


def _steps(job: dict) -> list[dict]:
    steps = job.get("steps")
    if not isinstance(steps, list):
        return []
    return [step for step in steps if isinstance(step, dict)]


def _runs(step: dict) -> str:
    run = step.get("run")
    return run if isinstance(run, str) else ""


def disposable_jobs() -> list[tuple[str, str, dict, dict]]:
    """(workflow, job name, job, workflow) for every job running one of these."""
    found: list[tuple[str, str, dict, dict]] = []
    for path in sorted(WORKFLOWS.glob("*.yml")):
        document = miniyaml.load_one(path.read_text(encoding="utf-8"))
        jobs = document.get("jobs") if isinstance(document, dict) else None
        if not isinstance(jobs, dict):
            continue
        for name, job in jobs.items():
            if not isinstance(job, dict):
                continue
            if any(
                f"scripts/ci/{script}" in _runs(step)
                for step in _steps(job)
                for script in DISPOSABLE
            ):
                found.append((path.name, name, job, document))
    return found


class TheGuidesAndTheGatesAgree(unittest.TestCase):
    """The real documents and the real scripts, as committed."""

    def test_the_coupling_raises_no_refusal(self):
        self.assertEqual(refusals(), [])

    def test_every_script_declares_a_guide_that_exists(self):
        for name, text in scripts().items():
            with self.subTest(script=name):
                self.assertTrue((ROOT / guide_of(text)).is_file())

    def test_every_script_actually_reads_a_block(self):
        # Non-vacuity for the whole file: a script that stopped calling
        # `documented` would raise no refusal above and prove nothing below.
        for name, text in scripts().items():
            with self.subTest(script=name):
                self.assertTrue(calls(text), f"{name} reads no documented block")

    def test_no_script_copies_the_command_it_must_read(self):
        for name, text in scripts().items():
            for literal in FORBIDDEN_LITERALS[name]:
                with self.subTest(script=name, literal=literal):
                    self.assertNotIn(
                        literal,
                        text,
                        f"{name} contains {literal!r}: a command copied beside the "
                        "page is a command that stops matching it",
                    )

    def test_the_helm_run_verifies_the_directories_the_page_prepares(self):
        # The ownership assertion names the paths literally, which is correct
        # -- it is checking a RESULT, not running a command -- and this is what
        # keeps those literals equal to the page.
        text = (HERE / "helm-e2e.sh").read_text(encoding="utf-8")
        guide = (ROOT / "docs" / "kubernetes.md").read_text(encoding="utf-8")
        directories = VOLUME_DIRECTORY.findall(
            docs_blocks.blocks(guide)["k8s-volume-dirs"][1]
        )
        self.assertEqual(len(directories), EXPECTED_VOLUME_DIRECTORIES)
        for path in directories:
            with self.subTest(path=path):
                self.assertIn(path, text)


class TheDisposableWorkflowsCleanUp(unittest.TestCase):
    """Rule 7, derived from what a job runs rather than from a list of names."""

    def setUp(self):
        self.jobs = disposable_jobs()

    def test_there_is_something_to_judge(self):
        self.assertTrue(self.jobs, "no workflow runs an end-to-end script")

    def test_each_workflow_declares_a_concurrency_group(self):
        for workflow, name, _, document in self.jobs:
            with self.subTest(workflow=workflow, job=name):
                concurrency = document.get("concurrency")
                self.assertIsInstance(concurrency, dict, f"{workflow} declares no concurrency")
                self.assertTrue(concurrency.get("group"), f"{workflow} declares no concurrency group")

    def test_each_job_declares_a_timeout(self):
        for workflow, name, job, _ in self.jobs:
            with self.subTest(workflow=workflow, job=name):
                self.assertIsInstance(
                    job.get("timeout-minutes"),
                    int,
                    f"{workflow}:{name} declares no timeout-minutes, so a hung run "
                    "holds its cluster or its compose project for six hours",
                )

    def test_each_job_cleans_up_whatever_happened(self):
        for workflow, name, job, _ in self.jobs:
            with self.subTest(workflow=workflow, job=name):
                always = [
                    step for step in _steps(job) if str(step.get("if", "")).strip() == "always()"
                ]
                self.assertTrue(
                    always,
                    f"{workflow}:{name} runs a script that creates containers or a "
                    "cluster and carries no `if: always()` step to remove them",
                )


class TheExtractorRefusesWhatItCannotStandBehind(unittest.TestCase):
    """`docs_blocks.py`'s own refusals, each one a mutation of a clean page."""

    CLEAN = (
        "# A page\n\nText.\n\n"
        "<!-- ci: sample -->\n"
        "```sh\n"
        "run --host name.example <digest>\n"
        "```\n\nMore text.\n"
    )

    def test_a_clean_page_yields_its_block(self):
        self.assertEqual(
            docs_blocks.extract(self.CLEAN, "sample", [("<digest>", "abc")]),
            "run --host name.example abc",
        )

    def test_an_unknown_name_is_refused(self):
        with self.assertRaises(docs_blocks.BlockError) as raised:
            docs_blocks.extract(self.CLEAN, "other", [])
        self.assertIn("no `<!-- ci: other -->` block", str(raised.exception))

    def test_a_duplicate_name_is_refused(self):
        text = self.CLEAN + self.CLEAN
        with self.assertRaises(docs_blocks.BlockError) as raised:
            docs_blocks.blocks(text)
        self.assertIn("marks two blocks", str(raised.exception))

    def test_a_marker_that_marks_no_fence_is_refused(self):
        text = self.CLEAN.replace("<!-- ci: sample -->\n```sh", "<!-- ci: sample -->\nplain")
        with self.assertRaises(docs_blocks.BlockError) as raised:
            docs_blocks.blocks(text)
        self.assertIn("not immediately followed by a fenced block", str(raised.exception))

    def test_an_unclosed_fence_is_refused(self):
        text = self.CLEAN.replace("```\n\nMore text.\n", "")
        with self.assertRaises(docs_blocks.BlockError) as raised:
            docs_blocks.blocks(text)
        self.assertIn("never closed", str(raised.exception))

    def test_a_substitution_the_page_does_not_show_is_refused(self):
        with self.assertRaises(docs_blocks.BlockError) as raised:
            docs_blocks.extract(self.CLEAN, "sample", [("<absent>", "x")])
        self.assertIn("would substitute nothing", str(raised.exception))

    def test_a_surviving_placeholder_is_refused(self):
        with self.assertRaises(docs_blocks.BlockError) as raised:
            docs_blocks.extract(self.CLEAN, "sample", [])
        self.assertIn("still holds the placeholder", str(raised.exception))


class MutatedGuidesAreRefused(unittest.TestCase):
    """One broken property per test: mutate, and require the refusal to APPEAR.

    Each test compares the refusals BEFORE and AFTER one edit and requires the
    named refusal to be absent before and present after. Every mutation is in
    memory; nothing here writes to the repository.
    """

    def setUp(self):
        self.scripts = scripts()
        self.pages = pages(self.scripts)
        self.before = refusals(self.pages, self.scripts)

    def mutate(self, guide: str, old: str, new: str) -> list[str]:
        text = self.pages[guide]
        self.assertIn(old, text, f"the fixture no longer matches {guide}")
        self.pages[guide] = text.replace(old, new, 1)
        return refusals(self.pages, self.scripts)

    def kills(self, found: list[str], needle: str) -> None:
        self.assertFalse(
            [line for line in self.before if needle in line],
            f"{needle!r} was already refused before the mutation",
        )
        self.assertTrue(
            [line for line in found if needle in line],
            f"{needle!r} was not refused after the mutation: {found}",
        )

    def test_the_baseline_is_clean(self):
        # Non-vacuity for the whole class: every `kills` below asserts the
        # refusal was ABSENT beforehand, which is only meaningful if the
        # starting point raises nothing.
        self.assertEqual(self.before, [])

    def test_renaming_a_marked_block_is_refused(self):
        found = self.mutate("docs/server.md", "<!-- ci: compose-up -->", "<!-- ci: compose-start -->")
        self.kills(found, "which has no `<!-- ci: compose-up -->` block")
        self.kills(found, "marks a block no end-to-end script runs")

    def test_deleting_a_marker_is_refused(self):
        found = self.mutate("docs/server.md", "<!-- ci: compose-setup-token -->\n", "")
        self.kills(found, "which has no `<!-- ci: compose-setup-token -->` block")

    def test_changing_the_documented_bind_address_is_refused(self):
        # The substitution the script declares stops matching, so the run would
        # publish on an address nobody chose.
        found = self.mutate("docs/server.md", "OBSYNC_BIND_ADDRESS=192.168.1.10", "OBSYNC_BIND_ADDRESS=10.0.0.5")
        self.kills(found, "would substitute nothing")

    def test_dropping_the_bind_address_from_the_compose_block_is_refused(self):
        found = self.mutate(
            "docs/server.md",
            "  OBSYNC_BIND_ADDRESS=192.168.1.10 \\\n",
            "",
        )
        self.kills(found, "no longer carries OBSYNC_BIND_ADDRESS=")

    def test_neutralizing_the_documented_token_read_is_refused(self):
        found = self.mutate(
            "docs/server.md",
            "docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO",
            "docker logs obsync-obsync-1 | grep token",
        )
        self.kills(found, "is no longer a `docker cp` of")

    def test_a_placeholder_the_scripts_do_not_replace_is_refused(self):
        found = self.mutate("docs/server.md", "OBSYNC_HOST=sync.example.org", "OBSYNC_HOST=<your hostname>")
        self.kills(found, "would substitute nothing")

    def test_changing_the_documented_volume_mode_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "sudo install -d -m 0700 -o 65532 -g 65532 /var/lib/obsync/blobs",
            "sudo install -d -m 0755 -o 65532 -g 65532 /var/lib/obsync/blobs",
        )
        self.kills(found, "directories as `0700` owned by 65532")

    def test_moving_a_documented_volume_path_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "    path: /var/lib/obsync/journal",
            "    path: /srv/obsync/journal",
        )
        self.kills(found, "a volume whose directory nobody prepared")

    def test_renaming_the_class_in_the_values_only_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "  blobs:\n    className: obsync-local",
            "  blobs:\n    className: obsync-ssd",
        )
        self.kills(found, "a claim that names another class binds nothing")

    def test_turning_the_deployment_off_in_the_values_is_refused(self):
        found = self.mutate("docs/kubernetes.md", "deploymentReady: true", "deploymentReady: false")
        self.kills(found, "no longer sets `deploymentReady: true`")

    def test_breaking_the_values_yaml_is_refused(self):
        found = self.mutate("docs/kubernetes.md", "publicUrl: \"https://sync.example.org\"", "publicUrl: &anchor x")
        self.kills(found, "cannot be resolved")

    def test_moving_the_terminator_out_of_the_peer_namespace_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "kind: ConfigMap\nmetadata:\n  name: tls-front\n  namespace: obsync-ingress",
            "kind: ConfigMap\nmetadata:\n  name: tls-front\n  namespace: ingress-nginx",
        )
        self.kills(found, "the NetworkPolicy names the namespace")

    def test_renaming_the_terminator_instance_label_is_refused(self):
        # The instance label is the one a namespace full of connectors is told
        # apart by, so this is the mutation that reads narrow and behaves wide.
        found = self.mutate(
            "docs/kubernetes.md",
            "      labels:\n        app.kubernetes.io/name: tls-front\n        app.kubernetes.io/instance: tls-front",
            "      labels:\n        app.kubernetes.io/name: tls-front\n        app.kubernetes.io/instance: tls-front-2",
        )
        self.kills(found, "reads narrow and behaves wide")

    def test_pointing_the_terminator_at_another_service_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "proxy_pass http://obsync.obsidian.svc.cluster.local:8080;",
            "proxy_pass http://obsync.default.svc.cluster.local:8080;",
        )
        self.kills(found, "no longer proxies to")

    def test_restoring_the_proxy_body_ceiling_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "      client_max_body_size 0;",
            "      client_max_body_size 1m;",
        )
        self.kills(found, "body ceiling refuses a large file")

    def test_a_token_read_that_needs_a_shell_in_the_container_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "sudo cat /var/lib/obsync/journal/v1/setup-token",
            "kubectl exec deploy/obsync -- cat /data/journal/v1/setup-token",
        )
        self.kills(found, "is no longer a plain `sudo cat")

    def test_reading_the_token_off_a_volume_nobody_provisions_is_refused(self):
        found = self.mutate(
            "docs/kubernetes.md",
            "sudo cat /var/lib/obsync/journal/v1/setup-token",
            "sudo cat /srv/obsync/journal/v1/setup-token",
        )
        self.kills(found, "which is not among the volume directories this page prepares")


if __name__ == "__main__":
    unittest.main()
