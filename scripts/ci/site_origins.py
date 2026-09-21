"""The built site loads nothing from a third party, proven on the OUTPUT.

WHY THIS EXISTS. `mkdocs.yml`'s `theme.font: false` keeps Material's Google
Fonts stylesheet out of the generated pages, and a test asserted that setting.
A setting is not the output. A co-review built the site and found what the
setting does not cover: Material's own bundle carries two script injections to
`unpkg.com` -- a `ResizeObserver` polyfill fetched on every page view by any
browser that lacks the API, and a mermaid loader that is latent today and turns
itself on the day a page carries a diagram. Requirement 1 admits no CDN, so the
rule has to be about the bytes the site actually serves.

TWO MODES, and they are a pair.

  strip   rewrite the known third-party loads in the bundle into no-ops. Both
          sites have the same shape -- `? load("https://…") : nothing(void 0)`
          -- so the rewrite makes BOTH branches the already-available value the
          else branch names. The minified helper names are captured rather
          than written down, because a Material upgrade renames them.
  assert  walk every file under the built site and refuse any absolute URL a
          BROWSER WOULD LOAD whose origin is not this site's own or this
          repository's. It is the refusal, and it runs after `strip`, so a
          rewrite that stopped matching fails loudly instead of quietly.

WHAT IT JUDGES, and what it deliberately does not. A load is a fetch the page
makes for the reader: a `src`, a stylesheet or preconnect `link`, a CSS
`url()` or `@import`, and every absolute URL STRING LITERAL in JavaScript --
which is where the two injections live. An ANCHOR is not a load: a link a
reader may click hands their address to nobody until they do, and the
documentation links to the projects it names. `rel="canonical"` is this site's
own address by definition. A URL inside a comment is not a literal and is not
judged; the measured difference is decisive on the real bundle, where the
quoted-literal rule matches the two injections and nothing else, while a plain
text scan matches thirty licence banners.

Requirement 12: one START line, one line per refusal naming the file and the
origin, one SUMMARY with the decision.
"""

from __future__ import annotations

import argparse
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

# `.json` is NOT here, and that is measured rather than assumed: the only
# JSON the site serves is the search index, whose contents are this
# documentation's own prose. A URL inside it is a sentence a reader reads --
# `https://sync.example.org` out of the server guide -- and judging it would
# refuse the documentation for documenting.
JUDGED_SUFFIXES = (".html", ".js", ".css", ".svg", ".xml")
# A quoted absolute URL in JavaScript. The two injections are exactly this, and
# a URL mentioned in a licence banner is not.
JS_LITERAL = re.compile(r"""["'](?P<url>https?://[^"'\s]+)["']""")
# `src=`, `srcset=` and the `link` relations a browser fetches without being
# asked. `rel="canonical"` and an ordinary anchor are not here on purpose.
HTML_SRC = re.compile(r"""\b(?:src|srcset)\s*=\s*["'](?P<url>https?://[^"']+)["']""")
HTML_LINK = re.compile(
    r"""<link\b[^>]*\brel\s*=\s*["'](?P<rel>[^"']+)["'][^>]*>""", re.IGNORECASE
)
HTML_HREF = re.compile(r"""\bhref\s*=\s*["'](?P<url>https?://[^"']+)["']""")
LOADING_RELS = frozenset(
    {
        "stylesheet",
        "preconnect",
        "dns-prefetch",
        "preload",
        "prefetch",
        "modulepreload",
        "icon",
        "shortcut icon",
        "apple-touch-icon",
        "manifest",
    }
)
INLINE_SCRIPT = re.compile(r"<script\b[^>]*>(?P<body>.*?)</script>", re.IGNORECASE | re.DOTALL)
CSS_URL = re.compile(r"""url\(\s*["']?(?P<url>https?://[^"')\s]+)""")
CSS_IMPORT = re.compile(r"""@import\s+["'](?P<url>https?://[^"']+)["']""")
# `? load("https://…") : nothing(void 0)` -- the shape both injections take.
INJECTION = re.compile(
    r"""\?\s*[A-Za-z_$][\w$]*\(\s*["'](?P<url>https?://[^"']+)["']\s*\)\s*:\s*"""
    r"""(?P<available>[A-Za-z_$][\w$]*\(\s*void 0\s*\))"""
)


