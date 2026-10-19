import { App, Modal, Setting } from "obsidian";
import type ObsyncPlugin from "../main";
import { unhex } from "../crypto";
import { encodeRecoveryBackup } from "../recoveryBackup";
import { refusalText } from "../pairing";
import { literal, secretText } from "./modals";

/** Explicit access-only versus fresh-key choice; content verification is always on. */
export class RevokeModal extends Modal {
  constructor(app: App, private readonly plugin: ObsyncPlugin, private readonly device: string,
    private readonly name: string, private readonly accessOnly: () => void) { super(app); }
  override onOpen(): void {
    this.setTitle(`Revoke ${this.name}?`);
    this.contentEl.createEl("p", { text: "Revocation cannot erase data or keys already copied by this device. Choose the protection you need." });
    const self = this.device === this.plugin.state.data.deviceId;
    if (!self) new Setting(this.contentEl).setName("Rotate the vault key (recommended)")
      .setDesc("Protect future updates even if the server supplies ciphertext to the removed device. Requires a new backup, re-encryption and restart. Every retained device must pair again.")
      .addButton(button => button.setButtonText("Rotate key").setCta().onClick(() => {
        this.close(); new RotationModal(this.app, this.plugin, this.device).open();
      }));
    new Setting(this.contentEl).setName("Block server access only")
      .setDesc("The server refuses this credential. The device keeps its key and can decrypt future ciphertext if it obtains it elsewhere. Encryption and integrity checks remain enabled.")
      .addButton(button => button.setButtonText("Block access").setDestructive().onClick(() => { this.close(); this.accessOnly(); }));
    if (self) this.contentEl.createEl("p", { text: "Rotate from a retained device to exclude this one. Blocking this device stops its sync; keep your recovery backup before proceeding." });
  }
  override onClose(): void { this.contentEl.empty(); }
}

export class RotationModal extends Modal {
  private alive = false;
  private busy = false;
  private message = "";
  constructor(app: App, private readonly plugin: ObsyncPlugin, private readonly target: string | null = null) { super(app); }
  override onOpen(): void { this.alive = true; void this.render(); }
  override onClose(): void { this.alive = false; this.contentEl.empty(); }

  private async run(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.message = "";
    try { await work(); }
    catch (error) { this.message = refusalText(error); }
    finally { this.busy = false; if (this.alive) await this.render(); }
  }

  private async render(): Promise<void> {
    if (!this.alive) return;
    this.contentEl.empty(); this.setTitle("Encryption upgrade and key rotation");
    if (this.message) this.contentEl.createEl("p", { text: this.message });
    const pending = this.plugin.state.custody2();
    if (!pending?.rotation) {
      this.contentEl.createEl("p", { text: "This action creates an independent vault key and re-encrypts every available current version. Local notes stay in place. Every other device loses server access at commit and must pair again. Old backups remain useful for old history; they cannot decrypt future updates under the new key." });
      new Setting(this.contentEl).addButton(button => button.setButtonText("Stage encryption transition").setCta()
        .onClick(() => { void this.run(() => this.plugin.startRotation(this.target)); }));
      return;
    }
    this.contentEl.createEl("p", { text: "Sync is stopped while this transition is pending. Keep both the old and new recovery backups. You can close this dialog and resume from settings." });
    if (pending.phase === "draft") new Setting(this.contentEl).addButton(button => button.setButtonText("Cancel unprepared transition")
      .onClick(() => { void this.run(() => this.plugin.cancelRotationDraft()); }));
    else new Setting(this.contentEl).setName("Coordinator access no longer works?")
      .setDesc("Recover access to this exact pending transition with its new backup and the setup token. Sync stays stopped.")
      .addButton(button => button.setButtonText("Recover transition access").onClick(() => {
        this.close(); new RotationAccessModal(this.app, this.plugin).open();
      }));
    if (pending.phase === "prepared" || pending.phase === "seeding") {
      this.contentEl.createEl("p", { text: "The server snapshot is frozen. Re-encrypt and read back every current version before commit." });
      const progress = this.contentEl.createEl("p", { text: "Ready to transfer." });
      new Setting(this.contentEl).addButton(button => button.setButtonText("Re-encrypt current versions").setCta().onClick(() => {
        void this.run(() => this.plugin.seedRotation((done, total) => { if (this.alive) progress.setText(`Verified ${done} of ${total} versions.`); }));
      }));
      return;
    }
    if (pending.phase === "commit_unknown") this.contentEl.createEl("p", { text: "All versions have been transferred and the catalog saved. Restart Obsidian, reopen this dialog, and confirm the new backup and setup token to commit. Other devices must then pair from this device." });
    else this.contentEl.createEl("p", { text: "Save this complete new backup separately, including its format marker. Paste it back below before freezing the server snapshot." });
    let backup = "", token = "";
    try {
      const encoded = await encodeRecoveryBackup(unhex(pending.rotation.newRoot));
      if (!this.alive || this.plugin.state.custody2()?.rotation?.intent.operation !== pending.rotation.intent.operation) return;
      this.contentEl.createEl("pre", { text: encoded });
    } catch (error) { if (this.alive) this.contentEl.createEl("p", { text: refusalText(error) }); return; }
    new Setting(this.contentEl).setName("Confirm complete new backup").addTextArea(input => { literal(input.inputEl); input.onChange(value => { backup = value; }); });
    const clearToken = secretText(new Setting(this.contentEl).setName("Setup token"), "Setup token", "", value => { token = value; });
    new Setting(this.contentEl).addButton(button => button.setButtonText(pending.phase === "commit_unknown" ? "Commit new key" : "Prepare transition").setCta().onClick(() => {
      const suppliedToken = token, suppliedBackup = backup; token = ""; backup = ""; clearToken();
      void this.run(async () => {
        if (pending.phase === "commit_unknown") {
          await this.plugin.commitRotation(suppliedToken, suppliedBackup);
          this.message = "New generation ready on this device. Pair each retained device again. Devices you do not pair cannot decrypt future updates.";
        } else await this.plugin.prepareRotation(suppliedToken, suppliedBackup);
      });
    }));
  }
}

