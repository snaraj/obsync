#!/usr/bin/env python3
"""Prove what `helm template` actually renders -- structurally, not by grep.

THE PINS, each named by the property it holds:

  ingress   the NetworkPolicy admits EXACTLY the values peers -- each pod named
            by every fact it takes to name one connector (namespace + app name
            + instance), each address block narrower than everything -- on the
            service port only, admits NOTHING when none is named, and denies
            all egress.
  storage   the render carries exactly the claims docs/storage.md defines, on
            the classes and sizes chart/values.yaml names, and the workload
            mounts NOTHING but those claims -- no hostPath, no emptyDir, no
            Secret or ConfigMap volume, no CSI inline volume -- and the
            static-volume example pre-binds exactly those claims.
  security  the pod and container security context is the one requirement 4
            fixes, and a values override cannot weaken any part of it.
  environment
            the rendered process environment is one the SERVER can parse: the
            claim sizes it is told are Kubernetes binary quantities, and the
            kubelet adds no OBSYNC_* name of its own.
  kubernetes
            the chart renders on every Kubernetes minor `Chart.yaml` claims,
            suffixed vendor versions included, and refuses the minor below.
  platform  the two platform annotations render only under a domain the
            operator names, on exactly their objects, and a domain the API
            server would refuse as a key prefix, or that Kubernetes reserves,
            fails the render by name.

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
import re
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

# The operating documents that tell an operator which claims to provision.
# They are read against the RENDER, never the other way round: the chart is
# what Kubernetes obeys, so a name only the prose believes in is the prose's
# defect. The pattern is deliberately loose -- any backticked `<word>-blobs`
# or `<word>-journal` -- so a WRONG name is caught rather than merely a
# missing one. A volume pre-bound to a claim nobody creates binds to nothing,
# and the workload then waits forever on storage that exists.
CLAIM_DOCUMENTS = (Path("docs/storage.md"), Path("docs/platform-onboarding.md"))
CLAIM_IN_PROSE = re.compile(r"`([a-z0-9][a-z0-9-]*-(?:blobs|journal))`")
# The same defect in YAML: the example PersistentVolumes pre-bind by claim name.
STATIC_VOLUME_EXAMPLE = CHART_DIR / "examples" / "static-local-volumes.yaml"


class PinError(AssertionError):
    """One refused render. Every pin failure is one of these."""


def values() -> dict[str, Any]:
    """The chart's shipped defaults, read once, used as every expectation."""
    document = miniyaml.load_one((CHART_DIR / "values.yaml").read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise PinError("chart/values.yaml is not a mapping")
    return document


def _helm(sets: list[str], kube_version: str = KUBE_VERSION) -> subprocess.CompletedProcess[str]:
    command = [
        "helm", "template", RELEASE, str(CHART_DIR),
        "--namespace", NAMESPACE,
        "--kube-version", kube_version,
    ]
    for override in sets:
        command.extend(("--set", override))
    return subprocess.run(command, check=False, capture_output=True, text=True)


ACTIVE = ("deploymentReady=true",)
"""The platform-ready render: the shipped default is false, which renders the
same objects with zero application replicas (see `pin_readiness`), so every
pin that inspects the running shape renders with the gate open."""

DOMAIN = "platform.example.org"
ANNOTATED = (f"platform.annotationDomain={DOMAIN}",)
"""A render under a platform domain. The shipped default names none and renders
neither platform annotation (see `pin_platform`), so every pin that reads what
an annotation CARRIES renders with one set."""


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


def refuse(*sets: str, because: str, naming: str | None = None) -> None:
    """Require a render to FAIL. A gate that cannot fail is not a gate.

    `naming` also requires the refusal to name that value, so a render that
    fails for some other reason is not mistaken for this refusal.
    """
    completed = _helm(list(sets))
    if completed.returncode == 0:
        raise PinError(f"render accepted {' '.join(sets)}; it must be refused ({because})")
    if naming is not None and naming not in completed.stderr:
        raise PinError(
            f"render of {' '.join(sets)} was refused without naming {naming!r} ({because}):\n"
            f"{completed.stderr.strip()}"
        )
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


def rendered_annotations(documents: list[dict[str, Any]]) -> dict[str, Any]:
    """Every `metadata.annotations` in a render, keyed by where it stands.

    Anywhere, not only on each document's own metadata: a pod template's
    annotations are in the render too, and a key moved there is as present as
    one left on the Deployment. An `annotations:` rendered with nothing under
    it is recorded as what it is, so an empty block is not read as absent.
    """
    found: dict[str, Any] = {}

    def walk(node: Any, where: str) -> None:
        if isinstance(node, dict):
            metadata = node.get("metadata")
            if isinstance(metadata, dict) and "annotations" in metadata:
                found[where] = metadata["annotations"]
            for key, value in node.items():
                if key != "metadata":
                    walk(value, f"{where}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{where}[{index}]")

    for document in documents:
        metadata = document.get("metadata")
        name = metadata.get("name") if isinstance(metadata, dict) else None
        walk(document, f"{document.get('kind')}/{name}")
    return found


# --------------------------------------------------------------------------


def _pod_peer(namespace: str, app: str, instance: str) -> dict[str, Any]:
    return {
        "namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": namespace}},
        "podSelector": {
            "matchLabels": {"app.kubernetes.io/name": app, "app.kubernetes.io/instance": instance}
        },
    }


