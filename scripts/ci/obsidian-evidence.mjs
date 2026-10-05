import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Only reduced custody facts and a verified synthetic editor may leave a renderer.
// These functions run inside Obsidian; never return credential values.
export async function secretFacts() {
  const raw = app.loadLocalStorage("secrets-encrypted");
  let plain = false;
  try { plain = typeof raw === "string" && typeof JSON.parse(raw) === "object"; } catch {}
  const plugin = app.plugins.plugins["obsync-private-sync"];
  const metadata = await plugin.loadData();
  const secret = app.secretStorage.getSecret(metadata.credentialRef);
  let envelope = null;
  try { envelope = secret === null ? null : JSON.parse(secret); }
  catch { throw new Error("credential envelope is not valid JSON"); }
  return {
    encrypted: app.secretStorage.isEncryptionAvailable(),
    backend: app.secretStorage.adapter?.getSelectedStorageBackend?.() ?? "none reported",
    stored: typeof raw === "string" && raw.length > 0,
    plain,
    revisionMatches: Number.isSafeInteger(metadata.credentialRevision)
      && metadata.credentialRevision > 0 && metadata.credentialRevision === envelope?.current?.revision,
  };
}

export function assertCustody(found, want) {
  if (!found.stored || !found.revisionMatches
      || Object.entries(want).some(([key, value]) => found[key] !== value)) {
    throw new Error("credential custody does not match the required encrypted storage and revision");
  }
}

// Capture the editor rectangle only. No settings, modal, recovery phrase,
// pairing code, notice, file list, profile path or other desktop surface.
export function editorBounds(file, text) {
  const visible = (node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  if ([...document.querySelectorAll(".modal-container, .notice-container .notice")].some(visible)) return null;
  const view = app.workspace.activeLeaf?.view;
  if (view?.file?.path !== file || view.editor?.getValue() !== text) return null;
  const editor = view.containerEl.querySelector(".markdown-source-view");
  if (!editor || !visible(editor)) return null;
  const rect = editor.getBoundingClientRect();
  if (rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function captureEditor(instance, phase, file, text, output, until) {
  if (!output) return;
  const main = await instance.main();
  await main.send("Page.bringToFront");
  const clip = await until("only the expected synthetic editor visible", () => main.run(editorBounds, file, text));
  const disk = fs.readFileSync(path.join(instance.vault, file));
  if (!disk.equals(Buffer.from(text))) throw new Error("capture refused: independent disk differs from editor");
  const { data } = await main.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
  const after = await main.run(editorBounds, file, text);
  if (JSON.stringify(after) !== JSON.stringify(clip)
      || !fs.readFileSync(path.join(instance.vault, file)).equals(disk)) {
    throw new Error("capture refused: editor or disk changed during capture");
  }
  const png = Buffer.from(data, "base64");
  const name = `${phase}-${instance.name}`;
  fs.writeFileSync(path.join(output, `${name}.png`), png, { flag: "wx" });
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify({
    phase, peer: instance.name, platform: process.platform,
    source: process.env.GITHUB_SHA ?? "local", editorSha256: digest(Buffer.from(text)), diskSha256: digest(disk),
    pngSha256: digest(png), width: clip.width, height: clip.height,
  }) + "\n", { flag: "wx" });
}

export function finishEvidence(output, custody) {
  if (!["before", "quit", "paired", "transferred", "after"].every((key) => custody?.[key] === true)) {
    throw new Error("incomplete native restart and custody evidence");
  }
  const expected = ["cotype-a", "cotype-b", "restart-a-a", "restart-a-b", "restart-b-a", "restart-b-b"];
  const names = expected.flatMap((name) => [name + ".png", name + ".json"]).sort();
  if (JSON.stringify(fs.readdirSync(output).sort()) !== JSON.stringify(names)) {
    throw new Error("expected exactly six editor images and their receipts");
  }
  for (const name of expected) {
    const receipt = JSON.parse(fs.readFileSync(path.join(output, name + ".json"), "utf8"));
    if (receipt.editorSha256 !== receipt.diskSha256
        || receipt.pngSha256 !== digest(fs.readFileSync(path.join(output, name + ".png")))) {
      throw new Error("capture receipt does not match its editor, disk and image");
    }
  }
}
