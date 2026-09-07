"""A deliberately small, fail-closed YAML reader for the repository gates.

WHY THIS EXISTS. Two gates have to read structured documents: the chart pins
read what `helm template` actually rendered, and the workflow-integrity gate
reads `.github/workflows/`. Both decisions are security decisions, so neither
may be made with `grep`: a second NetworkPolicy written in flow style, or a
`permissions:` block hidden under a shape a line scan does not model, is
exactly the render a counted-lines gate reports as clean. Requirement 5 forbids
a third-party dependency, so PyYAML is not available and this module is the
answer.

WHAT MAKES IT SAFE DESPITE BEING SMALL. It refuses everything it does not
fully model, and a refusal is a gate failure, never a pass. Anchors, aliases,
tags, merge keys, multi-line plain scalars, nested flow collections, tabs and
duplicate keys all raise `YamlError`. So the failure direction for an
unmodelled construct is red, and widening what it accepts is a reviewed edit to
this file rather than something an author can do from a workflow.

WHAT IT MODELS: multiple documents, block mappings, block sequences (including
the compact `- key: value` form), plain and quoted scalars, literal and folded
block scalars (`|`, `|-`, `>`, `>-`, captured RAW so a `run:` body can never be
read as structure), single-level flow sequences and flow mappings, comments,
and the null/bool/int scalar resolutions GitHub Actions and Helm actually use.
"""

from __future__ import annotations

import re
from typing import Any


class YamlError(ValueError):
    """Raised for any construct this reader will not resolve."""


_KEY_RE = re.compile(r"^(?P<key>\"[^\"]*\"|'[^']*'|[^:#\s][^:]*?)\s*:(?:\s+(?P<value>.*))?$")
_BLOCK_SCALAR_RE = re.compile(r"^[|>][+-]?$")
_INT_RE = re.compile(r"^[+-]?[0-9]+$")
_REFUSED_PREFIXES = ("&", "*", "!", "?", "<<")


def loads(text: str) -> list[Any]:
    """Return every document in `text`, or raise `YamlError`."""
    documents: list[Any] = []
    for chunk in _split_documents(text):
        lines = _significant_lines(chunk)
        start = _next(lines, 0)
        if start >= len(lines):
            continue
        value, index = _parse_block(lines, start, lines[start][0])
        if _next(lines, index) != len(lines):
            raise YamlError(f"unconsumed content at line {lines[_next(lines, index)][2]}")
        documents.append(value)
    return documents


def load_one(text: str) -> Any:
    """Return the single document in `text`, or raise `YamlError`."""
    documents = loads(text)
    if len(documents) != 1:
        raise YamlError(f"expected exactly one document, found {len(documents)}")
    return documents[0]


def _split_documents(text: str) -> list[str]:
    chunks: list[list[str]] = [[]]
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped == "---":
            chunks.append([])
            continue
        if stripped == "...":
            continue
        chunks[-1].append(raw)
    return ["\n".join(chunk) for chunk in chunks]


def _significant_lines(chunk: str) -> list[tuple[int, str, int]]:
    """Return (indent, content, line-number) for every non-blank, non-comment line.

    Block scalars are folded into their owning line by `_parse_block`, so this
    pass keeps every raw line and lets the parser claim the ones it owns.
    """
    lines: list[tuple[int, str, int]] = []
    for number, raw in enumerate(chunk.splitlines(), start=1):
        if "\t" in raw[: len(raw) - len(raw.lstrip("\t "))]:
            raise YamlError(f"line {number} is indented with a tab")
        content = raw.rstrip()
        if not content.strip() or content.lstrip().startswith("#"):
            lines.append((-1, "", number))
            continue
        lines.append((len(content) - len(content.lstrip(" ")), content.lstrip(" "), number))
    return lines


def _next(lines: list[tuple[int, str, int]], index: int) -> int:
    while index < len(lines) and lines[index][0] == -1:
        index += 1
    return index


def _parse_block(lines: list[tuple[int, str, int]], index: int, indent: int) -> tuple[Any, int]:
    index = _next(lines, index)
    if index >= len(lines) or lines[index][0] < indent:
        return None, index
    if lines[index][1].startswith("- ") or lines[index][1] == "-":
        return _parse_sequence(lines, index, indent)
    return _parse_mapping(lines, index, indent)


def _parse_mapping(lines: list[tuple[int, str, int]], index: int, indent: int) -> tuple[dict, int]:
    mapping: dict[str, Any] = {}
    while True:
        index = _next(lines, index)
        if index >= len(lines):
            break
        line_indent, content, number = lines[index]
        if line_indent < indent:
            break
        if line_indent > indent:
            raise YamlError(f"line {number} is over-indented inside a mapping")
        match = _KEY_RE.match(content)
        if not match:
            raise YamlError(f"line {number} is not a mapping entry: {content!r}")
        key = _scalar(match.group("key"), number)
        if not isinstance(key, str):
            raise YamlError(f"line {number} has a non-string mapping key")
        if key in mapping:
            raise YamlError(f"line {number} duplicates mapping key {key!r}")
        raw_value = match.group("value")
        value, index = _parse_value(lines, index, indent, raw_value, number)
        mapping[key] = value
    return mapping, index


