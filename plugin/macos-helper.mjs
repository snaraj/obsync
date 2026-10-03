/** One fixed source, embedded in the plugin and shared CLI package. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
export async function macosHelperModule() {
  const source = await readFile(new URL("./macos-acl.js", import.meta.url), "utf8");
  if (source.length > 8192 || /[^\x00-\x7f]/.test(source)) throw Error("macos_helper_source");
  const sha256 = createHash("sha256").update(source).digest("hex");
  return `exports.source=${JSON.stringify(source)};\nexports.sha256=${JSON.stringify(sha256)};\n`;
}
