"""Offline coverage for `provenance_contract.py` and the publisher's wiring of it.

The reviewer's standard for this range: every security decision the two new
publisher steps make must be pinned by a test that fails when the decision is
deleted. Part one exercises the module on synthetic OCI documents (an index,
two platform manifests, BuildKit-shaped predicates, DSSE envelopes) so each
refusal is reproduced without a registry, a signature, or a credential. Part
two reads `.github/workflows/release-publisher.yml` and pins the narrow wiring
that makes the module's decisions effective: the builder binding, the consumer
identity and issuer, the digest binding, the unconditional verification on a
reused image, and the platform loops matching the build. These are behaviour
pins, not a step census: a new unrelated step changes nothing here. Part three
EXECUTES the three production `run:` scripts, verbatim from the workflow,
under bash with stand-ins for `cosign` and `docker` on PATH and the real `jq`
and `python3`, and asserts the exit code: a contract refusal, or a failed
cosign call, must stop the step. Text pins cannot see `|| true`; an executed
step can.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402
import provenance_contract as pc  # noqa: E402

RUN = "https://github.com/snaraj/obsync/actions/runs/1/attempts/1"
IMAGE = "ghcr.io/snaraj/obsync"
PLATFORMS = ["linux/amd64", "linux/arm64"]
WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/release-publisher.yml"


def _d(seed: str) -> str:
    return "sha256:" + hashlib.sha256(seed.encode()).hexdigest()


def _layers(platform: str, count: int = 3) -> tuple[str, ...]:
    return tuple(_d(f"{platform}:layer:{i}") for i in range(count))


def _manifest(layers: tuple[str, ...]) -> dict:
    return {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {"digest": _d("config" + layers[0]), "size": 1},
            "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": d, "size": 1}
                       for d in layers]}


def _index(platforms=PLATFORMS, attestations: bool = True) -> dict:
    entries = []
    for platform in platforms:
        os_name, arch = platform.split("/")
        entries.append({"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": _d("manifest" + platform),
                        "size": 1, "platform": {"os": os_name, "architecture": arch}})
    if attestations:
        for platform in platforms:
            entries.append({"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": _d("att" + platform),
                            "size": 1, "platform": {"os": "unknown", "architecture": "unknown"},
                            "annotations": {"vnd.docker.reference.type": "attestation-manifest",
                                            "vnd.docker.reference.digest": _d("manifest" + platform)}})
    return {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": entries}


def _manifests(platforms=PLATFORMS) -> dict[str, dict]:
    return {_d("manifest" + p): _manifest(_layers(p)) for p in platforms}


def _predicate(groups, builder: str = RUN, build_type: str = pc.BUILD_TYPE) -> dict:
    layers = {f"step{i}:0": [[{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": d, "size": 1}
                              for d in group]] for i, group in enumerate(groups)}
    return {"buildDefinition": {"buildType": build_type, "externalParameters": {}, "internalParameters": {
        "builderPlatform": "linux/amd64"}, "resolvedDependencies": []},
        "runDetails": {"builder": {"id": builder}, "metadata": {"invocationId": RUN, "buildkit_metadata": {"layers": layers}}}}


def _platform_predicate(platform: str, **kw) -> dict:
    # A build-stage group nobody publishes, then the final image's group.
    return _predicate([(_d("stage" + platform),), _layers(platform)], **kw)


def _statement(predicate: dict, subjects=(_d("index"),), statement_type=pc.STATEMENT_TYPE,
               predicate_type=pc.PREDICATE_TYPE) -> dict:
    return {"_type": statement_type, "predicateType": predicate_type, "predicate": predicate,
            "subject": [{"name": IMAGE, "digest": {"sha256": s.split(":", 1)[1]}} for s in subjects]}


def _line(statement: dict, payload_type: str = pc.PAYLOAD_TYPE) -> str:
    payload = base64.b64encode(json.dumps(statement).encode()).decode()
    return json.dumps({"payloadType": payload_type, "payload": payload, "signatures": [{"sig": "x"}]})


INDEX_DIGEST = _d("index")


def _good_lines() -> list[str]:
    return [_line(_statement(_platform_predicate(p))) for p in PLATFORMS]


def _verify(lines, **kw):
    options = {"digest": INDEX_DIGEST, "index": _index(), "manifests": _manifests(), "platforms": PLATFORMS}
    options.update(kw)
    return pc.verify(lines, **options)


class VerifyTests(unittest.TestCase):
    def test_one_statement_per_platform_over_the_index_digest_is_accepted(self):
        self.assertEqual(_verify(_good_lines()), {"linux/amd64": 1, "linux/arm64": 2})

    def test_a_platform_without_a_statement_is_refused(self):
        with self.assertRaisesRegex(pc.Refusal, r"no verified SLSA v1 statement binds \['linux/arm64'\]"):
            _verify(_good_lines()[:1])

    def test_two_statements_for_one_platform_do_not_count_as_two_platforms(self):
        amd = _line(_statement(_platform_predicate("linux/amd64")))
        with self.assertRaisesRegex(pc.Refusal, "linux/amd64 already has statement 1"):
            _verify([amd, amd])

    def test_a_statement_describing_no_expected_platform_is_refused(self):
        stranger = _line(_statement(_predicate([_layers("linux/riscv64")])))
        with self.assertRaisesRegex(pc.Refusal, "binds no expected platform"):
            _verify(_good_lines() + [stranger])

    def test_a_statement_describing_both_platforms_is_refused(self):
        both = _line(_statement(_predicate([_layers("linux/amd64"), _layers("linux/arm64")])))
        with self.assertRaisesRegex(pc.Refusal, "not exactly one platform"):
            _verify([both, _good_lines()[1]])

    def test_a_subject_other_than_the_index_digest_is_refused(self):
        other = _line(_statement(_platform_predicate("linux/amd64"), subjects=(_d("manifestlinux/amd64"),)))
        with self.assertRaisesRegex(pc.Refusal, "subject is not exactly"):
            _verify([other, _good_lines()[1]])
        extra = _line(_statement(_platform_predicate("linux/amd64"), subjects=(INDEX_DIGEST, _d("x"))))
        with self.assertRaisesRegex(pc.Refusal, "subject is not exactly"):
            _verify([extra, _good_lines()[1]])

    def test_foreign_envelope_statement_and_predicate_types_are_refused(self):
        with self.assertRaisesRegex(pc.Refusal, "payload type is not in-toto"):
            _verify([_line(_statement(_platform_predicate("linux/amd64")), payload_type="application/json")])
        with self.assertRaisesRegex(pc.Refusal, "not an in-toto v1 statement"):
            _verify([_line(_statement(_platform_predicate("linux/amd64"), statement_type="https://in-toto.io/Statement/v0.1"))])
        with self.assertRaisesRegex(pc.Refusal, "not SLSA v1 provenance"):
            _verify([_line(_statement(_platform_predicate("linux/amd64"), predicate_type="https://slsa.dev/provenance/v0.2"))])

    def test_a_predicate_that_is_not_buildkit_slsa_v1_is_refused(self):
        with self.assertRaisesRegex(pc.Refusal, "buildType is not BuildKit's"):
            _verify([_line(_statement(_platform_predicate("linux/amd64", build_type="https://example.invalid/build")))])
        with self.assertRaisesRegex(pc.Refusal, "not SLSA v1"):
            _verify([_line(_statement({"predicate": "x"}))])

    def test_a_predicate_without_layer_groups_cannot_bind_a_platform(self):
        bare = _platform_predicate("linux/amd64")
        del bare["runDetails"]["metadata"]["buildkit_metadata"]
        with self.assertRaisesRegex(pc.Refusal, "records no layer groups"):
            _verify([_line(_statement(bare))])

    def test_the_builder_is_this_exact_run_when_one_is_required(self):
        foreign = _line(_statement(_platform_predicate("linux/amd64", builder=RUN.replace("/1/", "/2/"))))
        with self.assertRaisesRegex(pc.Refusal, "not this run"):
            _verify([foreign, _good_lines()[1]], builder=RUN)
        self.assertEqual(_verify([foreign, _good_lines()[1]]), {"linux/amd64": 1, "linux/arm64": 2})
        with self.assertRaisesRegex(pc.Refusal, "not this run"):
            pc.check_predicate(_platform_predicate("linux/amd64", builder=""), builder="")

    def test_the_index_must_carry_exactly_the_expected_platforms(self):
        with self.assertRaisesRegex(pc.Refusal, "are not the expected"):
            _verify(_good_lines(), index=_index(PLATFORMS + ["linux/riscv64"]), manifests=_manifests(PLATFORMS + ["linux/riscv64"]))
        with self.assertRaisesRegex(pc.Refusal, "are not the expected"):
            _verify(_good_lines(), index=_index(["linux/amd64"]), manifests=_manifests(["linux/amd64"]))
        with self.assertRaisesRegex(pc.Refusal, "empty or unreadable"):
            _verify(_good_lines(), platforms=[])

    def test_attestation_manifests_are_not_platforms_and_duplicates_are_refused(self):
        self.assertEqual(pc.index_platforms(_index()), pc.index_platforms(_index(attestations=False)))
        twice = _index(); twice["manifests"].append(dict(twice["manifests"][0]))
        with self.assertRaisesRegex(pc.Refusal, "lists linux/amd64 twice"):
            pc.index_platforms(twice)
        with self.assertRaisesRegex(pc.Refusal, "not a multi-platform index"):
            pc.index_platforms(_manifest(_layers("linux/amd64")))

    def test_a_missing_or_unreadable_manifest_is_refused(self):
        with self.assertRaisesRegex(pc.Refusal, "was not read"):
            _verify(_good_lines(), manifests=_manifests(["linux/amd64"]))
        with self.assertRaisesRegex(pc.Refusal, "lists no layers"):
            pc.manifest_layers({"layers": "x"})

    def test_blank_lines_are_ignored_and_a_malformed_line_or_no_statement_is_refused(self):
        lines = _good_lines()
        self.assertEqual(_verify(["", lines[0], "   ", lines[1]]), {"linux/amd64": 2, "linux/arm64": 4})
        with self.assertRaisesRegex(pc.Refusal, "not JSON"):
            _verify(["{not json"])
        with self.assertRaisesRegex(pc.Refusal, "not a base64 JSON statement"):
            _verify([json.dumps({"payloadType": pc.PAYLOAD_TYPE, "payload": "@@@"})])
        with self.assertRaisesRegex(pc.Refusal, "no verified SLSA v1 statement binds"):
            _verify([])
        with self.assertRaisesRegex(pc.Refusal, "not a sha256 digest"):
            _verify(_good_lines(), digest="sha256:short")


class CommandTests(unittest.TestCase):
    def _workspace(self, tmp: str) -> dict[str, str]:
        root = Path(tmp)
        (root / "index.json").write_text(json.dumps(_index()))
        (root / "manifests").mkdir()
        for digest, manifest in _manifests().items():
            (root / "manifests" / f"{digest[7:]}.json").write_text(json.dumps(manifest))
        (root / "statements.jsonl").write_text("\n".join(_good_lines()) + "\n")
        (root / "amd64.json").write_text(json.dumps(_platform_predicate("linux/amd64")))
        (root / "arm64.json").write_text(json.dumps(_platform_predicate("linux/arm64")))
        return {"index": str(root / "index.json"), "manifests": str(root / "manifests"),
                "statements": str(root / "statements.jsonl"), "amd64": str(root / "amd64.json"),
                "arm64": str(root / "arm64.json")}

    def _run(self, argv: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pc.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_predicate_accepts_its_platform_and_refuses_another_or_another_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            w = self._workspace(tmp)
            base = ["predicate", "--index", w["index"], "--manifests", w["manifests"]]
            code, out, _ = self._run(base + ["--file", w["amd64"], "--builder", RUN, "--platform", "linux/amd64"])
            self.assertEqual((code, out.strip()), (0, "predicate binds linux/amd64 and names this run"))
            code, _, err = self._run(base + ["--file", w["arm64"], "--builder", RUN, "--platform", "linux/amd64"])
            self.assertEqual(code, 1); self.assertIn("binds linux/arm64, not linux/amd64", err)
            code, _, err = self._run(base + ["--file", w["amd64"], "--builder", RUN + "0", "--platform", "linux/amd64"])
            self.assertEqual(code, 1); self.assertIn("not this run", err)

    def test_verify_exits_zero_only_when_every_platform_is_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            w = self._workspace(tmp)
            base = ["verify", "--digest", INDEX_DIGEST, "--index", w["index"], "--manifests", w["manifests"],
                    "--statements", w["statements"], "--platforms", "linux/amd64,linux/arm64"]
            code, out, _ = self._run(base)
            self.assertEqual(code, 0); self.assertIn("linux/amd64 (line 1), linux/arm64 (line 2)", out)
            Path(w["statements"]).write_text(_good_lines()[0] + "\n")
            code, _, err = self._run(base)
            self.assertEqual(code, 1); self.assertIn("binds ['linux/arm64']", err)
            code, _, err = self._run(base[:-2] + ["--platforms", "linux/amd64"])
            self.assertEqual(code, 1); self.assertIn("are not the expected", err)
            code, _, err = self._run(base + ["--builder", RUN + "0"])
            self.assertEqual(code, 1); self.assertIn("not this run", err)


def _flat(script: str) -> str:
    return " ".join(re.sub(r"\\\s*\n", " ", script).split())


class PublisherWiringTests(unittest.TestCase):
    """The publisher hands the module the right inputs, in the right places."""

    @classmethod
    def setUpClass(cls):
        document = miniyaml.load_one(WORKFLOW.read_text(encoding="utf-8"))
        for job in document["jobs"].values():
            names = [step.get("name") for step in job.get("steps", [])]
            if "Attest the image's provenance with this run's identity" in names:
                cls.steps, cls.names = job["steps"], names
                return
        raise AssertionError("the publisher has no attest step")

    def _step(self, name: str) -> dict:
        return self.steps[self.names.index(name)]

    def test_the_index_and_platform_manifests_are_read_unconditionally_before_attest(self):
        read = self._step("Read the published index and its platform manifests")
        self.assertNotIn("if", read)
        script = _flat(read["run"])
        self.assertIn('docker buildx imagetools inspect "${IMAGE}@${DIGEST}" --raw > "${index}"', script)
        self.assertIn('select(.platform.os != "unknown")', script)
        self.assertLess(self.names.index("Read the published index and its platform manifests"),
                        self.names.index("Attest the image's provenance with this run's identity"))

    def test_attest_runs_only_for_a_fresh_image_and_binds_this_exact_run(self):
        attest = self._step("Attest the image's provenance with this run's identity")
        self.assertEqual(attest.get("if"), "steps.image_state.outputs.state == 'absent'")
        script = _flat(attest["run"])
        self.assertIn('run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}"', script)
        self.assertIn("python3 -I -B scripts/ci/provenance_contract.py predicate", script)
        for flag in ('--builder "${run_url}"', '--platform "${platform}"', '--file "${predicate}"',
                     '--index "${index}"', '--manifests "${manifests}"'):
            self.assertIn(flag, script)
        self.assertIn('cosign attest --yes --new-bundle-format --type slsaprovenance1 --predicate "${predicate}" "${IMAGE}@${DIGEST}"', script)
        self.assertLess(script.index("provenance_contract.py predicate"), script.index("cosign attest"))

    def test_the_platform_loops_match_the_build(self):
        build = self._step("Build and publish both production architectures")["with"]["platforms"]
        self.assertEqual(build, "linux/amd64,linux/arm64")
        attest = _flat(self._step("Attest the image's provenance with this run's identity")["run"])
        self.assertIn(f"for platform in {build.replace(',', ' ')}; do", attest)
        verify = _flat(self._step("Prove the provenance verifies with the consumer's own command")["run"])
        self.assertIn(f"--platforms {build}", verify)

    def test_verify_is_unconditional_and_uses_the_consumer_command_identity_issuer_and_digest(self):
        verify = self._step("Prove the provenance verifies with the consumer's own command")
        self.assertNotIn("if", verify)
        script = _flat(verify["run"])
        self.assertIn("cosign verify-attestation --type slsaprovenance1 --new-bundle-format", script)
        self.assertIn('--certificate-identity "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/.github/workflows/release-publisher.yml@refs/heads/main"', script)
        self.assertIn("--certificate-oidc-issuer https://token.actions.githubusercontent.com", script)
        self.assertIn('"${IMAGE}@${DIGEST}" > "${verified}"', script)
        self.assertIn("python3 -I -B scripts/ci/provenance_contract.py verify", script)
        for flag in ('--digest "${DIGEST}"', '--statements "${verified}"', '--index "${RUNNER_TEMP}/image-index.json"',
                     '--manifests "${RUNNER_TEMP}/image-manifests"'):
            self.assertIn(flag, script)
        self.assertIn("set -euo pipefail", script)

    def test_the_order_is_sign_then_attest_then_verify_then_chart(self):
        order = [self.names.index(n) for n in ("Sign the immutable image digest",
                                                "Attest the image's provenance with this run's identity",
                                                "Prove the provenance verifies with the consumer's own command",
                                                "Embed the resolved image digest into the chart values")]
        self.assertEqual(order, sorted(order))


DOCKER_STUB = r"""#!/bin/sh
# Stand-in for the only docker shape the publisher's provenance steps use:
#   docker buildx imagetools inspect <ref> --raw
#   docker buildx imagetools inspect <ref> --format '{{ json (index .Provenance "<platform>").SLSA }}'
printf 'docker %s\n' "$*" >> "${STUB_LOG}"
[ -n "${STUB_DOCKER_FAIL:-}" ] && exit 9
[ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "unexpected docker call: $*" >&2; exit 64; }
ref=$4; shift 4
case "$1" in
  --raw)
    if [ "${ref}" = "${IMAGE}@${DIGEST}" ]; then cat "${STUB_DOCS}/index.json"; else cat "${STUB_DOCS}/manifests/${ref#*@sha256:}.json"; fi ;;
  --format)
    platform=$(printf '%s' "$2" | sed -n 's/.*index \.Provenance "\([^"]*\)".*/\1/p')
    cat "${STUB_DOCS}/predicate-$(printf '%s' "${platform}" | tr / -).json" ;;
  *) echo "unexpected docker call: $*" >&2; exit 64 ;;
