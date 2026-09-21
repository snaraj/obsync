"""The publication boundaries of `.github/workflows/docs-site.yml`, pinned.

WHY A SUITE OF ITS OWN. `test_workflow_integrity.py` enforces four rules across
EVERY workflow -- action pins, declared permissions, no `pull_request_target`,
no persisted credential -- and its own docstring refuses to grow a closed step
or job inventory, because an exhaustive-inventory assertion breaks on every
legitimate addition until its readers edit it reflexively. That refusal is
right, and it is also why those fourteen tests say nothing about what makes
THIS workflow safe. An adversarial review demonstrated the gap: independently
deleting either `if:` line, granting the build job `pages: write` and
`id-token: write`, or dropping `--require-hashes`, `--no-deps`,
`--only-binary=:all:` or `--strict` left all fourteen green.

So this file pins BEHAVIOUR, not inventory, and only this workflow's:

  1. **The build job cannot publish.** Its `permissions:` is exactly
     `contents: read`. GitHub Pages deployment authority is `pages: write` plus
     the `id-token: write` that mints the OIDC token attesting the artifact.
     The job that runs a pull request's own `mkdocs.yml` and a pull request's
     own `docs/requirements.txt` must not hold either, because the code it runs
     is the code under review.

  2. **Only a push to `main` deploys.** The `deploy` job's `if:` names the push
     event AND the main ref, and so does the artifact upload in `build`. A
     pull request and a manual dispatch build and stop. Two separate `if`s
     because they are two separate refusals: without the upload's, a fork's
     content becomes the Pages artifact; without the deploy job's, anything
     that produced an artifact reaches the deployment.

  3. **Pages is never enabled by this workflow.** `actions/configure-pages`
     takes an `enablement:` input that turns Pages ON for the repository.
     Turning on a publishing surface is the owner's decision, so the step
     carries no such input and fails loudly instead.

  4. **The installed bytes are the reviewed bytes.** The install runs
     `--require-hashes` (every wheel matches a sha256 in the file, and a
     requirement with no hash fails), `--no-deps` (no resolution, so no
     transitive release enters) and `--only-binary=:all:` (no source
     distribution, so no package's build code runs). `docs/requirements.txt`
     carries a hash on every requirement, which is what makes the first flag
     mean anything.

  5. **The site build is strict, and nothing swallows its status.** Without
     `--strict` a broken link or a missing image is an INFO line and the check
     is green -- and with `--strict` and a trailing `|| true` it is green too.
     So the build step's command is pinned WHOLE, and no run step in this
     workflow may end a line with `|| true`, `|| :` or carry `set +e`. A review
     found both gaps: `||` in place of `&&` in the deploy condition, and
     `|| true` after the strict build, each passing all thirteen tests.

  6. **`theme.font` is `false`**, which is a SETTING and is all this rule was.
     Material's default font configuration emits a `fonts.googleapis.com`
     stylesheet and a `fonts.gstatic.com` preconnect into every generated page,
     and requirement 1 forbids handing every reader of the documentation to a
     third party. What the setting does not cover is the rest of the output: a
     co-review built the site and found two script injections to `unpkg.com`
     inside Material's own bundle. So the rule's text stops at the setting, and

  7. **the BUILT site is judged by `scripts/ci/site_origins.py`**, which
     rewrites those known loads into no-ops and then refuses any load in any
     built file whose origin is not this site's own or this repository's. This
     file pins that the workflow runs both, in that order, between the build
     and the upload -- so what is published is what was proven -- and drives
     the script over a fixture bundle carrying both injections.

Every rule is a function of the file's TEXT or of its resolved document, so
`MutatedSourcesAreRefused` breaks each property in memory, over the real files,
and requires the named refusal to appear. A rule that stopped being able to
fail fails there instead.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402
import site_origins  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "docs-site.yml"
MKDOCS = ROOT / "mkdocs.yml"
REQUIREMENTS = ROOT / "docs" / "requirements.txt"

BUILD_JOB = "build"
DEPLOY_JOB = "deploy"
BUILD_PERMISSIONS = {"contents": "read"}
DEPLOY_PERMISSIONS = {"pages": "write", "id-token": "write"}
PUSH_CONDITION = "github.event_name == 'push'"
MAIN_CONDITION = "github.ref == 'refs/heads/main'"
# The EFFECTIVE condition, not its ingredients. A review found that swapping
# the `&&` for `||` left both substrings in place and passed: `push OR main`
# deploys every push to every branch, and every pull-request build on main's
# ref. So the whole expression is pinned, whitespace-normalised.
DEPLOY_CONDITION = f"{PUSH_CONDITION} && {MAIN_CONDITION}"
# The build command, whole. Appending `|| true` to it also left every
# substring in place while turning a failed strict build green.
MKDOCS_COMMAND = "python3 -m mkdocs build --strict"
# A run step that swallows its own failure. `|| true`, `|| :` and `set +e` each
# make a red command green, and none of them changes a flag this file checks.
SWALLOWED = re.compile(r"\|\|\s*(?:true|:)\s*$|(?:^|\s)set\s+\+e")
UPLOAD_ACTION = "actions/upload-pages-artifact"
CONFIGURE_ACTION = "actions/configure-pages"
INSTALL_FLAGS = ("--require-hashes", "--no-deps", "--only-binary=:all:")
REQUIREMENTS_ARGUMENT = "-r docs/requirements.txt"
STRICT = "--strict"
MKDOCS_BUILD = "mkdocs build"
ORIGINS_SCRIPT = "scripts/ci/site_origins.py"
ORIGINS_STRIP = f"python3 -B {ORIGINS_SCRIPT} strip site"
ORIGINS_ASSERT = f"python3 -B {ORIGINS_SCRIPT} assert site"
# The fixture is the real shape, minified helper names included: Material emits
# `? load("https://…") : nothing(void 0)` and a rewrite that stopped matching
# it must fail loudly rather than pass quietly.
FIXTURE_BUNDLE = (
    'var cn=new T,Ia=H(()=>typeof ResizeObserver=="undefined"?'
    '_t("https://unpkg.com/resize-observer-polyfill"):$(void 0)).pipe(m(()=>0));'
    'function as(){return typeof mermaid=="undefined"?'
    '_t("https://unpkg.com/mermaid@11/dist/mermaid.min.js"):$(void 0)}'
)
HASH_RE = re.compile(r"^\s*--hash=sha256:[0-9a-f]{64}\s*$")
REQUIREMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*==\S+")


def _condition(node: object) -> str:
    """One `if:` expression, whitespace-normalised, or the empty string."""
    if not isinstance(node, dict):
        return ""
    value = node.get("if")
    return " ".join(str(value).split()) if isinstance(value, str) else ""


def _steps(job: object) -> list[dict]:
    if not isinstance(job, dict):
        return []
    return [step for step in job.get("steps", []) if isinstance(step, dict)]


def _step_using(job: object, action: str) -> dict | None:
    for step in _steps(job):
        uses = step.get("uses")
        if isinstance(uses, str) and uses.split("@", 1)[0] == action:
            return step
    return None


def _runs(job: object) -> str:
    return "\n".join(
        step["run"] for step in _steps(job) if isinstance(step.get("run"), str)
    )


def workflow_refusals(text: str) -> list[str]:
    try:
        document = miniyaml.load_one(text)
    except miniyaml.YamlError as error:
        return [f"docs-site.yml: cannot be resolved: {error}"]
    found: list[str] = []
    if document.get("permissions") != {}:
        found.append("docs-site.yml: the workflow's top-level permissions are not empty")
    jobs = document.get("jobs")
    if not isinstance(jobs, dict):
        return found + ["docs-site.yml: has no jobs mapping"]
    for name, expected in ((BUILD_JOB, BUILD_PERMISSIONS), (DEPLOY_JOB, DEPLOY_PERMISSIONS)):
        job = jobs.get(name)
        if not isinstance(job, dict):
            found.append(f"docs-site.yml: has no `{name}` job")
            continue
        if job.get("permissions") != expected:
            found.append(
                f"docs-site.yml: the `{name}` job's permissions are "
                f"{job.get('permissions')!r}, not {expected!r}"
            )
    build = jobs.get(BUILD_JOB)
    deploy = jobs.get(DEPLOY_JOB)

    # Rule 2, twice: the job and the upload that feeds it. The comparison is
    # with the WHOLE expression, because `push || main` contains both halves
    # and admits every push to every branch.
    for label, condition in (
        (f"the `{DEPLOY_JOB}` job", _condition(deploy)),
        (f"the `{UPLOAD_ACTION}` step", _condition(_step_using(build, UPLOAD_ACTION))),
    ):
        if condition != DEPLOY_CONDITION:
            found.append(
                f"docs-site.yml: {label} is conditioned on {condition!r}, not "
                f"exactly {DEPLOY_CONDITION!r}, so something other than a push "
                f"to main can reach the deployment"
            )

    # Rule 3: no `enablement:` input on configure-pages.
    configure = _step_using(deploy, CONFIGURE_ACTION)
    if configure is None:
        found.append(f"docs-site.yml: the `{DEPLOY_JOB}` job does not run {CONFIGURE_ACTION}")
    else:
        inputs = configure.get("with")
        if isinstance(inputs, dict) and "enablement" in inputs:
            found.append(
                f"docs-site.yml: {CONFIGURE_ACTION} carries an `enablement:` input, "
                "so the workflow turns GitHub Pages on for the repository itself"
            )

    # Rules 4 and 5, over the build job's shell.
    commands = _runs(build)
    for flag in INSTALL_FLAGS:
        if flag not in commands:
            found.append(f"docs-site.yml: the install does not carry `{flag}`")
    if REQUIREMENTS_ARGUMENT not in commands:
        found.append(f"docs-site.yml: the install does not read `{REQUIREMENTS_ARGUMENT}`")
    builds = [
        " ".join(str(step.get("run")).split())
        for step in _steps(build)
        if isinstance(step.get("run"), str) and MKDOCS_BUILD in step["run"]
    ]
    if not builds:
        found.append("docs-site.yml: the build job never runs `mkdocs build`")
    for command in builds:
        if command != MKDOCS_COMMAND:
            found.append(
                f"docs-site.yml: the site is built by {command!r}, not exactly "
                f"{MKDOCS_COMMAND!r}: `{STRICT}` is what makes a broken link a "
                f"failure, and anything appended to the line can hand the step "
                f"a zero status anyway"
            )
    # Rule 7's workflow half: the origin check runs on the built directory
    # BEFORE the artifact is uploaded, or the proof is about bytes nobody
    # published and the published bytes were never judged.
    order = []
    for step in _steps(build):
        command = step.get("run")
        if isinstance(command, str):
            if MKDOCS_BUILD in command:
                order.append("build")
            if ORIGINS_STRIP in command:
                order.append("strip")
            if ORIGINS_ASSERT in command:
                order.append("assert")
        uses = step.get("uses")
        if isinstance(uses, str) and uses.split("@", 1)[0] == UPLOAD_ACTION:
            order.append("upload")
    for required in ("strip", "assert"):
        if required not in order:
            found.append(
                f"docs-site.yml: the build job never runs `{ORIGINS_SCRIPT} {required}`, "
                "so nothing judges the site it publishes"
            )
    if {"build", "strip", "assert", "upload"} <= set(order):
        if not (
            order.index("build") < order.index("strip") < order.index("assert") < order.index("upload")
        ):
            found.append(
                f"docs-site.yml: the build job runs {order}, not build, strip, assert, "
                "upload: the origin check has to judge the built site before it is uploaded"
            )

    # Every run step in this workflow, not only the build: an install that
    # swallows its own failure installs nothing and says nothing.
    for job_name, job in jobs.items():
        for step in _steps(job):
            command = step.get("run")
            if not isinstance(command, str):
                continue
            for line in command.splitlines():
                if SWALLOWED.search(line):
                    found.append(
                        f"docs-site.yml: the `{job_name}` job runs `{line.strip()}`, "
                        "which turns a failed command into a green step"
                    )
    return found


def requirements_refusals(text: str) -> list[str]:
    """Rule 4's other half: every requirement carries a hash."""
    found: list[str] = []
    lines = text.splitlines()
    hashed = 0
    for index, line in enumerate(lines):
        if not REQUIREMENT_RE.match(line):
            continue
        following = lines[index + 1] if index + 1 < len(lines) else ""
        if line.rstrip().endswith("\\") and HASH_RE.match(following):
            hashed += 1
            continue
        found.append(
            f"docs/requirements.txt:{index + 1}: `{line.strip()}` carries no "
            "`--hash=sha256:…` on the line below it"
        )
    if not hashed:
        found.append("docs/requirements.txt: names no hashed requirement at all")
    return found


