# Vendored: the BIP-0039 English wordlist

`english.txt` is the English wordlist defined by BIP-0039 ("Mnemonic code for
generating deterministic keys", Marek Palatinus, Pavol Rusnak, Aaron Voisine,
Sean Bowe, 2013), the same 2048 words every BIP-39 implementation uses. It is
data, not code: obsync ships it so a recovery phrase written down from one
device can be typed into any other BIP-39-aware tool, and so this plugin needs
no runtime dependency to show one.

- 2048 lines, LF-terminated, lowercase ASCII, sorted.
- SHA-256 of the file: `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`
  — the published checksum of the canonical `bip-0039/english.txt`. Verify
  with `shasum -a 256 plugin/vendor/bip39/english.txt`.

`plugin/src/wordlist.ts` is generated from this file so the bundle carries the
list without reading a data file at runtime; `plugin/test/pairing.test.mjs`
fails if the two disagree. Regenerate it with:

```sh
cd plugin && node -e '
const fs = require("node:fs");
const words = fs.readFileSync("vendor/bip39/english.txt", "utf8").split("\n").filter((w) => w !== "");
if (words.length !== 2048) throw new Error("expected 2048 words");
const lines = [];
for (let i = 0; i < words.length; i += 8) lines.push("  " + words.slice(i, i + 8).join(" "));
const head = fs.readFileSync("src/wordlist.ts", "utf8").split("export const")[0];
fs.writeFileSync("src/wordlist.ts", head + "export const WORDLIST: readonly string[] = `\n" + lines.join("\n") + "\n`\n  .trim()\n  .split(/\\s+/);\n");
'
```
