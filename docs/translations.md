# Translations

The README and the Cloudflare guide exist in twenty languages besides
English, under `docs/<code>/` with the same file names as the English pages:
`docs/<code>/README.md` mirrors the root `README.md`, and
`docs/<code>/cloudflare.md` mirrors `docs/cloudflare.md`. The language line at
the top of the README links to every one of them.

**The English text is canonical.** Translations follow it and are refreshed
when it changes; a translation that is behind is a translation to refresh, not
a second source of truth. Every translated file says so on its first line and
links back to the English page.

What stays identical in every language: every fenced command block, every
command, flag, URL and placeholder inside one, and the image files. Prose,
headings, table text and image alternative text are translated. Obsidian's own
menu and button names are written as Obsidian localises them where that could
be checked against Obsidian's published translations; where it could not, the
English name stays in quotes.

`scripts/ci/test_translation_contract.py` holds the shape: each translation
carries the canonical line, its fenced blocks equal the English ones byte for
byte and in the same order, every relative link and image it carries resolves,
and the README's language line names exactly the directories that exist.

| Code | Language |
| --- | --- |
| `ar` | العربية |
| `de` | Deutsch |
| `es` | Español |
| `fa` | فارسی |
| `fr` | Français |
| `id` | Bahasa Indonesia |
| `it` | Italiano |
| `nl` | Nederlands |
| `pl` | Polski |
| `pt` | Português |
| `pt-br` | Português (Brasil) |
| `ru` | Русский |
| `th` | ไทย |
| `tr` | Türkçe |
| `uk` | Українська |
| `vi` | Tiếng Việt |
| `ja` | 日本語 |
| `ko` | 한국어 |
| `zh-cn` | 中文简体 |
| `zh-tw` | 中文繁體 |

Requirement 11 applies in every language: placeholder hosts only, no address,
identifier, code or token, in prose or in a picture.
