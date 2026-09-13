# Obsidian API declarations

`obsidian.d.ts` and `LICENSE.md` are unmodified files from the official
[`obsidian` 1.12.3 package](https://registry.npmjs.org/obsidian/-/obsidian-1.12.3.tgz).
The package's repository is [obsidianmd/obsidian-api](https://github.com/obsidianmd/obsidian-api).

- Package SHA-512 integrity: `sha512-HxWqe763dOqzXjnNiHmAJTRERN8KILBSqxDSEqbeSr7W8R8Jxezzbca+nz1LiiqXnMpM8lV2jzAezw3CZ4xNUw==`
- Declaration SHA-256: `8dc0a334e2e927b7512f9d21be2a8d1934128cc7d3e2ce7d48164fe951f9e81e`
- License SHA-256: `c7e9eeb6640ebb1c22d8888f6d2c771b1f058a54e6216d69c7e2224b3cbad394`

`VERSION` pins the API package separately from the root manifest's
`minAppVersion` of 1.12.4. The public SecretStorage API is present in this
package; the [1.12.4 app release](https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/)
includes handling for unavailable encryption on some Linux machines.
The plugin compiles without downloading an API dependency. Changes to either
baseline require a deliberate update; availability and persistence still need
native platform validation.
`plugin/test/api-compatibility.test.mjs` checks the official declaration bytes
and uses the real compiler to accept supported get/set operations and reject
an undeclared secret operation.