def pin_ingress() -> None:
    configured = values()
    port = configured["service"]["port"]

    def rule(*peers: dict[str, Any]) -> list[dict[str, Any]]:
        return [{"from": list(peers), "ports": [{"port": port, "protocol": "TCP"}]}]

    def ingress(*sets: str) -> Any:
        spec = only(render(*ACTIVE, *sets), "NetworkPolicy")["spec"]
        equals(spec["podSelector"], {"matchLabels": selector_labels()}, "the policy podSelector")
        equals(spec["policyTypes"], ["Ingress", "Egress"], "the policy types")
        equals(spec["egress"], [], "the rendered egress rule set")
        return spec["ingress"]

    # (a) The shipped default names no peer and admits NOTHING: no rule at
    # all, and never a rule with an empty `from`, which admits every source.
    equals(configured["ingress"], {"peers": []}, "the shipped ingress default")
    equals(ingress(), [], "the default ingress rule set")
    print("chart-pins ingress: (a) the default render admits nothing and renders no rule")

    # (b) Every values peer renders exactly, in order: a pod by all three of
    # its facts, an address block with its exceptions. The expectation is
    # built from the SETS, so the pin moves with the values it is given.
    pod = ("ingress.peers[0].namespace=ing", "ingress.peers[0].appName=front", "ingress.peers[0].instance=front")
    block = ("ingress.peers[1].ipBlock.cidr=192.168.1.0/24", "ingress.peers[1].ipBlock.except[0]=192.168.1.1/32")
    equals(
        ingress(*pod, *block),
        rule(
            _pod_peer("ing", "front", "front"),
            {"ipBlock": {"cidr": "192.168.1.0/24", "except": ["192.168.1.1/32"]}},
        ),
        "the rendered pod and block peers",
    )
    print("chart-pins ingress: (b) a pod and an address block render exactly as named")

    # (c) The single-peer fields earlier releases shipped render the rule they
    # always rendered, first, so an existing values file keeps its policy.
    legacy = (
        "ingress.peerNamespace=edge",
        "ingress.peerAppName=connector",
        "ingress.peerInstance=connector-one",
    )
    equals(ingress(*legacy), rule(_pod_peer("edge", "connector", "connector-one")), "the legacy peer")
    equals(
        ingress(*legacy, *pod),
        rule(_pod_peer("edge", "connector", "connector-one"), _pod_peer("ing", "front", "front")),
        "the legacy peer beside a listed one",
    )
    print("chart-pins ingress: (c) the single-peer form renders its old rule, first")

    # (d) Anything that would read narrow and behave wide is refused.
    refuse(*pod[:2], because="a pod peer with no instance admits every connector in its namespace")
    refuse(*pod[:2], "ingress.peers[0].instance=", because="a blank instance admits every connector")
    refuse(*legacy[:2], because="the single-peer form without its instance")
    refuse(*legacy[:2], "ingress.peerInstance=", because="the single-peer form with a blank instance")
    refuse("ingress.peers[0].ipBlock.cidr=0.0.0.0/0", because="a block holding every IPv4 address")
    refuse("ingress.peers[0].ipBlock.cidr=::/0", because="a block holding every IPv6 address")
    refuse(*pod, "ingress.peers[0].ipBlock.cidr=10.0.0.0/8", because="one entry naming a pod and a block")
    refuse("trustedProxyCidrs[0]=0.0.0.0/0", because="trusting every sender's forwarded address")
    print("chart-pins ingress: (d) unpinned pods, a partial single peer and a /0 are refused")


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


