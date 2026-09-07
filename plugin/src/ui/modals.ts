/**
 * The plugin's dialogs: pairing (both roles), the recovery phrase, the sync
 * status, and the remote-only list.
 *
 * These are the only files besides `main.ts` that touch Obsidian's UI
 * classes, so every other module stays testable without Obsidian. Plain
 * `Modal`, `Setting` and `Notice`: no framework, no remote asset, and no
 * inline style beyond the four classes in `styles.css`.
 *
 * PLATFORM. Every dialog is single-column and works at 390 px. Pairing shows
 * the code as text, as a copy button and as an `obsidian://` link, because
 * typing 103 characters on a phone is not a plan.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type ObsyncPlugin from "../main";
import { formatBytes } from "../policy";
import { remoteOnlyList } from "../sync/pull";
import {
  PHRASE_WORDS,
  decodePairingCode,
  encodePairingCode,
  entropyFromPhrase,
  newPairingSecret,
  newVaultKey,
  normalisePhrase,
  openEnvelope,
  pairingLink,
  recoveryPhrase,
  sealEnvelope,
} from "../pairing";
import { hex, unhex } from "../crypto";

function fail(error: unknown): void {
  new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 8000);
}

/**
 * Creator side of pairing. Mints the pairing, keeps `PS` on this device,
 * polls for a claimant, and seals the vault key only after the user has
 * approved the claimant by name and platform.
 */
export class PairCreateModal extends Modal {
  private polling = false;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Pair a new device");
    this.contentEl.createEl("p", {
      text: "Open obsync on the new device and paste this code. It expires in ten minutes and carries the only copy of your vault key that will ever cross the network — sealed so the server cannot read it.",
    });
    void this.run();
  }

  override onClose(): void {
    this.polling = false;
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    try {
      const pairing = await this.plugin.transport.pairingCreate();
      const secret = newPairingSecret();
      const code = encodePairingCode(pairing.pairing_id, pairing.enroll_token, secret);
      const codeEl = this.contentEl.createEl("pre", { cls: "obsync-code", text: code });
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText("Copy code").onClick(() => {
            void navigator.clipboard.writeText(code);
            new Notice("obsync: pairing code copied.");
          }),
        )
        .addButton((button) =>
          button.setButtonText("Copy link").onClick(() => {
            void navigator.clipboard.writeText(pairingLink(code));
            new Notice("obsync: pairing link copied.");
          }),
        );
      const statusEl = this.contentEl.createEl("p", { text: "Waiting for the new device…" });
      this.polling = true;
      while (this.polling) {
        const status = await this.plugin.transport.pairingStatus(pairing.pairing_id);
        if (status.state === "expired") {
          statusEl.setText("This code expired. Close and start again.");
          return;
        }
        if (status.state === "claimed" && status.claimant) {
          codeEl.remove();
          this.polling = false;
          this.approve(pairing.pairing_id, secret, status.claimant, statusEl);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
    } catch (error) {
      fail(error);
      this.close();
    }
  }

  private approve(
    pairingId: string,
    secret: Uint8Array<ArrayBuffer>,
    claimant: { name: string; platform: string; app_version: string },
    statusEl: HTMLElement,
  ): void {
    statusEl.setText(`Approve "${claimant.name}" on ${claimant.platform} (obsync ${claimant.app_version})?`);
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Approve")
          .setCta()
          .onClick(() => {
            void (async () => {
              try {
                const vrk = this.plugin.state.data.vrk;
                if (!vrk) throw new Error("this device holds no vault key");
                const sealed = await sealEnvelope(secret, pairingId, {
                  vrk,
                  domains: this.plugin.state.data.domains,
                });
                await this.plugin.transport.pairingApprove(pairingId, sealed.envelope, sealed.nonce);
                new Notice("obsync: the new device is paired.");
                this.close();
              } catch (error) {
                fail(error);
              }
            })();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Reject").onClick(() => {
          void this.plugin.transport.pairingReject(pairingId).catch(fail);
          this.close();
        }),
      );
  }
}

/** Claimant side: paste the code, claim the pairing, wait for approval. */
export class PairClaimModal extends Modal {
  private code = "";
  private waiting = false;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
    code?: string,
  ) {
    super(app);
    this.code = code ?? "";
  }

  override onOpen(): void {
    this.setTitle("Pair this device");
    this.contentEl.createEl("p", {
      text: "Paste the pairing code shown by a device that already syncs this vault. Approve this device there when it appears.",
    });
    new Setting(this.contentEl).setName("Pairing code").addText((text) =>
      text.setValue(this.code).onChange((value) => {
        this.code = value;
      }),
    );
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Pair")
        .setCta()
        .onClick(() => {
          void this.claim();
        }),
    );
    if (this.code !== "") void this.claim();
  }

  override onClose(): void {
    this.waiting = false;
    this.contentEl.empty();
  }

  private async claim(): Promise<void> {
    if (this.waiting) return;
    try {
      this.waiting = true;
      const parsed = decodePairingCode(this.code);
      const credential = await this.plugin.transport.pairingClaim(parsed.pairingId, parsed.enrollToken, {
        name: this.plugin.deviceName(),
        platform: this.plugin.platformName(),
        app_version: this.plugin.manifest.version,
      });
      this.plugin.state.data.deviceId = credential.device_id;
      this.plugin.state.data.deviceSecret = credential.device_secret;
      await this.plugin.state.save();
      const statusEl = this.contentEl.createEl("p", { text: "Waiting for approval on the other device…" });
      while (this.waiting) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const status = await this.plugin.transport.pairingStatus(parsed.pairingId);
        if (status.state === "expired") {
          statusEl.setText("The pairing expired before it was approved.");
          return;
        }
        if (status.state !== "approved") continue;
        const sealed = await this.plugin.transport.pairingEnvelope(parsed.pairingId);
        const envelope = await openEnvelope(parsed.pairingSecret, parsed.pairingId, sealed.envelope, sealed.nonce);
        this.plugin.state.data.vrk = envelope.vrk;
        this.plugin.state.data.domains = envelope.domains;
        await this.plugin.state.save();
        await this.plugin.restartEngine();
        new Notice("obsync: this device is paired. The first sync is running.");
        this.close();
        return;
      }
    } catch (error) {
      fail(error);
    } finally {
      this.waiting = false;
    }
  }
}