def mkdocs_refusals(text: str) -> list[str]:
    """Rule 6: the theme fetches no font from a third party."""
    try:
        document = miniyaml.load_one(text)
    except miniyaml.YamlError as error:
        return [f"mkdocs.yml: cannot be resolved: {error}"]
    theme = document.get("theme")
    if not isinstance(theme, dict):
        return ["mkdocs.yml: has no `theme:` mapping"]
    if theme.get("font") is not False:
        return [
            "mkdocs.yml: `theme.font` is not `false`, so Material emits a "
            "fonts.googleapis.com stylesheet and a fonts.gstatic.com preconnect "
            "into every page and every reader of the documentation is handed to "
            "a third party"
        ]
    return []


def sources() -> tuple[str, str, str]:
    return (
        WORKFLOW.read_text(encoding="utf-8"),
        REQUIREMENTS.read_text(encoding="utf-8"),
        MKDOCS.read_text(encoding="utf-8"),
    )


def refusals(workflow: str, requirements: str, mkdocs: str) -> list[str]:
    return (
        workflow_refusals(workflow)
        + requirements_refusals(requirements)
        + mkdocs_refusals(mkdocs)
    )


class TheShippedSourcesHoldTheseBoundaries(unittest.TestCase):
    def test_nothing_is_refused(self):
        self.assertEqual(refusals(*sources()), [])

    def test_the_reader_actually_resolved_the_workflow(self):
        # Vacuity: every workflow rule above returns early on a reader refusal,
        # so "no refusals" from an unresolvable file would look identical.
        document = miniyaml.load_one(sources()[0])
        self.assertEqual(set(document["jobs"]), {BUILD_JOB, DEPLOY_JOB})

    def test_the_requirements_rule_counted_the_whole_closure(self):
        # The same vacuity question for rule 4's other half: a file this reader
        # found no requirements in would raise nothing per line.
        text = sources()[1]
        self.assertEqual(
            len([line for line in text.splitlines() if REQUIREMENT_RE.match(line)]),
            len([line for line in text.splitlines() if HASH_RE.match(line)]),
        )
        self.assertGreater(text.count("--hash=sha256:"), 20)


