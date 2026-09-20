# Obsidian API declarations

`node_modules/obsidian/obsidian.d.ts` and `node_modules/obsidian/LICENSE.md`
are unmodified files from the official
[`obsidian` 1.13.0 package](https://registry.npmjs.org/obsidian/-/obsidian-1.13.0.tgz).
The package's repository is [obsidianmd/obsidian-api](https://github.com/obsidianmd/obsidian-api).

- Package SHA-512 integrity: `sha512-PHw5+SAPlJ0S3leFvJ0wgFg63Z3DavxL6+d1ll+8toXR2ZlYKc1rMWqdUv9LgUbTwPQUyY6yfhOMMivampRRiQ==`
- Declaration SHA-256: `13827948460423b67bdd551091c516f25b72f19c3c9042dd774528dc0d37b965`
- License SHA-256: `c7e9eeb6640ebb1c22d8888f6d2c771b1f058a54e6216d69c7e2224b3cbad394`

The two files sit under a directory named `node_modules` because that is the
one name every JavaScript linter skips by default. The community directory's
scorecard lints every `.ts` file in the repository with rules written for
plugin code and does not read a repository's own ignore list, so the upstream
declaration -- which uses `any` on purpose -- was 190 of its 216 findings.
Nothing is installed here: `plugin/tsconfig.json` maps `obsidian` to this path
and the plugin compiles without downloading an API dependency.

`VERSION` is exactly the root manifest's `minAppVersion`, and that is the
floor guard: the compiler knows no member the floor lacks, so a call to one
is a build error rather than a runtime failure on an older app.
`plugin/test/api-compatibility.test.mjs` pins the pair, checks the
declaration bytes, and uses the real compiler to accept supported operations
and reject one from the next API release. Raising either baseline is a
deliberate update to both, recorded in root `versions.json` as a new floor;
availability and persistence still need native platform validation.