/**
 * Show the recovery phrase and make the user prove they wrote it down: three
 * words, by position, before the dialog will close as confirmed. The phrase
 * is the only way back into a vault whose devices are all gone.
 */
export class RecoveryPhraseModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
    private readonly confirmFirst: boolean,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Recovery phrase");
    void this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const vrk = this.plugin.state.data.vrk;
    if (!vrk) {
      this.contentEl.createEl("p", { text: "This device holds no vault key yet." });
      return;
    }
    const words = await recoveryPhrase(unhex(vrk));
    this.contentEl.createEl("p", {
      text: "Write these 24 words down and keep them off this device. Anyone with them can read this vault; without them and without a paired device the vault cannot be recovered.",
    });
    this.contentEl.createEl("pre", {
      cls: "obsync-phrase",
      text: words.map((word, index) => `${index + 1}. ${word}`).join("\n"),
    });
    if (!this.confirmFirst) return;

    const asked = [3, 11, 20];
    const answers = new Map<number, string>();
    for (const position of asked) {
      new Setting(this.contentEl).setName(`Word ${position}`).addText((text) =>
        text.onChange((value) => answers.set(position, value.trim().toLowerCase())),
      );
    }
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("I have written it down")
        .setCta()
        .onClick(() => {
          const wrong = asked.filter((position) => answers.get(position) !== words[position - 1]);
          if (wrong.length > 0) {
            new Notice(`obsync: word ${wrong.join(", ")} does not match. Check the list again.`);
            return;
          }
          new Notice("obsync: recovery phrase confirmed.");
          this.close();
        }),
    );
  }
}

/** Restore a vault key from its 24 words, or start a brand-new vault. */
export class VaultKeyModal extends Modal {
  private phrase = "";

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Vault key");
    this.contentEl.createEl("p", {
      text: "Start a new vault key on this device, or restore one from its 24-word recovery phrase. A new key means a new vault: existing devices will not read it.",
    });
    new Setting(this.contentEl).setName("Recovery phrase").addTextArea((text) =>
      text.setPlaceholder(`${PHRASE_WORDS} words, separated by spaces`).onChange((value) => {
        this.phrase = value;
      }),
    );
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Restore").onClick(() => {
          void (async () => {
            try {
              const entropy = await entropyFromPhrase(normalisePhrase(this.phrase));
              await this.plugin.adoptVaultKey(hex(entropy));
              new Notice("obsync: vault key restored.");
              this.close();
            } catch (error) {
              fail(error);
            }
          })();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Create a new vault key").onClick(() => {
          void (async () => {
            await this.plugin.adoptVaultKey(hex(newVaultKey()));
            this.close();
            new RecoveryPhraseModal(this.app, this.plugin, true).open();
          })();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** What the status bar cannot say in four words. */
export class StatusModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("obsync status");
    const data = this.plugin.state.data;
    const rows: [string, string][] = [
      ["Server", data.serverUrl === "" ? "not configured" : data.serverUrl],
      ["This device", data.deviceId ?? "not paired"],
      ["Vault key", data.vrk === null ? "absent" : "present"],
      ["State", this.plugin.statusText()],
      ["Files tracked", String(Object.keys(data.files).length)],
      ["Local size", formatBytes(this.plugin.state.localBytes())],
      ["Remote only", String(Object.keys(data.remoteOnly).length)],
      ["Feed sequence", String(data.lastSeq)],
      ["Per-file ceiling", formatBytes(data.policy.perFileMaxBytes)],
      ["Total budget", formatBytes(data.policy.totalBudgetBytes)],
    ];
    const table = this.contentEl.createEl("table", { cls: "obsync-table" });
    for (const [name, value] of rows) {
      const row = table.createEl("tr");
      row.createEl("td", { text: name });
      row.createEl("td", { text: value });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Files this device declined to hold, with a per-file "Fetch" that overrides the ceiling. */
export class RemoteOnlyModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Remote only");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const context = this.plugin.syncContext();
    if (!context) {
      this.contentEl.createEl("p", { text: "obsync is not running on this device yet." });
      return;
    }
    const entries = remoteOnlyList(context);
    if (entries.length === 0) {
      this.contentEl.createEl("p", { text: "Every file in this vault is on this device." });
      return;
    }
    this.contentEl.createEl("p", {
      text: "These files are in the vault but not on this device, because they are larger than this device allows. Fetch one when you need it.",
    });
    for (const entry of entries) {
      new Setting(this.contentEl)
        .setName(entry.path)
        .setDesc(`${formatBytes(entry.size)} — ${entry.why}`)
        .addButton((button) =>
          button.setButtonText("Fetch").onClick(() => {
            void (async () => {
              try {
                await this.plugin.fetchRemoteOnly(entry.fileId);
                new Notice(`obsync: fetched ${entry.path}.`);
                this.render();
              } catch (error) {
                fail(error);
              }
            })();
          }),
        );
    }
  }
}