class TheBuiltSiteIsJudgedByItsOrigins(unittest.TestCase):
    """Rule 7, driven: the script, over a fixture with both injections."""

    def site(self, directory: Path, bundle: str) -> Path:
        built = directory / "site"
        (built / "assets" / "javascripts").mkdir(parents=True)
        (built / "assets" / "javascripts" / "bundle.min.js").write_text(bundle, encoding="utf-8")
        (built / "index.html").write_text(
            '<link rel="canonical" href="https://snaraj.github.io/obsync/">'
            '<a href="https://squidfunk.github.io/mkdocs-material/">theme</a>'
            '<a href="https://github.com/snaraj/obsync">repository</a>',
            encoding="utf-8",
        )
        return built

    def run_mode(self, mode: str, built: Path) -> int:
        return site_origins.main([mode, str(built)])

    def test_an_unstripped_bundle_is_refused_by_name(self):
        with tempfile.TemporaryDirectory() as scratch:
            built = self.site(Path(scratch), FIXTURE_BUNDLE)
            own = site_origins.site_origin()
            found = site_origins.refusals(
                built / "assets" / "javascripts" / "bundle.min.js", FIXTURE_BUNDLE, own
            )
            self.assertEqual(len(found), 2, found)
            self.assertTrue(all("unpkg.com" in line for line in found), found)
            self.assertEqual(self.run_mode("assert", built), 1)

    def test_stripping_makes_the_same_bundle_pass(self):
        with tempfile.TemporaryDirectory() as scratch:
            built = self.site(Path(scratch), FIXTURE_BUNDLE)
            self.assertEqual(self.run_mode("strip", built), 0)
            self.assertEqual(self.run_mode("assert", built), 0)
            bundle = (built / "assets" / "javascripts" / "bundle.min.js").read_text(encoding="utf-8")
            self.assertNotIn("unpkg.com", bundle)
            # The rewrite keeps the shape: both branches are the value the else
            # branch already named, so the ternary still yields it.
            self.assertIn("?$(void 0):$(void 0)", bundle)

    def test_an_anchor_is_not_a_load(self):
        # The documentation links to the projects it names, and a link a reader
        # may click is not a fetch the page makes.
        own = site_origins.site_origin()
        self.assertEqual(
            site_origins.refusals(
                Path("index.html"),
                '<a href="https://obsidian.md/">Obsidian</a>'
                '<link rel="canonical" href="https://snaraj.github.io/obsync/">',
                own,
            ),
            [],
        )

    def test_a_third_party_stylesheet_link_is_refused(self):
        # The earlier round's finding, now judged on the OUTPUT rather than on
        # `mkdocs.yml`: a `theme.font` regression emits exactly this.
        own = site_origins.site_origin()
        found = site_origins.refusals(
            Path("index.html"),
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">',
            own,
        )
        self.assertEqual(len(found), 1, found)
        self.assertIn("fonts.googleapis.com", found[0])

    def test_the_repositorys_own_pages_are_allowed_and_another_repository_is_not(self):
        own = site_origins.site_origin()
        self.assertTrue(site_origins.allowed("https://github.com/snaraj/obsync/blob/main/AGENTS.md", own))
        self.assertTrue(site_origins.allowed("https://snaraj.github.io/obsync/server/", own))
        self.assertFalse(site_origins.allowed("https://github.com/someone/else", own))
        self.assertFalse(site_origins.allowed("https://unpkg.com/x", own))


