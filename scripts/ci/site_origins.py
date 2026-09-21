"""The built site loads nothing from a third party, proven on the OUTPUT.

WHY THIS EXISTS. `mkdocs.yml`'s `theme.font: false` keeps Material's Google
Fonts stylesheet out of the generated pages, and a test asserted that setting.
A setting is not the output. Material's own bundle carries loads the setting
does not cover: two script injections to a CDN -- a `ResizeObserver` polyfill
fetched on every page view by a browser that lacks the API, and a mermaid
loader that is latent today and turns itself on the day a page carries a
diagram -- and a repository-facts fetch to a second GitHub host. Requirement 1
admits no third-party runtime dependency, so the rule has to be about the bytes
the site actually serves.

TWO MODES, and they are a pair.

  strip   apply the PINNED rewrites below, each of which neutralises one known
          third-party load in the vendored bundle. Every rewrite must match at
          least once: a Material upgrade that renames or removes one fails the
          step rather than silently publishing an unstripped bundle.
  assert  walk the built site and refuse every URL that reaches an origin which
          is not this site's own or this repository's. It runs after `strip`,
          and it is the refusal -- `strip` is only the means.

WHAT IS JUDGED.

  HTML/SVG/XML  parsed with `html.parser`, so attribute case and quoting are
                the parser's problem rather than a regular expression's. Every
                `src`, `srcset`/`imagesrcset` candidate, `poster`, `data`,
                `action`, `formaction`, a `<meta http-equiv=refresh>` target,
                and every `href` EXCEPT an `<a>`/`<area>` one. Inline `<script>`
                bodies take the JavaScript rules, inline `<style>` bodies and
                `style=` attributes take the CSS rules.
  CSS           `url(...)` in every form (bare, single- or double-quoted) and
                `@import` in every form (`@import "x"`, `@import url(x)`, with
                or without a media query).
  JavaScript    every string and template literal, found by a lexer that knows
                comments and regular expressions, and judged if it contains a
                scheme or begins with `//`. A URL inside a COMMENT is not a
                load and is not judged -- the measured difference is decisive:
                on the real bundle the literal rule matches the injections and
                nothing else, while a plain text scan matches thirty licence
                banners. The lexer is backstopped: an absolute URL that lies
                outside every string AND every comment is refused as unparsed,
                so a lexer that loses its place fails closed.

WHAT IS NOT JUDGED, deliberately and by name.

  An ANCHOR is a navigation, not a load: a link hands the reader's address to
  nobody until the reader clicks it, and this documentation links to the
  projects it names. Anchors are COUNTED and the count is printed, so "no
  third-party load" is never read as "no third-party link".
  A `.json` file is not judged. The only JSON this site serves is the search
  index, whose content is this documentation's own prose; a URL inside it is a
  sentence a reader reads -- `https://sync.example.org` out of the server guide
  -- and judging it would refuse the documentation for documenting.
  A URL whose scheme names no host (`data:`, `mailto:`, `about:`, `blob:`,
  `tel:`, `obsidian:`) reaches no origin, and a relative URL reaches this site.

VACUOUS PASSES ARE REFUSED. An empty directory, or one missing the pages
MkDocs itself listed in `sitemap.xml`, or one carrying no stylesheet and no
script, cannot support the claim -- `assert` refuses it instead of passing.

Requirement 12: one START line, one line per refusal naming the file and the
origin, one SUMMARY with the decision.
"""

from __future__ import annotations

import argparse
import html.parser
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
MKDOCS = ROOT / "mkdocs.yml"
# The repository's own pages on GitHub: the nav links every root document
# there, because a document at the repository root is not inside `docs/`.
REPOSITORY_ORIGIN = "https://github.com"
REPOSITORY_PREFIX = "/snaraj/obsync"
JUDGED_SUFFIXES = (".html", ".js", ".css", ".svg", ".xml")
MARKUP_SUFFIXES = (".html", ".svg", ".xml")
# A built site with fewer pages than this is not this site; `assert` refuses
# it rather than reporting a pass nothing was judged for.
MIN_PAGES = 5

