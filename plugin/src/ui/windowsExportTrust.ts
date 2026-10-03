/** Explicit OS trust setup; the existing native vault secret store holds the receipt binding. */
import { App, Modal, Setting } from "obsidian";
import { hex, randomBytes } from "../crypto";
import { WindowsFiles } from "../windowsFiles";
import { ExportError } from "../export";
import type { SecretStore } from "../state";

const ENTRY = "obsync-windows-export-v1";
interface Binding { v: 1; path: string; digest: string }
function binding(raw: string): Binding {
  if (raw.length > 8192) throw new ExportError("windows_trust_receipt");
  const value = JSON.parse(raw) as Binding;
  if (!value || Object.keys(value).sort().join() !== "digest,path,v" || value.v !== 1 || typeof value.path !== "string" ||
      value.path.length > 240 || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) throw new ExportError("windows_trust_receipt");
  return value;
}
export function windowsExportBinding(secrets: SecretStore): Binding | null {
  const raw = secrets.getSecret(ENTRY);
  return raw === null ? null : binding(raw);
}
export async function windowsExportFiles(secrets: SecretStore): Promise<WindowsFiles> {
  const value = windowsExportBinding(secrets);
  if (!value) throw new ExportError("windows_setup_required");
  return WindowsFiles.fromReceipt(value.path, value.digest);
}
export class WindowsExportTrust extends Modal {
  private receipt = "";
  private busy = false;
  private closed = true;
  constructor(app: App, private readonly accepted: () => void) { super(app); }
  override onOpen(): void { this.closed = false; this.setTitle("Set up private Windows exports"); void this.render(); }
  private async render(): Promise<void> {
    const el = this.contentEl; el.empty();
    el.createEl("p", { text: "Open Windows PowerShell from the Windows Start menu as your usual user. Run the command below there, then paste its one-line setup receipt. This creates a private receipt in your local app data. No administrator access or CLI installation is needed." });
    const command = await WindowsFiles.setupCommand(hex(randomBytes(16)));
    if (this.closed) return;
    new Setting(el).setName("Setup command").addTextArea(text => { text.setValue(command); text.inputEl.readOnly = true; text.inputEl.rows = 3; });
    new Setting(el).addButton(button => button.setButtonText("Copy setup command").onClick(() => { void navigator.clipboard.writeText(command); }));
    new Setting(el).setName("Setup receipt").addTextArea(text => text.setValue(this.receipt).onChange(value => { this.receipt = value; }));
    const status = el.createEl("p");
    new Setting(el).addButton(button => button.setButtonText("Verify and save").onClick(() => {
      if (this.busy) return;
      this.busy = true; button.setDisabled(true);
      void (async () => {
        try {
          const value = binding(this.receipt.trim());
          await WindowsFiles.fromReceipt(value.path, value.digest);
          const raw = JSON.stringify(value);
          this.app.secretStorage.setSecret(ENTRY, raw);
          if (this.app.secretStorage.getSecret(ENTRY) !== raw) throw new ExportError("windows_trust_storage");
          this.receipt = ""; this.accepted(); this.close();
        } catch { status.setText("Setup could not be verified. Keep Windows exports closed and check the receipt from Windows PowerShell."); }
        finally { this.busy = false; button.setDisabled(false); }
      })();
    })).addButton(button => button.setButtonText("Close").onClick(() => this.close()));
  }
  override onClose(): void { this.closed = true; this.receipt = ""; this.contentEl.empty(); }
}