def site_origin() -> str:
    """This site's own origin, read from `mkdocs.yml`'s `site_url`."""
    for line in MKDOCS.read_text(encoding="utf-8").splitlines():
        if line.startswith("site_url:"):
            parts = urlsplit(line.split(":", 1)[1].strip())
            return f"{parts.scheme}://{parts.netloc}"
    raise SystemExit("site_origins: mkdocs.yml declares no site_url")


def allowed(url: str, own: str) -> bool:
    """Is this a URL the site may load?"""
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    if origin == own:
        return True
    return origin == REPOSITORY_ORIGIN and parts.path.startswith(REPOSITORY_PREFIX)


def refusals(path: Path, text: str, own: str) -> list[str]:
    """Every load in one file that reaches somewhere else."""
    found: list[str] = []

    def judge(url: str, how: str) -> None:
        if not allowed(url, own):
            found.append(f"{path}: {how} {url}")

    suffix = path.suffix.lower()
    if suffix == ".js":
        for match in JS_LITERAL.finditer(text):
            judge(match.group("url"), "a script loads")
    elif suffix == ".css":
        for pattern, how in ((CSS_URL, "a stylesheet loads"), (CSS_IMPORT, "a stylesheet imports")):
            for match in pattern.finditer(text):
                judge(match.group("url"), how)
    elif suffix in (".html", ".svg", ".xml"):
        for match in HTML_SRC.finditer(text):
            judge(match.group("url"), "a page loads")
        for match in HTML_LINK.finditer(text):
            tag = match.group(0)
            if match.group("rel").strip().lower() not in LOADING_RELS:
                continue
            for href in HTML_HREF.finditer(tag):
                judge(href.group("url"), f"a `{match.group('rel')}` link loads")
        for script in INLINE_SCRIPT.finditer(text):
            for match in JS_LITERAL.finditer(script.group("body")):
                judge(match.group("url"), "an inline script loads")
        for pattern, how in ((CSS_URL, "a style loads"), (CSS_IMPORT, "a style imports")):
            for match in pattern.finditer(text):
                judge(match.group("url"), how)
    return found


def files(site: Path) -> list[Path]:
    return sorted(
        path
        for path in site.rglob("*")
        if path.is_file() and path.suffix.lower() in JUDGED_SUFFIXES
    )


def strip(site: Path, own: str) -> int:
    """Rewrite third-party loads into the no-op their else branch already is."""
    rewritten = 0
    for path in files(site):
        if path.suffix.lower() != ".js":
            continue
        text = path.read_text(encoding="utf-8", errors="surrogateescape")

        def replace(match: re.Match[str]) -> str:
            nonlocal rewritten
            if allowed(match.group("url"), own):
                return match.group(0)
            rewritten += 1
            print(f"site-origins: stripped {match.group('url')} from {path}")
            available = match.group("available")
            return f"?{available}:{available}"

        replaced = INJECTION.sub(replace, text)
        if replaced != text:
            path.write_text(replaced, encoding="utf-8", errors="surrogateescape")
    return rewritten


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
        rewritten = strip(site, own)
        print(f"site-origins: SUMMARY mode=strip rewritten={rewritten} decision=done")
        return 0
    found: list[str] = []
    for path in judged:
        found.extend(
            refusals(path, path.read_text(encoding="utf-8", errors="surrogateescape"), own)
        )
    for line in found:
        print(f"site-origins: DENY {line}", file=sys.stderr)
    print(
        f"site-origins: SUMMARY mode=assert files={len(judged)} refusals={len(found)} "
        f"decision={'deny' if found else 'pass'}",
        file=sys.stderr if found else sys.stdout,
    )
    return 1 if found else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