def _parse_sequence(lines: list[tuple[int, str, int]], index: int, indent: int) -> tuple[list, int]:
    items: list[Any] = []
    while True:
        index = _next(lines, index)
        if index >= len(lines):
            break
        line_indent, content, number = lines[index]
        if line_indent < indent or not (content.startswith("- ") or content == "-"):
            break
        if line_indent > indent:
            raise YamlError(f"line {number} is over-indented inside a sequence")
        rest = content[2:].strip() if content.startswith("- ") else ""
        if not rest:
            index += 1
            nested = _next(lines, index)
            if nested >= len(lines) or lines[nested][0] <= indent:
                items.append(None)
                index = nested
                continue
            value, index = _parse_block(lines, nested, lines[nested][0])
            items.append(value)
            continue
        # A compact `- key: value` item opens a mapping whose indent is the
        # column the key actually starts at, so its sibling keys line up under
        # it rather than under the dash.
        match = _KEY_RE.match(rest)
        if match:
            child_indent = line_indent + 2
            lines[index] = (child_indent, rest, number)
            value, index = _parse_mapping(lines, index, child_indent)
            items.append(value)
            continue
        items.append(_scalar(rest, number))
        index += 1
    return items, index


def _parse_value(
    lines: list[tuple[int, str, int]], index: int, indent: int, raw: str | None, number: int
) -> tuple[Any, int]:
    if raw is None or not raw.strip():
        index += 1
        nested = _next(lines, index)
        if nested < len(lines) and lines[nested][0] > indent:
            return _parse_block(lines, nested, lines[nested][0])
        return None, index
    raw = raw.strip()
    if _BLOCK_SCALAR_RE.match(raw):
        return _parse_block_scalar(lines, index, indent)
    return _scalar(raw, number), index + 1


def _parse_block_scalar(
    lines: list[tuple[int, str, int]], index: int, indent: int
) -> tuple[str, int]:
    """Capture a `|`/`>` body RAW.

    The body is returned as text and never re-read as structure. That is the
    point: a `run:` block full of YAML-shaped shell must not be able to declare
    a job, a permission, or a peer.
    """
    index += 1
    body: list[str] = []
    while index < len(lines):
        line_indent, content = lines[index][0], lines[index][1]
        if line_indent == -1:
            body.append("")
            index += 1
            continue
        if line_indent <= indent:
            break
        body.append(" " * line_indent + content)
        index += 1
    while body and not body[-1]:
        body.pop()
    return "\n".join(body), index


def _strip_comment(raw: str) -> str:
    out: list[str] = []
    quote: str | None = None
    for position, character in enumerate(raw):
        if quote:
            out.append(character)
            if character == quote:
                quote = None
            continue
        if character in "\"'":
            quote = character
            out.append(character)
            continue
        if character == "#" and (position == 0 or raw[position - 1] in " \t"):
            break
        out.append(character)
    return "".join(out).strip()


def _scalar(raw: str, number: int) -> Any:
    raw = _strip_comment(raw)
    if not raw:
        return None
    if raw.startswith(_REFUSED_PREFIXES):
        raise YamlError(f"line {number} uses an anchor, alias, tag, or merge key")
    if raw[0] == '"' and raw[-1] == '"' and len(raw) >= 2:
        return _unescape(raw[1:-1], number)
    if raw[0] == "'" and raw[-1] == "'" and len(raw) >= 2:
        return raw[1:-1].replace("''", "'")
    if raw[0] == "[":
        return _flow_sequence(raw, number)
    if raw[0] == "{":
        return _flow_mapping(raw, number)
    if raw in {"null", "~"}:
        return None
    if raw in {"true", "True"}:
        return True
    if raw in {"false", "False"}:
        return False
    if _INT_RE.match(raw):
        return int(raw)
    if raw.endswith(":") or ": " in raw:
        raise YamlError(f"line {number} is an unresolvable plain scalar: {raw!r}")
    return raw


def _unescape(raw: str, number: int) -> str:
    out: list[str] = []
    index = 0
    while index < len(raw):
        character = raw[index]
        if character != "\\":
            out.append(character)
            index += 1
            continue
        if index + 1 >= len(raw):
            raise YamlError(f"line {number} ends inside a string escape")
        following = raw[index + 1]
        mapped = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "/": "/"}.get(following)
        if mapped is None:
            raise YamlError(f"line {number} uses an unmodelled string escape \\{following}")
        out.append(mapped)
        index += 2
    return "".join(out)


def _flow_members(raw: str, closer: str, number: int) -> list[str]:
    if not raw.endswith(closer):
        raise YamlError(f"line {number} has an unterminated flow collection")
    inner = raw[1:-1].strip()
    if not inner:
        return []
    if any(character in inner for character in "[]{}"):
        raise YamlError(f"line {number} nests flow collections, which this reader refuses")
    members: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for character in inner:
        if quote:
            current.append(character)
            if character == quote:
                quote = None
            continue
        if character in "\"'":
            quote = character
            current.append(character)
            continue
        if character == ",":
            members.append("".join(current).strip())
            current = []
            continue
        current.append(character)
    if quote:
        raise YamlError(f"line {number} has an unterminated quoted flow member")
    members.append("".join(current).strip())
    if any(not member for member in members):
        raise YamlError(f"line {number} has an empty flow member")
    return members


def _flow_sequence(raw: str, number: int) -> list[Any]:
    return [_scalar(member, number) for member in _flow_members(raw, "]", number)]


def _flow_mapping(raw: str, number: int) -> dict[str, Any]:
    mapping: dict[str, Any] = {}
    for member in _flow_members(raw, "}", number):
        key, separator, value = member.partition(":")
        if not separator:
            raise YamlError(f"line {number} has a flow mapping member with no value")
        resolved = _scalar(key.strip(), number)
        if not isinstance(resolved, str):
            raise YamlError(f"line {number} has a non-string flow mapping key")
        if resolved in mapping:
            raise YamlError(f"line {number} duplicates flow mapping key {resolved!r}")
        mapping[resolved] = _scalar(value.strip(), number)
    return mapping