# Attributes a browser fetches from without being asked. `href` is judged too,
# and the `<a>`/`<area>` exemption is made in the parser where the tag is known.
URL_ATTRS = frozenset({"src", "poster", "data", "action", "formaction", "href"})
SRCSET_ATTRS = frozenset({"srcset", "imagesrcset"})
NAVIGATION_TAGS = frozenset({"a", "area"})
# `<meta http-equiv="refresh" content="0; url=https://…">`.
META_REFRESH_URL = re.compile(r"url\s*=\s*(?P<url>\S+)", re.IGNORECASE)

CSS_URL = re.compile(r"""url\(\s*(?P<q>["']?)(?P<url>[^"')]+)(?P=q)\s*\)""", re.IGNORECASE)
CSS_IMPORT = re.compile(
    r"""@import\s+(?:url\(\s*(?P<q1>["']?)(?P<u1>[^"')]+)(?P=q1)\s*\)|(?P<q2>["'])(?P<u2>[^"']+)(?P=q2))""",
    re.IGNORECASE,
)
# A URL with a scheme, anywhere in a file: the backstop that makes a lexer
# that loses its place fail closed rather than fall silent.
ABSOLUTE_URL = re.compile(r"""[A-Za-z][A-Za-z0-9+.\-]*://[^\s"'`<>)\]}]+""")
SCHEMELESS = re.compile(r"""\A//[^/\s]""")

IDENT = re.compile(r"[A-Za-z0-9_$]")


# --------------------------------------------------------------------------
# The pinned rewrites. Each one neutralises a named third-party load that the
# vendored Material bundle ships whatever `mkdocs.yml` says. Each MUST match.
# --------------------------------------------------------------------------

# `? load("https://…") : available(void 0)` -- the shape both script
# injections take. Both branches become the value the else branch already
# names; the minified helper name is captured rather than written down,
# because a Material upgrade renames it.
INJECTION = re.compile(
    r"""\?\s*[A-Za-z_$][\w$]*\(\s*["'](?P<url>https?://[^"']+)["']\s*\)\s*:\s*"""
    r"""(?P<available>[A-Za-z_$][\w$]*\(\s*void 0\s*\))"""
)
# Everything else is neutralised generically rather than by a growing list of
# special cases: any URL literal a vendored script carries to an origin this
# site may not reach is rewritten to `about:blank`, keeping any `${…}` tail so
# the literal stays a literal and the file stays parseable. `about:blank` names
# no host and no scheme a browser will fetch, so a request built out of one
# fails in the browser's own URL parsing -- which Material's `catchError`
# already handles -- and nothing leaves the machine.
NEUTRAL = "about:blank#"


def site_base() -> str:
    """This site's own address, read from `mkdocs.yml`'s `site_url`."""
    for line in MKDOCS.read_text(encoding="utf-8").splitlines():
        if line.startswith("site_url:"):
            return line.split(":", 1)[1].strip().rstrip("/") + "/"
    raise SystemExit("site_origins: mkdocs.yml declares no site_url")


def site_origin() -> str:
    """The origin of that address: scheme and host, which is what a load reaches."""
    parts = urlsplit(site_base())
    return f"{parts.scheme}://{parts.netloc}"


def allowed(url: str, own: str) -> bool:
    """Is this a URL the built site may carry?"""
    text = url.strip()
    if not text:
        return True
    if text.startswith("//") and not text.startswith("///"):
        # Protocol-relative: the browser supplies the page's own scheme, so
        # the host is the whole of the question.
        parts = urlsplit(f"https:{text}")
    else:
        parts = urlsplit(text)
        if not parts.scheme:
            return True  # relative: this site
        if parts.scheme.lower() not in ("http", "https"):
            return True  # names no host to reach
    host = parts.netloc.lower()
    if host == urlsplit(own).netloc.lower():
        return True
    if f"https://{host}" != REPOSITORY_ORIGIN:
        return False
    # The repository's own pages, and NOT a repository whose name merely
    # begins with this one's: `/snaraj/obsync-anything` is a different
    # repository and a prefix test would admit it.
    path = parts.path
    return path == REPOSITORY_PREFIX or path.startswith(f"{REPOSITORY_PREFIX}/")