def _unknown_claim_names(text: str, known: set[str]) -> list[str]:
    """Claim names a document states that the chart does not create."""
    return sorted({name for name in CLAIM_IN_PROSE.findall(text) if name not in known})


def _assert_claim(claim: dict[str, Any], *, name: str, spec: dict[str, Any]) -> None:
    equals(claim["metadata"]["name"], name, f"the {name} claim name")
    equals(claim["spec"]["accessModes"], ["ReadWriteOnce"], f"the {name} access modes")
    equals(claim["spec"]["storageClassName"], spec["className"], f"the {name} storage class")
    equals(claim["spec"]["resources"]["requests"]["storage"], spec["size"], f"the {name} size")


def pin_storage() -> None:
    configured = values()
    documents = render(*ACTIVE)

    claims = {claim["metadata"]["name"]: claim for claim in every(documents, "PersistentVolumeClaim")}
    equals(sorted(claims), ["obsync-blobs", "obsync-journal"], "the default claim inventory")
    _assert_claim(claims["obsync-blobs"], name="obsync-blobs", spec=configured["storage"]["blobs"])
    _assert_claim(
        claims["obsync-journal"], name="obsync-journal", spec=configured["storage"]["journal"]
    )
    # The provisioned capacity rides on each claim under a platform domain.
    annotated = {
        claim["metadata"]["name"]: claim
        for claim in every(render(*ACTIVE, *ANNOTATED), "PersistentVolumeClaim")
    }
    for role in ("blobs", "journal"):
        equals(
            annotated[f"obsync-{role}"]["metadata"]["annotations"][f"{DOMAIN}/volume-capacity"],
            configured["storage"][role]["capacity"],
            f"the obsync-{role} provisioned-capacity annotation",
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
        *ACTIVE,
        "storage.mirrors[0].name=spare",
        f"storage.mirrors[0].className={configured['storage']['blobs']['className']}",
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
    # The shipped size and capacity are EQUAL, so the assertions above cannot
    # tell a template reading the right value from one reading the wrong one.
    # Drive a render where they differ -- a volume grown ahead of its claim,
    # the exact situation the distinction exists for -- and require the process
    # to still be told the claim size while the annotation reports the volume.
    grown = render(*ACTIVE, *ANNOTATED, "storage.blobs.capacity=500Gi")
    grown_pod = only(grown, "Deployment")["spec"]["template"]["spec"]
    grown_environment = {
        entry["name"]: entry.get("value")
        for entry in grown_pod["containers"][0]["env"]
        if "value" in entry
    }
    equals(
        grown_environment["OBSYNC_BLOBS_CAPACITY"],
        str(configured["storage"]["blobs"]["size"]),
        "the declared capacity when the volume is larger than the claim",
    )
    grown_claim = {
        claim["metadata"]["name"]: claim for claim in every(grown, "PersistentVolumeClaim")
    }["obsync-blobs"]
    equals(
        grown_claim["metadata"]["annotations"][f"{DOMAIN}/volume-capacity"],
        "500Gi",
        "the provisioned-capacity annotation when the volume is larger than the claim",
    )
    equals(
        grown_claim["spec"]["resources"]["requests"]["storage"],
        configured["storage"]["blobs"]["size"],
        "the claim request when the volume is larger than the claim",
    )
    print("chart-pins storage: (d) declared capacity is the claim size, and the class is labelled")

    # (e) A half-specified mirror must fail the render rather than mounting a
    # claim nobody provisioned.
    refuse("storage.mirrors[0].name=spare", because="a mirror with no class, size, or capacity")
    print("chart-pins storage: (e) a half-specified mirror is refused by the schema")

    # (f) The operating documents name the claims this chart actually creates.
    # They named `obsidian-blobs` and `obsidian-journal` -- the NAMESPACE with
    # the role appended -- while the chart creates `obsync-blobs` and
    # `obsync-journal`, because every object it renders is named for the
    # application. A platform lane following the document would have
    # provisioned two volumes pre-bound to claims that never appear.
    known = set(claims)
    for document in CLAIM_DOCUMENTS:
        text = document.read_text(encoding="utf-8")
        unknown = _unknown_claim_names(text, known)
        if unknown:
            raise PinError(
                f"{document} names claim(s) {unknown}, which this chart does not "
                f"create; it creates {sorted(known)}"
            )
    storage_doc = CLAIM_DOCUMENTS[0].read_text(encoding="utf-8")
    for name in sorted(known):
        if f"`{name}`" not in storage_doc:
            raise PinError(f"{CLAIM_DOCUMENTS[0]} does not name the {name} claim")
    # Non-vacuity, proven against the real text: rename one claim in a copy of
    # the document and require the same function to refuse it. Derived from the
    # render, so this cannot rot into a check for a literal nobody uses.
    sample = sorted(known)[0]
    role = sample.rsplit("-", 1)[1]
    mutated = storage_doc.replace(f"`{sample}`", f"`stale-{role}`")
    if _unknown_claim_names(mutated, known) != [f"stale-{role}"]:
        raise PinError("the document check can no longer fail: it would pass a wrong claim name")
    print("chart-pins storage: (f) the operating documents name the claims the chart creates")

    # (g) chart/examples/static-local-volumes.yaml pre-binds each volume to a
    # claim by name, so a claim renamed here and not there binds nothing.
    example = miniyaml.loads(STATIC_VOLUME_EXAMPLE.read_text(encoding="utf-8"))
    equals(
        sorted(volume["spec"]["claimRef"]["name"] for volume in every(example, "PersistentVolume")),
        sorted(known),
        f"the claims {STATIC_VOLUME_EXAMPLE} pre-binds",
    )
    print("chart-pins storage: (g) the static-volume example pre-binds the claims the chart creates")


def pin_security() -> None:
    configured = values()
    documents = render(*ACTIVE)
    pod = only(documents, "Deployment")["spec"]["template"]["spec"]
    equals(pod["automountServiceAccountToken"], False, "the pod service-account token mount")
    # The server key wraps every device secret. A pod that started without it
    # would generate a second key and orphan every paired device, so the
    # reference must be non-optional: `optional: true` here is a silent
    # data-loss switch, not a resilience feature.
    key_reference = {
        entry["name"]: entry.get("valueFrom")
        for entry in pod["containers"][0]["env"]
        if "valueFrom" in entry
    }
    equals(
        key_reference,
        {
            "OBSYNC_SERVER_KEY": {
                "secretKeyRef": {
                    "name": configured["serverKeySecret"]["name"],
                    "key": configured["serverKeySecret"]["key"],
                }
            }
        },
        "the server key reference",
    )
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
            # No fsGroup: a group-sharing mechanism the server refuses the
            # result of (a group-writable volume directory). Exact equality
            # here is what pins its absence.
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
    # Requirement 7: readiness reflects real serving ability and never a
    # hardcoded yes. A chart that pointed the readiness probe at /livez would
    # report a process that is merely alive as ready to serve -- a hardcoded
    # yes written in YAML rather than in code -- so the three probe paths are
    # pinned here, where the render can be read.
    probes = {
        name: container[name]["httpGet"]["path"]
        for name in ("startupProbe", "readinessProbe", "livenessProbe")
    }
    equals(
        probes,
        {
            "startupProbe": "/livez",
            "readinessProbe": "/readyz",
            "livenessProbe": "/livez",
        },
        "the rendered probe paths",
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

    # (c) The image reference keeps its digest, whatever registry serves it. A
    # tag alone resolves whatever the registry says today, so a mirror may
    # change where the bytes come from and never which bytes run.
    image_values = configured["image"]
    pinned = f"{image_values['tag']}@{image_values['digest']}"
    equals(container["image"], f"{image_values['repository']}:{pinned}", "the image reference")
    mirror = "registry.example.org:5000/mirror/obsync"
    mirrored = only(render(*ACTIVE, f"image.repository={mirror}"), "Deployment")
    equals(
        mirrored["spec"]["template"]["spec"]["containers"][0]["image"],
        f"{mirror}:{pinned}",
        "the mirrored image reference",
    )
    refuse("image.digest=", because="an image with no digest resolves whatever a tag says today")
    refuse("image.repository=Not A Registry", because="a repository that is not a registry path")
    print("chart-pins security: (c) any repository renders repository:tag@digest, and never without it")

    # (d) Scheduling, registry credentials and pod labels pass through, and
    # none of them reaches the security context or the selector labels.
    scheduled = only(
        render(
            *ACTIVE,
            "nodeSelector.kubernetes\\.io/arch=arm64",
            "tolerations[0].key=dedicated",
            "tolerations[0].operator=Exists",
            "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=disk",
            "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=Exists",
            "imagePullSecrets[0].name=mirror-credentials",
            "podLabels.team=notes",
        ),
        "Deployment",
    )["spec"]["template"]
    spec = scheduled["spec"]
    equals(spec["nodeSelector"], {"kubernetes.io/arch": "arm64"}, "the node selector")
    equals(spec["tolerations"], [{"key": "dedicated", "operator": "Exists"}], "the tolerations")
    equals(
        spec["affinity"]["nodeAffinity"]["requiredDuringSchedulingIgnoredDuringExecution"],
        {"nodeSelectorTerms": [{"matchExpressions": [{"key": "disk", "operator": "Exists"}]}]},
        "the node affinity",
    )
    equals(spec["imagePullSecrets"], [{"name": "mirror-credentials"}], "the pull secrets")
    equals(scheduled["metadata"]["labels"]["team"], "notes", "an extra pod label")
    equals(spec["securityContext"], pod["securityContext"], "the scheduled pod security context")
    equals(
        spec["containers"][0]["securityContext"],
        container["securityContext"],
        "the scheduled container security context",
    )
    refuse("podLabels.app\\.kubernetes\\.io/name=other", because="a pod label the selectors match on")
    print("chart-pins security: (d) scheduling passes through and leaves the posture and selectors alone")




def pin_readiness() -> None:
    """`deploymentReady` gates the REPLICA COUNT, not a label on it.

    False (the shipped default) renders every object -- the claims can bind
    their volumes and the TLS proxy can resolve the Service -- with zero
    application replicas, so nothing waits on a volume or a Secret that does
    not exist yet. True is a scale from zero to one replica and nothing else,
    and the value itself is a boolean the schema refuses to coerce.
    """
    kinds = ["Deployment", "NetworkPolicy", "PersistentVolumeClaim", "PersistentVolumeClaim", "Service", "ServiceAccount"]
    print("chart-pins readiness: (a) the shipped default renders every object with zero replicas")
    pending = render()
    equals(sorted(document["kind"] for document in pending), kinds, "the pending render's document kinds")
    deployment = only(pending, "Deployment")
    equals(deployment["spec"]["replicas"], 0, "the pending replica count")
    deployment = only(render(*ANNOTATED), "Deployment")
    equals(deployment["metadata"]["annotations"][f"{DOMAIN}/deployment-ready"], "false", "the pending readiness annotation")
    print("chart-pins readiness: (b) the platform-ready render is the same objects at one replica")
    active = render(*ACTIVE)
    equals(sorted(document["kind"] for document in active), kinds, "the active render's document kinds")
    deployment = only(active, "Deployment")
    equals(deployment["spec"]["replicas"], 1, "the active replica count")
    deployment = only(render(*ACTIVE, *ANNOTATED), "Deployment")
    equals(deployment["metadata"]["annotations"][f"{DOMAIN}/deployment-ready"], "true", "the active readiness annotation")
    for name in ("obsync-blobs", "obsync-journal"):
        for shape, documents in (("pending", pending), ("active", active)):
            if not any(claim["metadata"]["name"] == name for claim in every(documents, "PersistentVolumeClaim")):
                raise PinError(f"the {shape} render does not create claim {name}")
    print("chart-pins readiness: (c) the gate is a boolean, never coerced")
    refuse("deploymentReady=yes", because="the schema admits only a boolean")
    refuse("deploymentReady=1", because="the schema admits only a boolean")


def _container_environment(pod: dict[str, Any]) -> list[dict[str, Any]]:
    """The one container's env list, exactly as rendered."""
    containers = pod["containers"]
    if len(containers) != 1:
        raise PinError(f"the pod renders {len(containers)} containers, not 1")
    environment = containers[0]["env"]
    if not isinstance(environment, list) or not environment:
        raise PinError("the container renders no environment")
    return environment


def pin_environment() -> None:
    """What the pod's process environment is, and what may put a name in it.

    The server refuses an OBSYNC_* variable it does not know
    (`ConfigError::Unknown`) and refuses a capacity it cannot parse, so both
    halves of "the chart's own defaults start the server" are decided by the
    RENDER: which names arrive, and what the size ones say. This pin holds the
    render; `scripts/ci/image-smoke.sh` runs the result.
    """
    pod = only(render(*ACTIVE), "Deployment")["spec"]["template"]["spec"]

    # (a) The kubelet injects OBSYNC_SERVICE_HOST, OBSYNC_SERVICE_PORT and
    # OBSYNC_PORT_* for a Service called `obsync` unless service links are
    # off, and every one of those is an unknown OBSYNC_* name the server
    # exits on. The Service keeps its name; the injection is what goes.
    equals(pod.get("enableServiceLinks"), False, "the pod service-link setting")
    print("chart-pins environment: (a) service links are off, so no OBSYNC_* name is injected")

    # (b) One string has to satisfy two readers -- the API server, which
    # takes a Kubernetes quantity, and obsync, which takes a binary size --
    # so the schema admits only their intersection. Each refusal below is a
    # value that renders a pod which cannot start.
    for override, because in (
        ("storage.blobs.size=250G", "250G is decimal: 7 % less than the volume, and no size to the server"),
        ("storage.journal.size=4G", "a decimal journal claim reaches the server the same way"),
        ("storage.blobs.size=250GB", "a decimal SI suffix"),
        ("storage.blobs.size=250GiB", "the server's own spelling is not a Kubernetes quantity"),
        ("storage.blobs.size=1.5Gi", "the grammar admits whole units only"),
        ("storage.blobs.size=250", "a bare byte count is not a claim size"),
    ):
        refuse(override, because=because)
    print("chart-pins environment: (b) every quantity one of the two readers refuses is refused here")

    # (c) ...and the pattern admits the grammar it is supposed to admit, and
    # that value reaches the process. A pattern that refused everything would
    # pass (b) and fail here.
    grown = only(render(*ACTIVE, "storage.blobs.size=500Gi"), "Deployment")["spec"]["template"][
        "spec"
    ]
    environment = {
        entry["name"]: entry.get("value")
        for entry in _container_environment(grown)
        if "value" in entry
    }
    equals(environment["OBSYNC_BLOBS_CAPACITY"], "500Gi", "an accepted claim size at the process")
    print("chart-pins environment: (c) an accepted binary quantity renders through to the process")


KUBE_FLOOR = ("v1.34.0", "v1.34.2-eks-1234", "v1.34.2-gke.100")
"""The lowest minor `Chart.yaml` claims, bare and with the pre-release-style
suffixes managed clusters report: the oldest node image the pinned kind
publishes (scripts/ci/install-kind.sh), so a live leg can prove what this
render claims. The templates themselves need nothing newer than 1.22."""
KUBE_CEILING = "v1.37.0"
KUBE_BELOW = "v1.33.9"


def pin_kubernetes() -> None:
    """The claimed range renders, suffixed versions included, and ends where it says."""
    for version in (*KUBE_FLOOR, KUBE_CEILING):
        completed = _helm(list(ACTIVE), kube_version=version)
        if completed.returncode != 0:
            raise PinError(f"the chart does not render on {version}:\n{completed.stderr.strip()}")
    print(f"chart-pins kubernetes: (a) renders on {', '.join((*KUBE_FLOOR, KUBE_CEILING))}")
    if _helm(list(ACTIVE), kube_version=KUBE_BELOW).returncode == 0:
        raise PinError(f"the chart renders on {KUBE_BELOW}, below the minor it claims")
    print(f"chart-pins kubernetes: (b) refuses {KUBE_BELOW}, the minor below the floor")


LONGEST_DOMAIN = ".".join(("a" * 63, "b" * 63, "c" * 63, "d" * 61))
"""A DNS subdomain of exactly 253 characters, the most a key prefix may hold."""


def pin_platform() -> None:
    """The platform annotations are one deployer's signals, rendered on request.

    A platform that promotes releases may read a readiness flag off the
    Deployment and a provisioned capacity off each claim, under ITS domain.
    Nobody else's render may carry that domain, so the shipped default names
    none and renders no annotation at all; a named domain renders exactly the
    two keys on exactly their objects; and a domain the API server would refuse
    as a key prefix, or one Kubernetes reserves for itself, fails the render by
    name instead of reaching a cluster. What the two annotations CARRY is held
    by `pin_readiness` and `pin_storage`, under a domain.
    """
    configured = values()
    equals(configured["platform"], {"annotationDomain": ""}, "the shipped platform default")
    mirror = (
        "storage.mirrors[0].name=spare",
        f"storage.mirrors[0].className={configured['storage']['blobs']['className']}",
        "storage.mirrors[0].size=100Gi",
        "storage.mirrors[0].capacity=100Gi",
    )
    for sets in ((), ACTIVE, (*ACTIVE, *mirror)):
        equals(rendered_annotations(render(*sets)), {}, f"the annotations of the render {' '.join(sets) or '(defaults)'}")
    print("chart-pins platform: (a) with no domain, the pending, active and mirrored renders carry no annotation")

    storage = configured["storage"]
    equals(
        rendered_annotations(render(*ACTIVE, *mirror, *ANNOTATED)),
        {
            "Deployment/obsync": {f"{DOMAIN}/deployment-ready": "true"},
            "PersistentVolumeClaim/obsync-blobs": {f"{DOMAIN}/volume-capacity": storage["blobs"]["capacity"]},
            "PersistentVolumeClaim/obsync-journal": {f"{DOMAIN}/volume-capacity": storage["journal"]["capacity"]},
            "PersistentVolumeClaim/obsync-mirror-spare": {f"{DOMAIN}/volume-capacity": "100Gi"},
        },
        "the annotations of a render under a platform domain",
    )
    print("chart-pins platform: (b) a named domain renders exactly the two keys, on exactly their objects")

    for domain in (LONGEST_DOMAIN, "cluster.x-k8s.io"):
        deployment = only(render(f"platform.annotationDomain={domain}"), "Deployment")
        equals(deployment["metadata"]["annotations"], {f"{domain}/deployment-ready": "false"}, f"the key under {domain}")
    print("chart-pins platform: (c) a 253-character domain and a domain merely ending in k8s.io render")

    for domain, because in (
        ("Platform.example.org", "an upper-case letter"),
        ("platform_example.org", "an underscore"),
        ("-platform.example.org", "a label that starts with a hyphen"),
        ("platform-.example.org", "a label that ends with a hyphen"),
        ("platform..example.org", "an empty label"),
        ("platform.example.org.", "a trailing dot"),
        ("platform.example.org/x", "a slash, which would split the key"),
        (f"{LONGEST_DOMAIN}d", "254 characters, one over the limit"),
        ("kubernetes.io", "the prefix Kubernetes reserves"),
        ("k8s.io", "the other prefix Kubernetes reserves"),
        ("apps.kubernetes.io", "a subdomain of kubernetes.io"),
        ("node.k8s.io", "a subdomain of k8s.io"),
    ):
        refuse(*ACTIVE, f"platform.annotationDomain={domain}", because=because, naming=domain)
    print("chart-pins platform: (d) an invalid or reserved domain fails the render, naming the value")


def emit_environment() -> None:
    """Print the rendered pod environment for a caller that RUNS it.

    `scripts/ci/image-smoke.sh` starts the shipped image on exactly these
    values, so this prints the render and never a copy of it: one
    `podSpec <field>=<value>` line, one `value <NAME>=<value>` line per
    literal variable, and one `valueFrom <NAME>` line per variable the
    cluster supplies from somewhere else.
    """
    pod = only(render(*ACTIVE), "Deployment")["spec"]["template"]["spec"]
    lines = [f"podSpec enableServiceLinks={str(pod.get('enableServiceLinks')).lower()}"]
    for entry in _container_environment(pod):
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            raise PinError(f"the container renders an unnamed environment entry: {entry!r}")
        if "value" in entry:
            value = entry["value"]
            if not isinstance(value, str):
                value = "true" if value is True else "false" if value is False else str(value)
            if "\n" in value:
                raise PinError(f"{name} renders a value carrying a newline; it cannot be emitted")
            lines.append(f"value {name}={value}")
        elif "valueFrom" in entry:
            lines.append(f"valueFrom {name}")
        else:
            raise PinError(f"{name} renders with neither a value nor a valueFrom")
    print("\n".join(lines))


PINS = {
    "ingress": pin_ingress,
    "storage": pin_storage,
    "security": pin_security,
    "readiness": pin_readiness,
    "environment": pin_environment,
    "kubernetes": pin_kubernetes,
    "platform": pin_platform,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("pin", choices=(*PINS, "all", "env"))
    args = parser.parse_args(argv)
    if args.pin == "env":
        # Output, not a verdict: the caller runs what this prints.
        try:
            emit_environment()
        except (PinError, KeyError, IndexError, TypeError, miniyaml.YamlError) as exc:
            print(f"DENY: the rendered environment could not be read: {exc}", file=sys.stderr)
            return 1
        return 0
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