esac
"""

COSIGN_STUB = r"""#!/bin/sh
# Stand-in for cosign: `attest` records itself; `verify-attestation` prints the
# statements the test staged. STUB_COSIGN_FAIL makes either call fail.
printf 'cosign %s\n' "$*" >> "${STUB_LOG}"
[ -n "${STUB_COSIGN_FAIL:-}" ] && exit 7
case "$1" in
  attest) exit 0 ;;
  verify-attestation) cat "${STUB_STATEMENTS}" ;;
  *) echo "unexpected cosign call: $*" >&2; exit 64 ;;
esac
"""


class PublisherStepExecutionTests(unittest.TestCase):
    """The production steps, executed: a refusal is fatal, not a log line."""

    @classmethod
    def setUpClass(cls):
        document = miniyaml.load_one(WORKFLOW.read_text(encoding="utf-8"))
        cls.steps = {step.get("name"): step for job in document["jobs"].values() for step in job.get("steps", [])}
        for tool in ("bash", "jq", "python3"):
            if shutil.which(tool) is None:
                raise AssertionError(f"{tool} is required to execute the publisher steps (the runner has it)")

    def _stage(self, root: Path, predicates: dict[str, dict] | None = None, statements: list[str] | None = None) -> dict:
        docs, bins, temp = root / "docs", root / "bin", root / "runner-temp"
        (docs / "manifests").mkdir(parents=True); bins.mkdir(); temp.mkdir()
        (docs / "index.json").write_text(json.dumps(_index()))
        for digest, manifest in _manifests().items():
            (docs / "manifests" / f"{digest[7:]}.json").write_text(json.dumps(manifest))
        for platform, predicate in (predicates or {p: _platform_predicate(p) for p in PLATFORMS}).items():
            (docs / f"predicate-{platform.replace('/', '-')}.json").write_text(json.dumps(predicate))
        (docs / "statements.jsonl").write_text("\n".join(statements if statements is not None else _good_lines()) + "\n")
        for name, body in (("docker", DOCKER_STUB), ("cosign", COSIGN_STUB)):
            path = bins / name; path.write_text(body); path.chmod(0o755)
        env = {"PATH": f"{bins}{os.pathsep}{os.environ['PATH']}", "HOME": str(root), "LANG": "C",
               "IMAGE": IMAGE, "DIGEST": INDEX_DIGEST, "RUNNER_TEMP": str(temp),
               "GITHUB_SERVER_URL": "https://github.com", "GITHUB_REPOSITORY": "snaraj/obsync",
               "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1",
               "STUB_DOCS": str(docs), "STUB_LOG": str(root / "calls.log"), "STUB_STATEMENTS": str(docs / "statements.jsonl")}
        return env

    def _run(self, name: str, env: dict) -> subprocess.CompletedProcess:
        script = Path(env["RUNNER_TEMP"]).parent / f"{name[:12].replace(' ', '-')}.sh"
        script.write_text(self.steps[name]["run"])
        # GitHub runs an un-shelled `run:` as `bash -e {0}`; the scripts add
        # `set -euo pipefail` themselves. Nothing here relies on the harness
        # adding more than `-e`.
        return subprocess.run(["bash", "--noprofile", "--norc", "-e", str(script)], cwd=WORKFLOW.parents[2],
                              env=env, capture_output=True, text=True, timeout=60)

    def _read_index(self, env: dict) -> None:
        result = self._run("Read the published index and its platform manifests", env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def _calls(self, env: dict, prefix: str) -> list[str]:
        log = Path(env["STUB_LOG"])
        return [line for line in log.read_text().splitlines() if line.startswith(prefix)] if log.exists() else []

    def test_the_index_step_writes_the_index_and_only_the_platform_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            temp = Path(env["RUNNER_TEMP"])
            self.assertEqual(json.loads((temp / "image-index.json").read_text()), _index())
            written = sorted(p.name for p in (temp / "image-manifests").glob("*.json"))
            self.assertEqual(written, sorted(f"{d[7:]}.json" for d in _manifests()))

    def test_the_verify_step_passes_with_one_statement_per_platform(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            result = self._run("Prove the provenance verifies with the consumer's own command", env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("verified one SLSA v1 provenance statement per platform", result.stdout)
            self.assertEqual(len(self._calls(env, "cosign verify-attestation")), 1)

    def test_the_verify_step_fails_when_the_contract_refuses(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp), statements=_good_lines()[:1]); self._read_index(env)
            result = self._run("Prove the provenance verifies with the consumer's own command", env)
            self.assertNotEqual(result.returncode, 0, "a contract refusal must fail the step")
            self.assertIn("no verified SLSA v1 statement binds ['linux/arm64']", result.stderr)

    def test_the_verify_step_fails_when_cosign_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            result = self._run("Prove the provenance verifies with the consumer's own command", {**env, "STUB_COSIGN_FAIL": "1"})
            self.assertNotEqual(result.returncode, 0, "a failed verification command must fail the step")
            self.assertNotIn("provenance contract", result.stderr)

    def test_the_attest_step_attests_each_platform_after_its_predicate_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            result = self._run("Attest the image's provenance with this run's identity", env)
            self.assertEqual(result.returncode, 0, result.stderr)
            attests = self._calls(env, "cosign attest")
            self.assertEqual(len(attests), 2)
            for line in attests:
                self.assertIn(f"--type slsaprovenance1 --predicate {env['RUNNER_TEMP']}/provenance-linux-", line)
                self.assertTrue(line.endswith(f"{IMAGE}@{INDEX_DIGEST}"))

    def test_the_attest_step_stops_before_cosign_when_a_predicate_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            wrong = {"linux/amd64": _platform_predicate("linux/arm64"), "linux/arm64": _platform_predicate("linux/arm64")}
            env = self._stage(Path(tmp), predicates=wrong); self._read_index(env)
            result = self._run("Attest the image's provenance with this run's identity", env)
            self.assertNotEqual(result.returncode, 0, "a refused predicate must fail the step")
            self.assertIn("binds linux/arm64, not linux/amd64", result.stderr)
            self.assertEqual(self._calls(env, "cosign attest"), [], "nothing may be attested after a refusal")

    def test_the_index_step_fails_when_the_registry_read_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp))
            result = self._run("Read the published index and its platform manifests", {**env, "STUB_DOCKER_FAIL": "1"})
            self.assertNotEqual(result.returncode, 0, "a failed index read must fail the step")
            self.assertEqual(list((Path(env["RUNNER_TEMP"]) / "image-manifests").glob("*.json")), [])

    def test_the_attest_step_fails_when_a_predicate_read_or_the_attest_call_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            result = self._run("Attest the image's provenance with this run's identity", {**env, "STUB_DOCKER_FAIL": "1"})
            self.assertNotEqual(result.returncode, 0, "a failed predicate read must fail the step")
            self.assertEqual(self._calls(env, "cosign attest"), [])
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            result = self._run("Attest the image's provenance with this run's identity", {**env, "STUB_COSIGN_FAIL": "1"})
            self.assertNotEqual(result.returncode, 0, "a failed attest call must fail the step")
            self.assertEqual(len(self._calls(env, "cosign attest")), 1, "the loop stops at the first failure")

    def test_the_attest_step_stops_when_the_builder_is_another_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self._stage(Path(tmp)); self._read_index(env)
            result = self._run("Attest the image's provenance with this run's identity", {**env, "GITHUB_RUN_ID": "2"})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not this run", result.stderr)
            self.assertEqual(self._calls(env, "cosign attest"), [])


if __name__ == "__main__":
    unittest.main()
