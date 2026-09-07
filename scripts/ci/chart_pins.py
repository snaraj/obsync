#!/usr/bin/env python3
"""Prove what `helm template` actually renders -- structurally, not by grep.

THREE PINS, each named by the property it holds:

  ingress   the NetworkPolicy admits EXACTLY ONE peer, named by every fact it
            takes to name one connector (namespace + app name + instance), on
            the service port only, and denies all egress.
  storage   the render carries exactly the claims docs/storage.md defines, on
            the classes and sizes chart/values.yaml names, and the workload
            mounts NOTHING but those claims -- no hostPath, no emptyDir, no
            Secret or ConfigMap volume, no CSI inline volume.
  security  the pod and container security context is the one requirement 4
            fixes, and a values override cannot weaken any part of it.

HOW THESE READ THE RENDER -- the security-critical part. They do NOT count
`- from:` lines and inspect the first: that is bypassable. A second ingress
rule with no `from` renders an allow-all while a `from`-line count stays at
one, and a second NetworkPolicy in another template is additive and invisible
to `--show-only`. So each pin reads the COMPLETE render (every template, no
`--show-only`) through `scripts/ci/miniyaml.py`, a fail-closed reader that
refuses every construct it does not fully model. An unparseable render is a
FAILED pin, never a passed one.

EXPECTATIONS COME FROM `chart/values.yaml`, the single deployment-provider
binding point, so the peer identity and the storage classes are stated in
exactly one place and this file names no provider and no class.

NON-VACUITY IS PROVEN IN THE PIN, not assumed. Each pin drives at least one
render that MUST fail -- an unpinned peer instance, a weakened security
context -- so a gate that had stopped being able to fail would itself fail.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402

CHART_DIR = Path(os.environ.get("CHART_DIR", "chart"))
KUBE_VERSION = os.environ.get("KUBE_VERSION", "v1.36.0")
RELEASE = "pin"
NAMESPACE = "pin-namespace"

BLOBS_MOUNT = "/data/blobs"
JOURNAL_MOUNT = "/data/journal"
MIRROR_ROOT = "/data/mirrors"


class PinError(AssertionError):
    """One refused render. Every pin failure is one of these."""


def values() -> dict[str, Any]:
    """The chart's shipped defaults, read once, used as every expectation."""
    document = miniyaml.load_one((CHART_DIR / "values.yaml").read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise PinError("chart/values.yaml is not a mapping")
    return document


def _helm(sets: list[str]) -> subprocess.CompletedProcess[str]:
    command = [
        "helm", "template", RELEASE, str(CHART_DIR),
        "--namespace", NAMESPACE,
        "--kube-version", KUBE_VERSION,
    ]
    for override in sets:
        command.extend(("--set", override))
    return subprocess.run(command, check=False, capture_output=True, text=True)


def render(*sets: str) -> list[dict[str, Any]]:
    """Render the COMPLETE chart and read it with the fail-closed reader."""
    completed = _helm(list(sets))
    if completed.returncode != 0:
        raise PinError(f"helm template {' '.join(sets)} failed:\n{completed.stderr.strip()}")
    documents = miniyaml.loads(completed.stdout)
    resolved = [document for document in documents if document is not None]
    if not resolved:
        raise PinError("the render produced no document")
    for document in resolved:
        if not isinstance(document, dict) or "kind" not in document:
            raise PinError("the render carries a document with no kind")
    return resolved


def refuse(*sets: str, because: str) -> None:
    """Require a render to FAIL. A gate that cannot fail is not a gate."""
    completed = _helm(list(sets))
    if completed.returncode == 0:
        raise PinError(f"render accepted {' '.join(sets)}; it must be refused ({because})")
    print(f"  refused as required: {' '.join(sets)} ({because})")


def only(documents: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    matches = [document for document in documents if document.get("kind") == kind]
    if len(matches) != 1:
        raise PinError(f"expected exactly one {kind} in the render, found {len(matches)}")
    return matches[0]


def every(documents: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [document for document in documents if document.get("kind") == kind]


def equals(actual: Any, expected: Any, what: str) -> None:
    if actual != expected:
        raise PinError(f"{what} is\n  {actual!r}\nand must be\n  {expected!r}")


def selector_labels() -> dict[str, str]:
    return {"app.kubernetes.io/name": "obsync", "app.kubernetes.io/instance": RELEASE}


# --------------------------------------------------------------------------


def pin_ingress() -> None:
    configured = values()
    port = configured["service"]["port"]

    def expected_rule(instance: str) -> list[dict[str, Any]]:
        return [
            {
                "from": [
                    {
                        "namespaceSelector": {
                            "matchLabels": {
                                "kubernetes.io/metadata.name": configured["ingress"][
                                    "peerNamespace"
                                ]
                            }
                        },
                        "podSelector": {
                            "matchLabels": {
                                "app.kubernetes.io/name": configured["ingress"]["peerAppName"],
                                "app.kubernetes.io/instance": instance,
                            }
                        },
                    }
                ],
                "ports": [{"port": port, "protocol": "TCP"}],
            }
        ]

    policy = only(render(), "NetworkPolicy")
    spec = policy["spec"]
    equals(spec["podSelector"], {"matchLabels": selector_labels()}, "the policy podSelector")
    equals(spec["policyTypes"], ["Ingress", "Egress"], "the policy types")
    equals(
        spec["ingress"],
        expected_rule(configured["ingress"]["peerInstance"]),
        "the rendered ingress rule set",
    )
    equals(spec["egress"], [], "the rendered egress rule set")
    print("chart-pins ingress: (a) the default render admits exactly the one values peer")

    # (b) An unpinned instance must be refused rather than rendering wide.
    refuse("ingress.peerInstance=", because="a blank peer instance admits every peer in the namespace")
    refuse(
        "ingress.peerInstance=null",
        because="an absent peer instance admits every peer in the namespace",
    )
    print("chart-pins ingress: (b) a blank or absent peer instance is refused by the schema")

    # (c) The pin MOVES with the value, which is what proves it reads the
    # instance at all rather than matching a constant.
    moved = only(render("ingress.peerInstance=other-tunnel"), "NetworkPolicy")
    equals(moved["spec"]["ingress"], expected_rule("other-tunnel"), "the overridden ingress rule")
    if configured["ingress"]["peerInstance"] in str(moved["spec"]["ingress"]):
        raise PinError("the overridden render still names the default peer instance")
    print("chart-pins ingress: (c) an overridden instance moves the pin and leaves no default")


def _volume_claims(volume: dict[str, Any]) -> str:
    """The claim a workload volume names, refusing every other volume source."""
    sources = set(volume) - {"name"}
    if sources != {"persistentVolumeClaim"}:
        raise PinError(
            f"volume {volume.get('name')!r} carries volume source(s) {sorted(sources)}; "
            "this workload may mount nothing but PersistentVolumeClaims"
        )
    claim = volume["persistentVolumeClaim"]
    if set(claim) != {"claimName"} or not isinstance(claim["claimName"], str):
        raise PinError(f"volume {volume.get('name')!r} has a malformed claim reference")
    return claim["claimName"]


def _assert_claim(claim: dict[str, Any], *, name: str, spec: dict[str, Any]) -> None:
    equals(claim["metadata"]["name"], name, f"the {name} claim name")
    equals(claim["spec"]["accessModes"], ["ReadWriteOnce"], f"the {name} access modes")
    equals(claim["spec"]["storageClassName"], spec["className"], f"the {name} storage class")
    equals(claim["spec"]["resources"]["requests"]["storage"], spec["size"], f"the {name} size")
    equals(
        claim["metadata"]["annotations"]["platform.snaraj.dev/volume-capacity"],
        spec["capacity"],
        f"the {name} provisioned-capacity annotation",
    )


def pin_storage() -> None:
    configured = values()
    documents = render()

    claims = {claim["metadata"]["name"]: claim for claim in every(documents, "PersistentVolumeClaim")}
    equals(sorted(claims), ["obsync-blobs", "obsync-journal"], "the default claim inventory")
    _assert_claim(claims["obsync-blobs"], name="obsync-blobs", spec=configured["storage"]["blobs"])
    _assert_claim(
        claims["obsync-journal"], name="obsync-journal", spec=configured["storage"]["journal"]
    )
    print("chart-pins storage: (a) exactly two claims, on the classes and sizes values names")

    pod = only(documents, "Deployment")["spec"]["template"]["spec"]
    bound = {volume["name"]: _volume_claims(volume) for volume in pod["volumes"]}
    equals(bound, {"blobs": "obsync-blobs", "journal": "obsync-journal"}, "the workload volumes")
    container = pod["containers"][0]
    mounts = {mount["name"]: mount["mountPath"] for mount in container["volumeMounts"]}
    equals(mounts, {"blobs": BLOBS_MOUNT, "journal": JOURNAL_MOUNT}, "the workload mounts")
    print("chart-pins storage: (b) no hostPath, emptyDir, Secret, ConfigMap, or inline volume")

    # (c) A mirror is the one declared way to add a third volume, and it must
    # arrive as a claim like the other two -- and reach the process, or it is a
    # mount nothing writes to.
    mirrored = render(
        "storage.mirrors[0].name=spare",
        "storage.mirrors[0].className=local-pie-ssd",
        "storage.mirrors[0].size=100Gi",
        "storage.mirrors[0].capacity=100Gi",
    )
    mirror_claims = sorted(
        claim["metadata"]["name"] for claim in every(mirrored, "PersistentVolumeClaim")
    )
    equals(
        mirror_claims,
        ["obsync-blobs", "obsync-journal", "obsync-mirror-spare"],
        "the mirrored claim inventory",
    )
    mirror_pod = only(mirrored, "Deployment")["spec"]["template"]["spec"]
    equals(
        {volume["name"]: _volume_claims(volume) for volume in mirror_pod["volumes"]},
        {
            "blobs": "obsync-blobs",
            "journal": "obsync-journal",
            "mirror-spare": "obsync-mirror-spare",
        },
        "the mirrored workload volumes",
    )
    environment = {
        entry["name"]: entry.get("value")
        for entry in mirror_pod["containers"][0]["env"]
        if "value" in entry
    }
    equals(
        environment["OBSYNC_BLOBS_MIRRORS"],
        f"{MIRROR_ROOT}/spare",
        "the mirror list the process reads",
    )
    equals(environment["OBSYNC_BLOBS_DIR"], BLOBS_MOUNT, "the blob directory the process reads")
    equals(
        environment["OBSYNC_JOURNAL_DIR"], JOURNAL_MOUNT, "the journal directory the process reads"
    )
    print("chart-pins storage: (c) a mirror renders as a third claim and reaches the process")

    # (d) The free-space math has no statvfs to fall back on, so the declared
    # capacity IS the guarantee. It must be the CLAIM SIZE and never the
    # provisioned volume capacity: a grown volume behind an un-resized claim
    # would make the watermark fire late, which is the failure that fills a
    # disk. Asserting it against the render is what stops that being one
    # careless values reference away.
    default = {
        entry["name"]: entry.get("value")
        for entry in only(documents, "Deployment")["spec"]["template"]["spec"]["containers"][0][
            "env"
        ]
        if "value" in entry
    }
    for variable, expected in (
        ("OBSYNC_BLOBS_CAPACITY", configured["storage"]["blobs"]["size"]),
        ("OBSYNC_JOURNAL_CAPACITY", configured["storage"]["journal"]["size"]),
        ("OBSYNC_BLOBS_CLASS", configured["storage"]["blobs"]["className"]),
        ("OBSYNC_JOURNAL_CLASS", configured["storage"]["journal"]["className"]),
    ):
        equals(default[variable], str(expected), f"the rendered {variable}")
    print("chart-pins storage: (d) declared capacity is the claim size, and the class is labelled")

    # (e) A half-specified mirror must fail the render rather than mounting a
    # claim nobody provisioned.
    refuse("storage.mirrors[0].name=spare", because="a mirror with no class, size, or capacity")
    print("chart-pins storage: (e) a half-specified mirror is refused by the schema")


def pin_security() -> None:
    documents = render()
    pod = only(documents, "Deployment")["spec"]["template"]["spec"]
    equals(pod["automountServiceAccountToken"], False, "the pod service-account token mount")
    equals(
        only(documents, "ServiceAccount")["automountServiceAccountToken"],
        False,
        "the ServiceAccount token mount",
    )
    equals(
        pod["securityContext"],
        {
            "runAsNonRoot": True,
            "runAsUser": 65532,
            "runAsGroup": 65532,
            "fsGroup": 65532,
            "seccompProfile": {"type": "RuntimeDefault"},
        },
        "the pod security context",
    )
    container = pod["containers"][0]
    equals(
        container["securityContext"],
        {
            "allowPrivilegeEscalation": False,
            "readOnlyRootFilesystem": True,
            "capabilities": {"drop": ["ALL"]},
        },
        "the container security context",
    )
    equals(pod["terminationGracePeriodSeconds"], 30, "the termination grace period")
    equals(only(documents, "Deployment")["spec"]["strategy"], {"type": "Recreate"}, "the strategy")
    equals(only(documents, "Deployment")["spec"]["replicas"], 1, "the replica count")
    print("chart-pins security: (a) the rendered posture is the one requirement 4 fixes")

    # (b) The posture is not merely the default: every part of it is a schema
    # const, so an override may restate it and can never weaken it.
    for override, because in (
        ("securityContext.readOnlyRootFilesystem=false", "a writable root filesystem"),
        ("securityContext.runAsNonRoot=false", "running as root"),
        ("securityContext.allowPrivilegeEscalation=true", "privilege escalation"),
        ("securityContext.dropCapabilities=NET_RAW", "keeping capabilities"),
        ("securityContext.seccompProfile=Unconfined", "an unconfined seccomp profile"),
    ):
        refuse(override, because=because)
    print("chart-pins security: (b) every weakening override is refused by the schema")

    # (c) The image reference keeps its digest. A tag alone resolves whatever
    # the registry says today.
    image = container["image"]
    if "@sha256:" not in image or not image.startswith("ghcr.io/snaraj/obsync:v"):
        raise PinError(f"the rendered image reference {image!r} is not repository:tag@digest")
    print("chart-pins security: (c) the workload reference renders repository:tag@digest")


PINS = {"ingress": pin_ingress, "storage": pin_storage, "security": pin_security}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("pin", choices=(*PINS, "all"))
    args = parser.parse_args(argv)
    selected = list(PINS) if args.pin == "all" else [args.pin]
    try:
        for name in selected:
            PINS[name]()
    except (PinError, KeyError, IndexError, TypeError, miniyaml.YamlError) as exc:
        print(f"DENY: chart pin failed: {exc}", file=sys.stderr)
        return 1
    print(f"chart pins: {', '.join(selected)} hold")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
