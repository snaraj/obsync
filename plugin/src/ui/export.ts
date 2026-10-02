/** Explicit export actions. No export work runs on the normal sync path. */
import { App, Modal, Platform, Setting } from "obsidian";
import type ObsyncPlugin from "../main";
import { unhex } from "../crypto";
import { DesktopExports } from "../exportDesktop";
import { ExportError, EXPORT_WORK_MS, exportBudget, selectExport } from "../export";
import { entropyFromPhrase, normalisePhrase } from "../pairing";
import { isPushed } from "../state";
import { forward, literal } from "./modals";

const running = new WeakSet<ObsyncPlugin>();
export class ExportModal extends Modal {
  private mode: "encrypted" | "open" | "plain" = "encrypted";
  private output = "";
  private input = "";
  private history = false;
  private phrase = "";
  private allowServer = false;
  private plainConfirmed = false;
  private busy = false;
  private closed = true;
  private message = "";
  private pending: string[] = [];
  constructor(app: App, private readonly plugin: ObsyncPlugin) { super(app); }
  override onOpen(): void { this.closed = false; this.setTitle("Export and open a copy"); this.render(); }
  isShown(): boolean { return !this.closed; }
  forward(): void { forward(this, () => this.render()); }
  private render(): void {
    if (this.closed) return;
    const el = this.contentEl; el.empty();
    if (!Platform.isDesktopApp || Platform.isWin) {
      el.createEl("p", { text: "Export is currently available on macOS and Linux. This device does not yet have a verified way to publish a private export outside the vault. Nothing is written into this vault." });
      new Setting(el).addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
      return;
    }
    new Setting(el).setName("Action").addDropdown((dropdown) => dropdown.addOption("encrypted", "Export encrypted copy")
      .addOption("open", "Open an export offline").addOption("plain", "Export local plain notes").setValue(this.mode).setDisabled(this.busy)
      .onChange((value) => { this.mode = value as typeof this.mode; this.plainConfirmed = false; this.pending = []; this.render(); }));
    el.createEl("p", { text: this.mode === "encrypted"
      ? "Copy the server's current notes, including every conflicting version. Names and contents remain encrypted. Local edits not yet uploaded are not included."
      : this.mode === "open"
        ? "Open a copy without contacting a server. The new folder will contain unencrypted notes. Conflicting versions and requested history get separate folders."
        : "Copy visible files currently on this device's disk. This includes files outside the sync selection and excludes hidden folders. Linked files cause a refusal. Unsaved editor text and notes not yet downloaded are not included." });
    if (this.mode === "open") {
      new Setting(el).setName("Archive file").addText((text) => text.setPlaceholder("Absolute path to a .obsync file").setValue(this.input).setDisabled(this.busy).onChange((v) => { this.input = v; }));
      new Setting(el).setName("Recovery phrase").setDesc("Leave blank to use this device's vault key. The phrase stays on this device and is cleared after the attempt.")
        .addText((text) => { text.inputEl.type = "password"; literal(text.inputEl); text.setValue(this.phrase).setDisabled(this.busy).onChange((v) => { this.phrase = v; }); });
      new Setting(el).setName("This copy came from the server").setDesc("Only enable for an obsyncd export. Its contents are authenticated when opened, but no device authenticated which files and versions were included. Missing or stale notes cannot be detected.")
        .addToggle((toggle) => toggle.setValue(this.allowServer).setDisabled(this.busy).onChange((v) => { this.allowServer = v; }));
    }
    new Setting(el).setName(this.mode === "encrypted" ? "New archive file" : "New output folder")
      .setDesc("Enter an absolute path outside every vault. The destination must not exist.")
      .addText((text) => text.setValue(this.output).setDisabled(this.busy).onChange((v) => { this.output = v; }));
    if (this.mode === "encrypted") new Setting(el).setName("Include retained history").setDesc("Off by default. This increases the copy's size; it is not a server backup.")
      .addToggle((toggle) => toggle.setValue(this.history).setDisabled(this.busy).onChange((v) => { this.history = v; }));
    else new Setting(el).setName("I understand these notes will be unencrypted").addToggle((toggle) => toggle.setValue(this.plainConfirmed).setDisabled(this.busy).onChange((v) => { this.plainConfirmed = v; }));
    el.createEl("p", { text: "Each attempt is limited to 100,000 selected versions, 64 MiB of metadata, 64 GiB of output, and 30 minutes. Close cancels before publication; a disk call already underway must finish." });
    if (this.message) el.createEl("p", { text: this.message });
    if (this.pending.length) {
      el.createEl("p", { text: "Known unfinished sync at the start of this copy (server changes not yet received may also exist):" });
      const list = el.createEl("ul"); for (const entry of this.pending) list.createEl("li", { text: entry });
    }
    new Setting(el).addButton((button) => button.setButtonText(this.busy ? "Working…" : "Create copy").setDisabled(this.busy).onClick(() => { void this.run(); }))
      .addButton((button) => button.setButtonText(this.busy ? "Cancel and close" : "Close").onClick(() => this.close()));
  }
  private async run(): Promise<void> {
    if (this.busy || running.has(this.plugin)) return;
    const started = Date.now();
    let decision = "refused", reason = "local_or_integrity";
    this.busy = true; running.add(this.plugin); this.message = "Checking the source and destination…"; this.render();
    try {
      if (!this.output.trim() || (this.mode === "open" && !this.input.trim())) throw new ExportError("choose_destination");
      if (this.mode !== "encrypted" && !this.plainConfirmed) throw new ExportError("confirm_plaintext");
      const session = this.plugin.captureSession(), adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
      if (!Platform.isDesktopApp || typeof adapter.getBasePath !== "function") throw new ExportError("external_folder_unavailable");
      const desktop = new DesktopExports(adapter.getBasePath(), this.app.vault.configDir);
      const check = exportBudget(() => { session.assertCurrent(); if (this.closed) throw new ExportError("cancelled"); });
      if (this.mode === "encrypted") {
        if (!session.state.paired || !session.state.data.vrk) throw new ExportError("paired_device_required");
        const index = await selectExport(session.transport, this.history, check);
        await desktop.encrypted(this.output, index, unhex(session.state.data.vrk), (sid) => session.transport.getChunk(sid, undefined, { interactive: true }), check);
        this.message = "Encrypted copy created. Keep the recovery phrase separately.";
      } else if (this.mode === "open") {
        const key = this.phrase.trim() ? await entropyFromPhrase(normalisePhrase(this.phrase)) : session.state.data.vrk ? unhex(session.state.data.vrk) : null;
        this.phrase = "";
        if (!key) throw new ExportError("vault_key_required");
        const result = await desktop.open(this.input, this.output, key, this.allowServer, check);
        this.message = `Opened ${result.files} files in the new folder. They are unencrypted and are not synced by obsync.`;
      } else {
        const files = await desktop.local(check), state = session.state.data;
        this.pending = files.filter((file) => !isPushed(state.files[file.path], file.mtime, file.size)).map((file) => `Local copy not confirmed uploaded: ${file.path}`);
        this.pending.push(...[...Object.values(state.parked), ...Object.values(state.remoteOnly)].map((file) => `Not yet downloaded or applied: ${file.path}`));
        this.render();
        await desktop.plain(this.output, files, check);
        this.message = `Copied ${files.length} local files. They are unencrypted; this is the on-disk copy, not a claim of completed sync.`;
      }
      decision = "published"; reason = "verified";
    } catch (error) {
      reason = error instanceof ExportError ? error.reason : "local_or_integrity";
      this.message = error instanceof ExportError ? error.message : "The copy could not be completed. Check the archive, recovery phrase, free space and destination. Keep the source; if publication began, check the destination before retrying.";
    } finally {
      this.phrase = ""; this.busy = false; running.delete(this.plugin);
      this.plugin.log(`export decision=${decision} reason=${reason} duration_ms=${Date.now() - started} budget_ms=${EXPORT_WORK_MS}`);
      this.render();
    }
  }
  override onClose(): void { this.closed = true; this.phrase = ""; this.contentEl.empty(); }
}
