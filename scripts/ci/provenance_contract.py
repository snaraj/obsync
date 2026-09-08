#!/usr/bin/env python3
"""What a provenance statement over the image index must bind, per platform.

The publisher attests BuildKit's SLSA v1 provenance onto the multi-platform
index digest, one statement per production platform, and then verifies with
the consumer's own command. `cosign` proves WHO signed and over WHICH digest;
it does not prove that the two statements describe two different platforms,
or that every production platform is represented. This module decides that,
offline, from three documents the workflow already has:

  the OCI index          -> which platform manifests exist (attestation
                            manifests, `unknown/unknown`, are not platforms);
  each platform manifest -> its ordered layer digests;
  each predicate         -> `runDetails.metadata.buildkit_metadata.layers`,
                            the layer groups BuildKit emitted in `mode=max`.

A statement binds platform P when one of its predicate's layer groups is
EXACTLY P's manifest layer list. Nothing in the SLSA v1 predicate names the
target platform (`builderPlatform` is the build host), so identity is taken
from the bytes the provenance describes, not from a label. The rule is strict
on purpose: one platform per statement, one statement per platform, the index
carries no platform outside the expected set, and a reused image that lacks
any of this is not publishable.

Two entry points, both used by `.github/workflows/release-publisher.yml`:

  predicate  before `cosign attest`: the predicate read off the index for
             platform P is the BuildKit v1 shape, names THIS run as builder,
             and binds P.
  verify     after `cosign verify-attestation`: every DSSE line is an in-toto
             statement, SLSA v1, subject exactly the index digest, bound to
             exactly one expected platform; the platform set is complete.

Standard library only. Refusals are `Refusal` exceptions with one sentence.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from pathlib import Path

PAYLOAD_TYPE = "application/vnd.in-toto+json"
STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
BUILD_TYPE = "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md"
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
PLATFORM = re.compile(r"^[a-z0-9]+/[a-z0-9]+$")


class Refusal(Exception):
    """One sentence saying which decision failed."""


def _digest(value: object, what: str) -> str:
    if not isinstance(value, str) or not DIGEST.match(value):
        raise Refusal(f"{what} is not a sha256 digest")
    return value


def index_platforms(index: object) -> dict[str, str]:
    """Platform -> manifest digest for every platform manifest in the index."""
    if not isinstance(index, dict) or index.get("mediaType") not in INDEX_TYPES:
        raise Refusal("the image is not a multi-platform index")
    manifests = index.get("manifests")
    if not isinstance(manifests, list) or not manifests:
        raise Refusal("the index lists no manifests")
    platforms: dict[str, str] = {}
    for entry in manifests:
        if not isinstance(entry, dict):
            raise Refusal("an index entry is not an object")
        digest = _digest(entry.get("digest"), "an index entry digest")
        annotations = entry.get("annotations") or {}
        if annotations.get("vnd.docker.reference.type") == "attestation-manifest":
            continue
        platform = entry.get("platform")
        if not isinstance(platform, dict):
            raise Refusal(f"index entry {digest} names no platform")
        name = f"{platform.get('os')}/{platform.get('architecture')}"
        if name == "unknown/unknown":
            continue
        if not PLATFORM.match(name):
            raise Refusal(f"index entry {digest} has an unreadable platform")
        if name in platforms:
            raise Refusal(f"the index lists {name} twice")
        platforms[name] = digest
    if not platforms:
        raise Refusal("the index carries no platform manifest")
    return platforms


def manifest_layers(manifest: object) -> tuple[str, ...]:
    """The ordered layer digests of one platform manifest."""
    if not isinstance(manifest, dict) or not isinstance(manifest.get("layers"), list):
        raise Refusal("a platform manifest lists no layers")
    layers = tuple(_digest(layer.get("digest") if isinstance(layer, dict) else None, "a manifest layer")
                   for layer in manifest["layers"])
    if not layers:
        raise Refusal("a platform manifest has an empty layer list")
    return layers


def predicate_layer_groups(predicate: dict) -> list[tuple[str, ...]]:
    """Every layer group BuildKit recorded; requires `provenance: mode=max`."""
    metadata = predicate.get("runDetails", {}).get("metadata", {})
    layers = metadata.get("buildkit_metadata", {}).get("layers") if isinstance(metadata, dict) else None
    if not isinstance(layers, dict) or not layers:
        raise Refusal("the predicate records no layer groups (provenance mode is not max)")
    groups = []
    for step, arrays in layers.items():
        if not isinstance(arrays, list):
            raise Refusal(f"layer group {step} is malformed")
        for group in arrays:
            if not isinstance(group, list):
                raise Refusal(f"layer group {step} is malformed")
            groups.append(tuple(_digest(d.get("digest") if isinstance(d, dict) else None, f"a layer in {step}")
                                for d in group))
    return groups


def check_predicate(predicate: object, builder: str | None = None) -> dict:
    """The BuildKit SLSA v1 shape, naming `builder` when one is required."""
    if not isinstance(predicate, dict):
        raise Refusal("the predicate is not an object")
    definition, details = predicate.get("buildDefinition"), predicate.get("runDetails")
    if not isinstance(definition, dict) or not isinstance(details, dict):
        raise Refusal("the predicate is not SLSA v1 (buildDefinition and runDetails)")
    if definition.get("buildType") != BUILD_TYPE:
        raise Refusal("the predicate's buildType is not BuildKit's")
    if builder is not None:
        actual = (details.get("builder") or {}).get("id") if isinstance(details.get("builder"), dict) else None
        if not builder or actual != builder:
            raise Refusal(f"the predicate names builder {actual!r}, not this run")
    return predicate


def bound_platform(predicate: dict, layers_by_platform: dict[str, tuple[str, ...]]) -> str:
    """The one platform whose manifest layers appear as a whole group."""
    groups = set(predicate_layer_groups(predicate))
    bound = sorted(p for p, layers in layers_by_platform.items() if layers in groups)
    if len(bound) != 1:
        raise Refusal(f"the predicate binds {bound or 'no expected platform'}, not exactly one platform")
    return bound[0]


def parse_statement(line: str) -> dict:
    """One DSSE line from `cosign verify-attestation` -> the in-toto statement."""
    try:
        envelope = json.loads(line)
    except ValueError as error:
        raise Refusal(f"a verification line is not JSON: {error}") from None
    if not isinstance(envelope, dict) or envelope.get("payloadType") != PAYLOAD_TYPE:
        raise Refusal("attestation payload type is not in-toto")
    try:
        statement = json.loads(base64.b64decode(envelope.get("payload", ""), validate=True))
    except (ValueError, TypeError) as error:
        raise Refusal(f"attestation payload is not a base64 JSON statement: {error}") from None
    if not isinstance(statement, dict) or statement.get("_type") != STATEMENT_TYPE:
        raise Refusal("attestation is not an in-toto v1 statement")
    if statement.get("predicateType") != PREDICATE_TYPE:
        raise Refusal("attestation is not SLSA v1 provenance")
    return statement


def subject_digests(statement: dict) -> set[str]:
    subjects = statement.get("subject")
    if not isinstance(subjects, list) or not subjects:
        raise Refusal("the statement names no subject")
    digests = set()
    for subject in subjects:
        digest = (subject.get("digest") or {}).get("sha256") if isinstance(subject, dict) else None
        digests.add(_digest(f"sha256:{digest}" if isinstance(digest, str) else None, "a subject digest"))
    return digests


def expected_layers(index: object, manifests: dict[str, object], platforms: list[str]) -> dict[str, tuple[str, ...]]:
    """Platform -> manifest layers, refusing an index outside the expected set."""
    expected = set(platforms)
    if not expected or any(not PLATFORM.match(p) for p in expected):
        raise Refusal("the expected platform set is empty or unreadable")
    present = index_platforms(index)
    if set(present) != expected:
        raise Refusal(f"index platforms {sorted(present)} are not the expected {sorted(expected)}")
    layers = {}
    for platform, digest in present.items():
        if digest not in manifests:
            raise Refusal(f"manifest {digest} for {platform} was not read")
        layers[platform] = manifest_layers(manifests[digest])
    if len(set(layers.values())) != len(layers):
        raise Refusal("two platform manifests share one layer list")
    return layers


def verify(lines: list[str], digest: str, index: object, manifests: dict[str, object],
           platforms: list[str], builder: str | None = None) -> dict[str, int]:
    """Platform -> 1-based line of its one verified statement, or a Refusal."""
    digest = _digest(digest, "the index digest")
    layers = expected_layers(index, manifests, platforms)
    bound: dict[str, int] = {}
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        statement = parse_statement(line)
        if subject_digests(statement) != {digest}:
            raise Refusal(f"statement {number}: provenance subject is not exactly {digest}")
        predicate = check_predicate(statement.get("predicate"), builder)
        platform = bound_platform(predicate, layers)
        if platform in bound:
            raise Refusal(f"statement {number}: {platform} already has statement {bound[platform]}")
        bound[platform] = number
    missing = sorted(set(layers) - set(bound))
    if missing:
        raise Refusal(f"no verified SLSA v1 statement binds {missing}")
    return bound


def _load(path: str) -> object:
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def _manifests(directory: str) -> dict[str, object]:
    found = {}
    for path in sorted(Path(directory).glob("*.json")):
        found[_digest(f"sha256:{path.stem}", f"manifest file {path.name}")] = _load(str(path))
    if not found:
        raise Refusal(f"no platform manifests were read from {directory}")
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    pred = commands.add_parser("predicate", help="check one predicate before it is attested")
    pred.add_argument("--file", required=True)
    pred.add_argument("--builder", required=True)
    pred.add_argument("--platform", required=True)
    pred.add_argument("--index", required=True)
    pred.add_argument("--manifests", required=True)
    ver = commands.add_parser("verify", help="check the verified statements over the index digest")
    ver.add_argument("--digest", required=True)
    ver.add_argument("--index", required=True)
    ver.add_argument("--manifests", required=True)
    ver.add_argument("--statements", required=True)
    ver.add_argument("--platforms", required=True, help="comma-separated, e.g. linux/amd64,linux/arm64")
    ver.add_argument("--builder", default=None)
    args = parser.parse_args(argv)
    try:
        if args.command == "predicate":
            layers = expected_layers(_load(args.index), _manifests(args.manifests), [args.platform] + [
                p for p in index_platforms(_load(args.index)) if p != args.platform])
            predicate = check_predicate(_load(args.file), args.builder)
            platform = bound_platform(predicate, layers)
            if platform != args.platform:
                raise Refusal(f"the predicate binds {platform}, not {args.platform}")
            print(f"predicate binds {platform} and names this run")
            return 0
        bound = verify(Path(args.statements).read_text(encoding="utf-8").splitlines(), args.digest,
                       _load(args.index), _manifests(args.manifests), args.platforms.split(","), args.builder)
        print("verified one SLSA v1 provenance statement per platform over "
              f"{args.digest}: " + ", ".join(f"{p} (line {n})" for p, n in sorted(bound.items())))
        return 0
    except (Refusal, OSError, ValueError) as error:
        print(f"provenance contract: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
