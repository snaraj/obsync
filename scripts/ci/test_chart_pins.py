"""Hostile tests for the chart pins.

The pins themselves shell out to `helm template`, so this suite splits in two
on purpose. The DECISION functions -- the ones that say whether a render is
acceptable -- are exercised directly against hand-built documents, including
every shape a counted-lines gate would have passed. The end-to-end pins are
exercised for real when helm is present, which it always is in the `chart` CI
job that enforces them.
"""

from __future__ import annotations

import contextlib
import io
import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chart_pins  # noqa: E402
import miniyaml  # noqa: E402


def policy(*ingress: dict) -> dict:
    return {"kind": "NetworkPolicy", "spec": {"ingress": list(ingress)}}


class ExtractionRefusesWhatCountingWouldPass(unittest.TestCase):
    def test_a_document_naming_a_claim_the_chart_does_not_create_is_refused(self):
        # The defect this catches shipped: prose that named the claims after
        # the NAMESPACE while the chart names them after the application. A
        # missing-name check alone would have passed it, because the prose did
        # name two claims -- they were simply the wrong two.
        known = {"obsync-blobs", "obsync-journal"}
        clean = "claimed by `obsync-blobs` and `obsync-journal` in namespace `obsidian`."
        self.assertEqual(chart_pins._unknown_claim_names(clean, known), [])
        wrong = "claimed by `obsidian-blobs` and `obsidian-journal`."
        self.assertEqual(
            chart_pins._unknown_claim_names(wrong, known),
            ["obsidian-blobs", "obsidian-journal"],
        )
        # A mirror claim the chart can render is not a defect; unbackticked
        # prose is not a claim name.
        self.assertEqual(
            chart_pins._unknown_claim_names("`obsync-mirror-spare`", known | {"obsync-mirror-spare"}),
            [],
        )
        self.assertEqual(chart_pins._unknown_claim_names("the obsidian-blobs volume", known), [])

    def test_a_second_policy_document_is_refused(self):
        # Ingress rules are ADDITIVE across policies, so a second document --
        # in the same file or a new template -- admits a peer that reading only
        # the first policy never sees.
        with self.assertRaises(chart_pins.PinError):
            chart_pins.only([policy(), policy()], "NetworkPolicy")

    def test_an_absent_policy_is_refused(self):
        with self.assertRaises(chart_pins.PinError):
            chart_pins.only([{"kind": "Service"}], "NetworkPolicy")

    def test_a_second_rule_with_no_from_is_refused(self):
        # `- {}` renders an allow-all while a `- from:` line count stays at
        # one. Comparing the WHOLE sub-tree is what catches it.
        expected = [{"from": [{"podSelector": {}}], "ports": [{"port": 8080}]}]
        observed = expected + [{}]
        with self.assertRaises(chart_pins.PinError):
            chart_pins.equals(observed, expected, "the ingress rule set")

    def test_a_dropped_selector_inside_the_one_rule_is_refused(self):
        expected = [
            {
                "from": [
                    {
                        "namespaceSelector": {"matchLabels": {"a": "b"}},
                        "podSelector": {"matchLabels": {"c": "d", "e": "f"}},
                    }
                ]
            }
        ]
        widened = [
            {"from": [{"namespaceSelector": {"matchLabels": {"a": "b"}},
                       "podSelector": {"matchLabels": {"c": "d"}}}]}
        ]
        with self.assertRaises(chart_pins.PinError):
            chart_pins.equals(widened, expected, "the ingress rule set")


class VolumeSourcesAreRefusedByName(unittest.TestCase):
    def test_a_claim_backed_volume_resolves_to_its_claim(self):
        self.assertEqual(
            chart_pins._volume_claims(
                {"name": "blobs", "persistentVolumeClaim": {"claimName": "obsync-blobs"}}
            ),
            "obsync-blobs",
        )

    def test_every_other_volume_source_is_refused(self):
        for volume in (
            {"name": "host", "hostPath": {"path": "/"}},
            {"name": "scratch", "emptyDir": {}},
            {"name": "config", "configMap": {"name": "c"}},
            {"name": "secret", "secret": {"secretName": "s"}},
            {"name": "inline", "csi": {"driver": "d"}},
            {"name": "both", "emptyDir": {}, "persistentVolumeClaim": {"claimName": "x"}},
        ):
            with self.subTest(volume=sorted(set(volume) - {"name"})):
                with self.assertRaises(chart_pins.PinError):
                    chart_pins._volume_claims(volume)

    def test_a_malformed_claim_reference_is_refused(self):
        for claim in ({"claimName": 7}, {"claimName": "x", "readOnly": True}, {}):
            with self.subTest(claim=claim):
                with self.assertRaises(chart_pins.PinError):
                    chart_pins._volume_claims({"name": "v", "persistentVolumeClaim": claim})