export class LegacyUpgradeModal extends Modal {
  private alive = false;
  private busy = false;
  constructor(app: App, private readonly plugin: ObsyncPlugin) { super(app); }
  override onOpen(): void {
    this.alive = true; this.setTitle("Recover legacy vault for upgrade");
    this.contentEl.createEl("p", { text: "Use the old 24-word backup and this server's setup token. This recovers an existing older vault directly into an encryption upgrade. It cannot create a vault or start sync. Keep the old backup, then save the new backup before continuing." });
    let backup = "", token = "";
    new Setting(this.contentEl).setName("Legacy 24-word backup").addTextArea(input => {
      literal(input.inputEl); input.onChange(value => { backup = value; });
    });
    const clear = secretText(new Setting(this.contentEl).setName("Setup token"), "Setup token", "", value => { token = value; });
    const message = this.contentEl.createEl("p", { text: "" });
    new Setting(this.contentEl).addButton(button => button.setButtonText("Recover for upgrade").setCta().onClick(() => {
      if (this.busy || !this.alive) return;
      this.busy = true;
      const supplied = { token, backup }; token = ""; backup = ""; clear();
      void this.plugin.recoverLegacyForUpgrade(supplied.token, supplied.backup, () => {
        if (!this.alive) throw new Error("This recovery dialog is closed.");
      }).then(() => {
        if (this.alive) { this.close(); new RotationModal(this.app, this.plugin).open(); }
      }).catch(error => { if (this.alive) message.setText(refusalText(error)); }).finally(() => { this.busy = false; });
    }));
  }
  override onClose(): void { this.alive = false; this.contentEl.empty(); }
}

class RotationAccessModal extends Modal {
  private alive = false;
  private busy = false;
  constructor(app: App, private readonly plugin: ObsyncPlugin) { super(app); }
  override onOpen(): void {
    this.alive = true; this.setTitle("Recover pending transition access");
    this.contentEl.createEl("p", { text: "This uses the exact pending transition saved on this device. Both saved roots and the transition record must still be available. If a reply is lost, retry this same action; it does not create a new vault or resume ordinary sync." });
    let backup = "", token = "";
    new Setting(this.contentEl).setName("Complete new recovery backup").addTextArea(input => { literal(input.inputEl); input.onChange(value => { backup = value; }); });
    const clearToken = secretText(new Setting(this.contentEl).setName("Setup token"), "Setup token", "", value => { token = value; });
    const message = this.contentEl.createEl("p");
    new Setting(this.contentEl).addButton(button => button.setButtonText("Recover access").onClick(async () => {
      if (this.busy) return;
      this.busy = true;
      const suppliedBackup = backup, suppliedToken = token; backup = ""; token = ""; clearToken();
      try {
        const outcome = await this.plugin.recoverRotationAccess(suppliedToken, suppliedBackup);
        if (!this.alive) return;
        if (outcome === "resumed") { this.close(); new RotationModal(this.app, this.plugin).open(); }
        else message.setText("The reply was lost. Access has not been adopted locally. Retain both backups and retry this exact recovery action.");
      } catch (error) { if (this.alive) message.setText(refusalText(error)); }
      finally { this.busy = false; }
    }));
  }
  override onClose(): void { this.alive = false; this.contentEl.empty(); }
}

/** The user supplies the old backup; merely opening this dialog changes nothing. */
export class PreviousKeyModal extends Modal {
  private alive = false;
  private busy = false;
  constructor(app: App, private readonly plugin: ObsyncPlugin, private readonly action: "replace" | "retire") { super(app); }
  override onOpen(): void {
    this.alive = true;
    this.setTitle(this.action === "replace" ? "Pair after a key rotation" : "Remove previous history key");
    this.contentEl.createEl("p", { text: this.action === "replace"
      ? "First save your old recovery backup. On an updated device, choose Pair a new device. This device keeps its local notes and retains the old key for history after you verify the pairing codes and receive the new key."
      : "This removes the previous generation's key from this device. Keep its separate backup if you need old retained history. It does not delete server history or erase copies on other devices." });
    const suite = this.action === "retire" ? this.plugin.state.custody2()?.history?.suite : this.plugin.state.custody2() === null ? 1 : 2;
    this.contentEl.createEl("p", { text: suite === 1 ? "Enter the old 24-word legacy backup. This is an explicit legacy-history action."
      : "Enter the complete old backup, including obsync-recovery-v2." });
    let backup = "";
    new Setting(this.contentEl).setName("Confirm old recovery backup").addTextArea(input => { literal(input.inputEl); input.onChange(value => { backup = value; }); });
    const message = this.contentEl.createEl("p");
    new Setting(this.contentEl).addButton(button => button.setButtonText(this.action === "replace" ? "Continue to pairing" : "Remove previous key").onClick(async () => {
      if (this.busy) return;
      this.busy = true;
      const text = backup; backup = "";
      const current = (): void => { if (!this.alive) throw new Error("This dialog was closed."); };
      try {
        if (this.action === "replace") await this.plugin.pairAfterRotation(text, current);
        else await this.plugin.retireHistoryBackup(text, current);
        if (this.alive) this.close();
      } catch (error) { if (this.alive) message.setText(refusalText(error)); }
      finally { this.busy = false; }
    }));
  }
  override onClose(): void { this.alive = false; this.contentEl.empty(); }
}
