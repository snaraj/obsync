# Obsidian API declarations

`obsidian.d.ts` and `LICENSE.md` are unmodified files from the official
[`obsidian` 1.7.2 package](https://registry.npmjs.org/obsidian/-/obsidian-1.7.2.tgz).
The package's repository is [obsidianmd/obsidian-api](https://github.com/obsidianmd/obsidian-api).

- Package SHA-512 integrity: `sha512-k9hN9brdknJC+afKr5FQzDRuEFGDKbDjfCazJwpgibwCAoZNYHYV8p/s3mM8I6AsnKrPKNXf8xGuMZ4enWelZQ==`
- Declaration SHA-256: `422eb0b21da5c69aef689cbfc643f2b953b5b31537328e01022490a3944b5830`

`VERSION` and the root manifest's `minAppVersion` name this same baseline.
The plugin compiles against it without downloading an API dependency. Newer
Obsidian APIs require a deliberate baseline and minimum-version update.
`plugin/test/api-compatibility.test.mjs` checks the official declaration bytes
and uses the real compiler to accept a supported API and reject a newer one.