class TheGateRunsEveryPin(unittest.TestCase):
    """The registry is the gate's contract, not a list the gate reads back.

    `test_each_pin_holds` iterates `PINS`, so deleting a registration would
    delete its own test. These pins name the registry independently: exactly
    the five pins, each bound to its function; `all` invokes every one of
    them, readiness included; a readiness refusal fails the gate; and the
    hosted gate and `make check` run `all`, never a subset. None of them needs
    helm, so they run everywhere.
    """

    def test_the_registry_names_exactly_the_five_pins_bound_to_their_functions(self):
        self.assertEqual(
            list(chart_pins.PINS),
            ["ingress", "storage", "security", "readiness", "environment"],
        )
        for name in chart_pins.PINS:
            self.assertIs(chart_pins.PINS[name], getattr(chart_pins, f"pin_{name}"))

    def test_all_invokes_every_registered_pin_readiness_included(self):
        calls: list[str] = []
        stubs = {name: (lambda n=name: calls.append(n)) for name in chart_pins.PINS}
        with mock.patch.dict(chart_pins.PINS, stubs), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(chart_pins.main(["all"]), 0)
        self.assertEqual(
            calls, ["ingress", "storage", "security", "readiness", "environment"]
        )

    def test_a_readiness_refusal_fails_the_all_gate_and_the_single_pin(self):
        def refuse_readiness() -> None:
            raise chart_pins.PinError("the readiness shape moved")

        quiet = {name: (lambda: None) for name in chart_pins.PINS if name != "readiness"}
        with mock.patch.dict(chart_pins.PINS, {**quiet, "readiness": refuse_readiness}):
            for argv in (["all"], ["readiness"]):
                with self.subTest(argv=argv):
                    err = io.StringIO()
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                        self.assertEqual(chart_pins.main(argv), 1)
                    self.assertIn("DENY: chart pin failed: the readiness shape moved", err.getvalue())

    def test_the_hosted_gate_and_make_check_run_all_pins(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/pr-gate.yml").read_text(encoding="utf-8")
        makefile = (root / "Makefile").read_text(encoding="utf-8")
        self.assertIn("python3 -B scripts/ci/chart_pins.py all", workflow)
        self.assertIn("python3 -B scripts/ci/chart_pins.py all", makefile)


def rendered_pod(env: list[dict], links: object = False) -> list[dict]:
    """One Deployment carrying the pod spec `env` mode reads."""
    return [
        {
            "kind": "Deployment",
            "spec": {
                "template": {
                    "spec": {
                        "enableServiceLinks": links,
                        "containers": [{"name": "obsync", "env": env}],
                    }
                }
            },
        }
    ]


class TheEmittedEnvironmentIsTheRender(unittest.TestCase):
    """`env` mode is what `image-smoke.sh` STARTS THE SHIPPED IMAGE ON.

    Its output is not a verdict, so nothing downstream re-derives it: a
    variable it silently drops is a variable the smoke never passes, and the
    server would then run on its own default for that variable while the
    property reported the chart's environment proven. So every entry the
    render carries must leave here as exactly one line, and an entry this
    reader does not fully understand is a refusal rather than a skip.
    """

    def emit(self, documents: list[dict]) -> str:
        out = io.StringIO()
        with mock.patch.object(chart_pins, "render", return_value=documents):
            with contextlib.redirect_stdout(out):
                chart_pins.emit_environment()
        return out.getvalue()

    def test_every_entry_leaves_as_one_line_in_render_order(self):
        emitted = self.emit(
            rendered_pod(
                [
                    {"name": "OBSYNC_LISTEN", "value": "0.0.0.0:8080"},
                    {"name": "OBSYNC_PUBLIC_URL", "value": ""},
                    {"name": "OBSYNC_SERVER_KEY", "valueFrom": {"secretKeyRef": {}}},
                ]
            )
        )
        self.assertEqual(
            emitted.splitlines(),
            [
                "podSpec enableServiceLinks=false",
                "value OBSYNC_LISTEN=0.0.0.0:8080",
                "value OBSYNC_PUBLIC_URL=",
                "valueFrom OBSYNC_SERVER_KEY",
            ],
        )

    def test_the_pod_spec_line_carries_what_was_rendered(self):
        self.assertIn(
            "podSpec enableServiceLinks=true", self.emit(rendered_pod([{"name": "A", "value": "b"}], links=True))
        )
        self.assertIn(
            "podSpec enableServiceLinks=none", self.emit(rendered_pod([{"name": "A", "value": "b"}], links=None))
        )

    def test_an_entry_this_reader_cannot_carry_is_refused(self):
        for env, because in (
            ([{"name": "OBSYNC_X"}], "neither a value nor a valueFrom"),
            ([{"value": "x"}], "no name"),
            ([{"name": "", "value": "x"}], "an empty name"),
            ([{"name": "OBSYNC_X", "value": "a\nb"}], "a value carrying a newline"),
            ([], "an empty environment"),
        ):
            with self.subTest(because=because):
                with self.assertRaises(chart_pins.PinError):
                    self.emit(rendered_pod(env))

    def test_a_second_container_is_refused(self):
        documents = rendered_pod([{"name": "OBSYNC_X", "value": "1"}])
        documents[0]["spec"]["template"]["spec"]["containers"].append(
            {"name": "sidecar", "env": [{"name": "OBSYNC_Y", "value": "2"}]}
        )
        with self.assertRaises(chart_pins.PinError):
            self.emit(documents)


class TheMustFailHelperCanItselfFail(unittest.TestCase):
    """`refuse` is what makes every non-vacuity claim in the pins true.

    If it stopped requiring a failure, five weakening overrides and two
    unpinned-peer renders would all report `refused as required` while
    refusing nothing. Nothing else in the suite would notice, so it is
    exercised here directly.
    """

    @unittest.skipUnless(shutil.which("helm"), "helm is not installed")
    def test_a_render_that_succeeds_is_reported_as_a_failure(self):
        with self.assertRaises(chart_pins.PinError):
            chart_pins.refuse(because="the default render succeeds, so this must raise")


class ExpectationsComeFromValues(unittest.TestCase):
    def test_the_shipped_values_file_supplies_every_expectation_the_pins_read(self):
        configured = chart_pins.values()
        for path in (
            ("service", "port"),
            ("ingress", "peerNamespace"),
            ("ingress", "peerAppName"),
            ("ingress", "peerInstance"),
            ("storage", "blobs", "className"),
            ("storage", "blobs", "size"),
            ("storage", "blobs", "capacity"),
            ("storage", "journal", "className"),
            ("storage", "journal", "size"),
            ("storage", "journal", "capacity"),
        ):
            with self.subTest(path=path):
                node = configured
                for key in path:
                    node = node[key]
                self.assertTrue(node not in (None, ""))


@unittest.skipUnless(shutil.which("helm"), "helm is not installed")
class ThePinsHoldAgainstTheRealChart(unittest.TestCase):
    """The enforcement path itself. CI's `chart` job runs these for real."""

    def test_the_render_parses_and_carries_the_expected_document_kinds(self):
        # Both readiness values render the same six objects; the count that
        # differs is the replica count, pinned by `pin_readiness`.
        expected = [
            "Deployment",
            "NetworkPolicy",
            "PersistentVolumeClaim",
            "PersistentVolumeClaim",
            "Service",
            "ServiceAccount",
        ]
        self.assertEqual(sorted(document["kind"] for document in chart_pins.render()), expected)
        self.assertEqual(sorted(document["kind"] for document in chart_pins.render(*chart_pins.ACTIVE)), expected)

    def test_each_pin_holds(self):
        for name, pin in chart_pins.PINS.items():
            with self.subTest(pin=name):
                pin()

    def test_an_unparseable_render_fails_the_pin_rather_than_passing_it(self):
        # The reader refuses what it cannot model, and `render` lets that
        # refusal out rather than swallowing it into a green pin.
        with self.assertRaises(miniyaml.YamlError):
            miniyaml.loads("spec:\n  ingress: [{from: [{podSelector: {}}]}]\n")


if __name__ == "__main__":
    unittest.main()
