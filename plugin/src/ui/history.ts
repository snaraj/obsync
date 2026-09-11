/** Bounded native history browser; all labels are text, never remote HTML. */
import { App, Modal, Notice, Setting } from "obsidian";
import type ObsyncPlugin from "../main";
import { HistoryBrowser, HistoryCancelled, HistoryEntry } from "../sync/history";
import { formatBytes } from "../policy";

export class HistoryModal extends Modal {
  private browser: HistoryBrowser | null = null;
  private busy = false;
  private closed = false;
  private filter = "";
  private rows: HistoryEntry[] = [];
  private message = "";

  constructor(app: App, private readonly plugin: ObsyncPlugin) { super(app); }

  override onOpen(): void {
    this.closed = false;
    this.setTitle("Restore from history");
    this.restart();
  }

  private restart(): void {
    if (this.busy) return;
    if (this.browser) this.plugin.closeHistory(this.browser);
    this.rows = [];
    try {
      this.browser = this.plugin.openHistory();
      this.message = "Select Load next to browse retained versions.";
    } catch (error) {
      this.browser = null;
      this.message = error instanceof Error ? error.message : String(error);
    }
    this.render();
  }

  private render(): void {
    if (this.closed) return;
    const el = this.contentEl;
    el.empty();
    el.createEl("p", { text: "Restore a retained version as a new sibling file. Current files and their history stay unchanged. Deleted notes appear through their retained content versions." });
    el.createEl("p", { text: "Oldest first, within this device's selected folders. Each Load next checks at most 20 versions for up to 5 seconds, plus the current request. More versions may remain even when no matches are shown." });
    new Setting(el).setName("Filename contains").addText((text) => text.setValue(this.filter).setDisabled(this.busy).onChange((value) => { this.filter = value.slice(0, 512); }))
      .addButton((button) => button.setButtonText("Restart search").setDisabled(this.busy).onClick(() => this.restart()));
    el.createEl("p", { text: this.message });
    for (const entry of this.rows) {
      const date = new Date(entry.ts);
      const when = Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
      new Setting(el).setName(entry.path).setDesc(`${when} · ${entry.size === 0 ? "0 B" : formatBytes(entry.size)}${entry.deleted ? " · Deletion marker: select an earlier content version" : " · Creates a new file beside this historical path"}`)
        .addButton((button) => button.setButtonText("Restore a copy").setDisabled(this.busy || entry.deleted || this.browser === null)
          .onClick(() => { void this.restore(entry); }));
    }
    new Setting(el)
      .addButton((button) => button.setButtonText("Load next").setDisabled(this.busy || this.browser === null || this.browser.done)
        .onClick(() => { void this.load(); }))
      .addButton((button) => button.setButtonText(this.busy ? "Cancel and close" : "Close").onClick(() => this.close()));
    el.createEl("p", { text: "Cancel stops later work. Obsidian cannot abort the current network request; reopening waits for it to settle. A local create already dispatched may finish and must be checked. Large files obey this device's limits." });
  }

  private async load(): Promise<void> {
    const browser = this.browser;
    if (!browser || this.busy) return;
    this.busy = true;
    this.message = "Reading retained versions…";
    this.render();
    try {
      const page = await browser.next(this.filter);
      this.rows = page.entries;
      this.message = `Checked ${page.scanned} records; ${page.refused} outside selection or refused. ${page.error ?? (browser.done ? "Reached the captured end of retained history." : "More may remain; select Load next.")}`;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async restore(entry: HistoryEntry): Promise<void> {
    const browser = this.browser;
    if (!browser || this.busy) return;
    this.busy = true;
    this.message = "Verifying and restoring a new copy…";
    this.render();
    try {
      const result = await this.plugin.restoreHistory(browser, entry);
      new Notice(`Copy saved locally at "${result.path}". ${result.syncRequested ? "Ordinary sync requested; check sync status for upload errors." : "Sync is pending. Run Sync now when the plugin is available."}`, 10000);
      this.close();
    } catch (error) {
      if (!(error instanceof HistoryCancelled)) new Notice(error instanceof Error ? error.message : String(error), 10000);
      this.message = "Recovery stopped. Restart search to try again; check any reported copy path first.";
      this.browser = null;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  override onClose(): void {
    this.closed = true;
    if (this.browser) this.plugin.closeHistory(this.browser);
    this.browser = null;
    this.rows = [];
    this.contentEl.empty();
  }
}
