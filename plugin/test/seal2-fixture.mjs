/** Position-dedup fixtures must differ in metadata, rather than rely on random ciphertext. */
import { createRequire } from "node:module";
import { openPublishedManifest } from "./fake.mjs";
const require = createRequire(import.meta.url), c = require("../build/crypto.js"), s = require("../build/seal2.js");
export async function withDistinctMtime(fileId, post, manifestKey, scope) {
  const manifest = await openPublishedManifest({ ...post, file_id: fileId }, manifestKey, scope.generation, scope.domainId);
  const packet = await s.sealRecord(manifestKey, 1, { ...scope, fileId, parents: post.parents, sids: post.sids }, c.utf8(JSON.stringify({ ...manifest, mtime: manifest.mtime + 1 })));
  return { ...post, manifest_ct: c.base64(packet), version_id: await c.versionId(fileId, post.parents, packet, post.sids) };
}