def srcset_candidates(value: str) -> list[str]:
    """Every candidate in a `srcset`, not only the first."""
    out = []
    for candidate in value.split(","):
        url = candidate.strip().split()
        if url:
            out.append(url[0])
    return out


class Markup(html.parser.HTMLParser):
    """Every URL an HTML, SVG or XML document hands the browser to fetch.

    `html.parser` lowercases tag and attribute names, so `<IMG SRC=…>` and
    `<img src=…>` reach the same code by construction.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.loads: list[tuple[str, str]] = []
        self.navigations: list[str] = []
        self.styles: list[str] = []
        self.scripts: list[str] = []
        self._collect: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        mapping = {name.lower(): (value or "") for name, value in attrs}
        for name, value in mapping.items():
            if not value:
                continue
            if name in SRCSET_ATTRS:
                for candidate in srcset_candidates(value):
                    self.loads.append((candidate, f"a `{tag}` {name} candidate loads"))
            elif name in URL_ATTRS:
                if name == "href" and tag in NAVIGATION_TAGS:
                    self.navigations.append(value)
                else:
                    self.loads.append((value, f"a `{tag}` {name} loads"))
            elif name == "style":
                self.styles.append(value)
        if tag == "meta" and mapping.get("http-equiv", "").lower() == "refresh":
            found = META_REFRESH_URL.search(mapping.get("content", ""))
            if found:
                self.loads.append((found.group("url").strip("'\""), "a meta refresh sends the reader to"))
        if tag == "script" and "src" not in mapping:
            self._collect = "script"
        elif tag == "style":
            self._collect = "style"

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self._collect = None

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self._collect = None

    def handle_data(self, data: str) -> None:
        if self._collect == "script":
            self.scripts.append(data)
        elif self._collect == "style":
            self.styles.append(data)


def js_spans(text: str) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """(string spans, comment spans) of one JavaScript file.

    A hand-written lexer, because the question is exactly "is this URL a
    literal or a comment" and no regular expression answers it. Template
    literals are taken whole, substitutions included: a URL built out of
    `${…}` pieces is still a URL the file carries.
    """
    strings: list[tuple[int, int]] = []
    comments: list[tuple[int, int]] = []
    index, size, previous = 0, len(text), ""
    while index < size:
        char = text[index]
        if char in ("'", '"', "`"):
            start, index = index, index + 1
            while index < size:
                here = text[index]
                if here == "\\":
                    index += 2
                    continue
                if here == char:
                    break
                if here == "\n" and char != "`":
                    break  # an unterminated string: stop here, do not run on
                index += 1
            strings.append((start + 1, min(index, size)))
            index += 1
            previous = char
            continue
        if char == "/" and index + 1 < size:
            following = text[index + 1]
            if following == "/":
                end = text.find("\n", index)
                end = size if end < 0 else end
                comments.append((index, end))
                index = end
                continue
            if following == "*":
                end = text.find("*/", index + 2)
                end = size if end < 0 else end + 2
                comments.append((index, end))
                index = end
                continue
            if not (previous in ")]}" or IDENT.match(previous or " ")):
                # A regular expression literal: consume it, character class
                # and escapes included, so a `/` or a quote inside one cannot
                # put the lexer out of step.
                index += 1
                in_class = False
                while index < size:
                    here = text[index]
                    if here == "\\":
                        index += 2
                        continue
                    if here == "[":
                        in_class = True
                    elif here == "]":
                        in_class = False
                    elif here == "/" and not in_class:
                        break
                    elif here == "\n":
                        break
                    index += 1
                index += 1
                previous = "/"
                continue
        if not char.isspace():
            previous = char
        index += 1
    return strings, comments


def js_refusals(text: str, own: str, how: str) -> list[str]:
    """Every URL a JavaScript file carries in a literal, plus the backstop."""
    strings, comments = js_spans(text)
    found: list[str] = []
    for start, end in strings:
        literal = text[start:end]
        for url in ABSOLUTE_URL.findall(literal):
            if not allowed(url, own):
                found.append(f"{how} {url}")
        if SCHEMELESS.match(literal.strip()) and not allowed(literal.strip(), own):
            found.append(f"{how} {literal.strip()}")
    inside = strings + comments
    for match in ABSOLUTE_URL.finditer(text):
        if any(start <= match.start() < end for start, end in inside):
            continue
        if not allowed(match.group(0), own):
            found.append(f"an unparsed script URL reaches {match.group(0)}")
    return found


def css_refusals(text: str, own: str, how: str) -> list[str]:
    found = []
    for match in CSS_URL.finditer(text):
        url = match.group("url").strip()
        if not allowed(url, own):
            found.append(f"{how} loads {url}")
    for match in CSS_IMPORT.finditer(text):
        url = (match.group("u1") or match.group("u2") or "").strip()
        if not allowed(url, own):
            found.append(f"{how} imports {url}")
    return found


def refusals(path: Path, text: str, own: str) -> tuple[list[str], int]:
    """Every load in one file that reaches somewhere else, and its anchors."""
    found: list[str] = []
    navigations = 0
    suffix = path.suffix.lower()
    if suffix == ".js":
        found.extend(js_refusals(text, own, "a script loads"))
    elif suffix == ".css":
        found.extend(css_refusals(text, own, "a stylesheet"))
    elif suffix in MARKUP_SUFFIXES:
        parser = Markup()
        try:
            parser.feed(text)
            parser.close()
        except Exception as error:  # a document this parser cannot read is not a pass
            found.append(f"the markup could not be parsed ({error})")
            return [f"{path}: {line}" for line in found], 0
        navigations = len(parser.navigations)
        for url, how in parser.loads:
            if not allowed(url, own):
                found.append(f"{how} {url}")
        for style in parser.styles:
            found.extend(css_refusals(style, own, "a style"))
        for script in parser.scripts:
            found.extend(js_refusals(script, own, "an inline script loads"))
    return [f"{path}: {line}" for line in found], navigations


def files(site: Path) -> list[Path]:
    return sorted(
        path
        for path in site.rglob("*")
        if path.is_file() and path.suffix.lower() in JUDGED_SUFFIXES
    )


def substantial(site: Path, judged: list[Path], base: str) -> list[str]:
    """Refuse a directory too thin for the claim `assert` would otherwise make."""
    problems: list[str] = []
    sitemap = site / "sitemap.xml"
    if not sitemap.is_file():
        return [f"{site} carries no sitemap.xml, so it is not a built site"]
    locations = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sitemap.read_text(encoding="utf-8"))
    pages = [path for path in judged if path.suffix.lower() == ".html"]
    if len(locations) < MIN_PAGES:
        problems.append(f"sitemap.xml lists {len(locations)} pages, fewer than {MIN_PAGES}")
    for location in locations:
        rest = location[len(base) :] if location.startswith(base) else location
        rest = rest.strip("/")
        target = site / rest if rest.endswith(".html") else site / rest / "index.html"
        if not target.is_file():
            problems.append(f"sitemap.xml lists {location}, which the output does not carry")
    if len(pages) < len(locations):
        problems.append(
            f"{len(pages)} HTML files for {len(locations)} pages in sitemap.xml: the output is short"
        )
    if not any(path.suffix.lower() == ".css" for path in judged):
        problems.append("the output carries no stylesheet, so nothing was judged for one")
    if not any(path.suffix.lower() == ".js" for path in judged):
        problems.append("the output carries no script, so nothing was judged for one")
    return problems


def neutralise(url: str) -> str:
    """The same literal with its origin removed and its shape kept."""
    head = url.split("${", 1)[0]
    return NEUTRAL + url[len(head) :]


def strip(site: Path, own: str) -> tuple[int, int, list[str]]:
    """Neutralise every third-party URL the vendored scripts carry.

    Two layers, and the first is why the second cannot hide a theme change:

      1. the PINNED injection rewrite, which turns `? load(url) : available`
         into the value the else branch already names. It must match at least
         once; a Material upgrade that changes that shape fails this step
         instead of degrading a working feature into a broken fetch.
      2. every remaining URL literal whose origin is not allowed, rewritten to
         `about:blank`. It is mechanical and complete, so `assert` has nothing
         left to find in a script -- and a foreign origin in a PAGE or a
         STYLESHEET is never rewritten, because that is this documentation's
         own content and a refusal there is the right answer.
    """
    injections = 0
    neutralised = 0
    rewritten_files: list[str] = []

    for path in files(site):
        if path.suffix.lower() != ".js":
            continue
        text = original = path.read_text(encoding="utf-8", errors="surrogateescape")

        def injection(match: re.Match[str]) -> str:
            nonlocal injections
            if allowed(match.group("url"), own):
                return match.group(0)
            injections += 1
            print(f"site-origins: stripped the load of {match.group('url')} from {path}")
            available = match.group("available")
            return f"?{available}:{available}"

        text = INJECTION.sub(injection, text)

        # Layer 2 walks the literals the lexer found, rewriting from the end so
        # that earlier offsets stay valid.
        strings, _ = js_spans(text)
        edits: list[tuple[int, int, str]] = []
        for start, end in strings:
            literal = text[start:end]
            for match in ABSOLUTE_URL.finditer(literal):
                if allowed(match.group(0), own):
                    continue
                edits.append((start + match.start(), start + match.end(), neutralise(match.group(0))))
            stripped = literal.strip()
            if SCHEMELESS.match(stripped) and not allowed(stripped, own):
                offset = literal.index(stripped)
                edits.append((start + offset, start + offset + len(stripped), NEUTRAL))
        for begin, finish, replacement in sorted(edits, reverse=True):
            print(f"site-origins: neutralised {text[begin:finish]} in {path}")
            text = text[:begin] + replacement + text[finish:]
            neutralised += 1

        if text != original:
            path.write_text(text, encoding="utf-8", errors="surrogateescape")
            rewritten_files.append(str(path))

    missed = [] if injections else ["injection"]
    return injections, neutralised, missed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=("strip", "assert"))
    parser.add_argument("site", help="the built site directory")
    arguments = parser.parse_args(argv)
    site = Path(arguments.site)
    if not site.is_dir():
        print(f"site-origins: no built site at {site}", file=sys.stderr)
        return 2
    own = site_origin()
    judged = files(site)
    print(
        f"site-origins: START mode={arguments.mode} site={site} files={len(judged)} "
        f"own={own} also={REPOSITORY_ORIGIN}{REPOSITORY_PREFIX}"
    )
    if arguments.mode == "strip":
        injections, neutralised, missed = strip(site, own)
        if missed:
            for name in missed:
                print(
                    f"site-origins: DENY the pinned {name} rewrite matched nothing",
                    file=sys.stderr,
                )
            print(
                f"site-origins: SUMMARY mode=strip injections={injections} "
                f"neutralised={neutralised} unmatched={len(missed)} decision=deny",
                file=sys.stderr,
            )
            return 1
        print(
            f"site-origins: SUMMARY mode=strip injections={injections} "
            f"neutralised={neutralised} decision=done"
        )
        return 0

    found: list[str] = []
    navigations = 0
    found.extend(substantial(site, judged, site_base()))
    for path in judged:
        lines, anchors = refusals(
            path, path.read_text(encoding="utf-8", errors="surrogateescape"), own
        )
        found.extend(lines)
        navigations += anchors
    for line in found:
        print(f"site-origins: DENY {line}", file=sys.stderr)
    print(
        f"site-origins: SUMMARY mode=assert files={len(judged)} refusals={len(found)} "
        f"anchors={navigations} decision={'deny' if found else 'pass'}",
        file=sys.stderr if found else sys.stdout,
    )
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
