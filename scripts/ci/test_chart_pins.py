"""Hostile tests for the chart pins.

The pins themselves shell out to `helm template`, so this suite splits in two
on purpose. The DECISION functions -- the ones that say whether a render is
acceptable -- are exercised directly against hand-built documents, including
every shape a counted-lines gate would have passed. The end-to-end pins are
exercised for real when helm is present, which it always is in the `chart` CI
job that enforces them.
"""

from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path

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
        kinds = sorted(document["kind"] for document in chart_pins.render())
        self.assertEqual(
            kinds,
            [
                "Deployment",
                "NetworkPolicy",
                "PersistentVolumeClaim",
                "PersistentVolumeClaim",
                "Service",
                "ServiceAccount",
            ],
        )

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
