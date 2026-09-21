"""Hand CI the exact text a documentation page shows, or refuse.

WHY THIS EXISTS. A self-hosting guide is a set of commands a stranger pastes
into a terminal. The only way that text can be trusted is for CI to run THAT
text -- not a copy of it kept beside it, which is a copy that drifts, and
drifts silently, because nothing in a repository compares prose with a shell
script. `scripts/ci/test_onboarding_contract.py` already proves the SHAPE of
those commands (digest-only runs, both cosign flags, the tokenless token
read). This module closes the other half: the commands the end-to-end
workflows run are READ OUT OF THE PAGE at the commit under test, so a page
edited without its gate fails the build on the next run.

HOW A BLOCK IS NAMED. One HTML comment on the line immediately above a fenced
block:

    <!-- ci: compose-up -->
    ```sh
    …
    ```

The comment renders as nothing on the site and on GitHub, so the page a reader
sees is unchanged. A name may appear at most once per document: two blocks with
one name is a document that cannot say which one CI runs, and that is a
refusal rather than a first-match.

SUBSTITUTIONS, DECLARED AND CHECKED. A guide is written for a reader's own
deployment, so it carries values only that reader can supply -- a digest, a
hostname, an address. CI states each one on the command line:

    --substitute '<what the page shows>=<what this run uses>'

Every left-hand side must be PRESENT in the block, which is what makes a
silent doc edit fail here instead of later: rename the placeholder and the
substitution no longer matches, so the run refuses by name. And after every
substitution has been applied the result may hold no `<placeholder>` at all,
because a placeholder that survived is a command nobody could run.

WHAT IT DOES NOT DO. It does not execute anything and it does not judge what a
command means. The caller decides what to run; the onboarding contract decides
what a documented command may contain.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

MARKER = re.compile(r"^<!--\s*ci:\s*(?P<name>[a-z0-9][a-z0-9-]*)\s*-->$")
FENCE = re.compile(r"^```(?P<language>[A-Za-z0-9+-]*)\s*$")
# A placeholder the reader is expected to replace. Deliberately narrow: an
# angle-bracketed run of non-space characters, which is how every guide in this
# repository writes one (`<digest>`, `<the path that PersistentVolume names>`
# is prose and is never inside a block CI runs).
PLACEHOLDER = re.compile(r"<[^<>\s][^<>]*>")


class BlockError(ValueError):
    """Raised for every refusal this module makes. Never a silent fallback."""


def blocks(text: str) -> dict[str, tuple[str, str]]:
    """Every named block in one document, as `{name: (language, body)}`."""
    found: dict[str, tuple[str, str]] = {}
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        marker = MARKER.match(lines[index].strip())
        if marker is None:
            index += 1
            continue
        name = marker.group("name")
        if index + 1 >= len(lines):
            raise BlockError(f"`ci: {name}` marks nothing: the document ends after it")
        fence = FENCE.match(lines[index + 1])
        if fence is None:
            raise BlockError(
                f"`ci: {name}` is not immediately followed by a fenced block: "
                f"{lines[index + 1]!r}"
            )
        body: list[str] = []
        cursor = index + 2
        while cursor < len(lines) and not lines[cursor].startswith("```"):
            body.append(lines[cursor])
            cursor += 1
        if cursor >= len(lines):
            raise BlockError(f"`ci: {name}` opens a fenced block that is never closed")
        if name in found:
            raise BlockError(
                f"`ci: {name}` marks two blocks; a name must say which text CI runs"
            )
        found[name] = (fence.group("language"), "\n".join(body))
        index = cursor + 1
    return found


def extract(text: str, name: str, substitutions: list[tuple[str, str]]) -> str:
    """One named block with every declared substitution applied, or raise."""
    found = blocks(text)
    if name not in found:
        raise BlockError(
            f"no `<!-- ci: {name} -->` block; this document names "
            f"{', '.join(sorted(found)) or 'nothing'}"
        )
    body = found[name][1]
    for shown, used in substitutions:
        if shown not in body:
            raise BlockError(
                f"block {name!r} does not show {shown!r}, so this run would "
                "substitute nothing: the page and this gate disagree"
            )
        body = body.replace(shown, used)
    surviving = PLACEHOLDER.search(body)
    if surviving is not None:
        raise BlockError(
            f"block {name!r} still holds the placeholder {surviving.group(0)!r} "
            "after every declared substitution: that is a command nobody can run"
        )
    return body


def _substitution(raw: str) -> tuple[str, str]:
    shown, separator, used = raw.partition("=")
    if not separator or not shown:
        raise argparse.ArgumentTypeError(
            f"--substitute takes `<shown>=<used>`, not {raw!r}"
        )
    return shown, used


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("document", help="path to the markdown page, from the repository root")
    parser.add_argument("name", help="the `<!-- ci: name -->` block to print")
    parser.add_argument(
        "--substitute",
        action="append",
        default=[],
        type=_substitution,
        metavar="SHOWN=USED",
        help="replace text the page shows with what this run uses; repeatable",
    )
    arguments = parser.parse_args(argv)
    path = ROOT / arguments.document
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        print(f"docs_blocks: cannot read {arguments.document}: {error}", file=sys.stderr)
        return 2
    try:
        print(extract(text, arguments.name, arguments.substitute))
    except BlockError as error:
        print(f"docs_blocks: {arguments.document}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