class MutatedSourcesAreRefused(unittest.TestCase):
    """One broken boundary per test, in memory, over the real files."""

    def setUp(self):
        self.workflow, self.requirements, self.mkdocs = sources()
        self.assertEqual(refusals(self.workflow, self.requirements, self.mkdocs), [])

    def kills(self, found: list[str], needle: str) -> None:
        self.assertTrue(
            [line for line in found if needle in line],
            f"{needle!r} was not refused after the mutation: {found}",
        )

    def mutate_workflow(self, old: str, new: str) -> list[str]:
        self.assertIn(old, self.workflow, "the fixture no longer matches the workflow")
        return refusals(self.workflow.replace(old, new, 1), self.requirements, self.mkdocs)

    def test_a_build_job_holding_pages_authority_is_refused(self):
        found = self.mutate_workflow(
            "    permissions:\n      contents: read\n",
            "    permissions:\n      contents: read\n      pages: write\n      id-token: write\n",
        )
        self.kills(found, "the `build` job's permissions are")

    def test_deleting_the_deploy_job_condition_is_refused(self):
        found = self.mutate_workflow(
            "    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n    needs: build\n",
            "    needs: build\n",
        )
        self.kills(found, "the `deploy` job is conditioned on")

    def test_widening_the_deploy_condition_to_any_branch_is_refused(self):
        found = self.mutate_workflow(
            "    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n",
            "    if: github.event_name == 'push'\n",
        )
        self.kills(found, MAIN_CONDITION)

    def test_turning_the_deploy_condition_into_a_disjunction_is_refused(self):
        # The review's surviving mutant: `push || main` keeps both substrings
        # and deploys every push to every branch.
        for label in (f"the `{DEPLOY_JOB}` job", f"the `{UPLOAD_ACTION}` step"):
            with self.subTest(where=label):
                self.setUp()
                found = self.mutate_workflow(
                    f"if: {PUSH_CONDITION} && {MAIN_CONDITION}",
                    f"if: {PUSH_CONDITION} || {MAIN_CONDITION}",
                )
                self.kills(found, "is conditioned on")

    def test_deleting_the_upload_condition_is_refused(self):
        found = self.mutate_workflow(
            "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n"
            "        uses: actions/upload-pages-artifact",
            "        uses: actions/upload-pages-artifact",
        )
        self.kills(found, f"the `{UPLOAD_ACTION}` step is conditioned on")

    def test_enabling_pages_from_the_workflow_is_refused(self):
        found = self.mutate_workflow(
            "        uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0",
            "        uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0\n"
            "        with:\n          enablement: true",
        )
        self.kills(found, "carries an `enablement:` input")

    def test_dropping_any_install_flag_is_refused(self):
        for flag in INSTALL_FLAGS:
            with self.subTest(flag=flag):
                self.setUp()
                found = self.mutate_workflow(f"{flag} ", "")
                self.kills(found, f"the install does not carry `{flag}`")

    def test_dropping_strict_is_refused(self):
        found = self.mutate_workflow(
            "python3 -m mkdocs build --strict", "python3 -m mkdocs build"
        )
        self.kills(found, "not exactly")

    def test_swallowing_the_strict_build_is_refused(self):
        # The review's other surviving mutant: `--strict` is still there, the
        # step is green whatever MkDocs decided.
        found = self.mutate_workflow(
            "python3 -m mkdocs build --strict",
            "python3 -m mkdocs build --strict || true",
        )
        self.kills(found, "turns a failed command into a green step")

    def test_swallowing_the_install_is_refused(self):
        # The same weakening one step earlier: nothing is installed and the
        # job carries on to a build that cannot run.
        found = self.mutate_workflow(
            "            --no-deps --only-binary=:all: -r docs/requirements.txt",
            "            --no-deps --only-binary=:all: -r docs/requirements.txt || true",
        )
        self.kills(found, "turns a failed command into a green step")

    def test_dropping_the_origin_check_is_refused(self):
        for command in (ORIGINS_STRIP, ORIGINS_ASSERT):
            with self.subTest(command=command):
                self.setUp()
                found = self.mutate_workflow(f"          {command}\n", "")
                self.kills(found, "so nothing judges the site it publishes")

    def test_running_the_origin_check_after_the_upload_is_refused(self):
        # A proof about bytes nobody published, beside published bytes nobody
        # judged. The order is the property, not the presence.
        found = self.mutate_workflow(
            "      - name: Prove the built site loads nothing from a third party\n",
            "      - name: Upload the Pages artifact\n"
            "        if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n"
            "        uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0\n"
            "        with:\n          path: site\n"
            "      - name: Prove the built site loads nothing from a third party\n",
        )
        self.kills(found, "before it is uploaded")

    def test_a_requirement_with_no_hash_is_refused(self):
        line = next(
            candidate
            for candidate in self.requirements.splitlines()
            if REQUIREMENT_RE.match(candidate)
        )
        mutated = self.requirements.replace(line, line.rstrip(" \\"), 1)
        self.kills(
            refusals(self.workflow, mutated, self.mkdocs), "carries no `--hash=sha256:"
        )

    def test_a_hash_that_is_not_a_sha256_is_refused(self):
        mutated = self.requirements.replace("--hash=sha256:", "--hash=md5:", 1)
        self.kills(
            refusals(self.workflow, mutated, self.mkdocs), "carries no `--hash=sha256:"
        )

    def test_the_default_material_fonts_are_refused(self):
        # Two ways back to Google's CDN, and each is its own mutation: the key
        # DELETED, which restores Material's Roboto default, and the key set to
        # a font mapping, which is the same request under a different name.
        for label, replacement in (
            ("the key deleted", ""),
            ("a font named instead", "  font:\n    text: Roboto\n"),
        ):
            with self.subTest(mutation=label):
                mutated = self.mkdocs.replace("  font: false\n", replacement, 1)
                self.assertNotEqual(mutated, self.mkdocs)
                self.kills(
                    refusals(self.workflow, self.requirements, mutated),
                    "`theme.font` is not `false`",
                )


if __name__ == "__main__":
    unittest.main()
