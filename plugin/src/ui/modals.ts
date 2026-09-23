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
import type { LeaveChoice } from "../main";
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
import { ApiError, PairingEnvelope, Sent, lostMessage } from "../transport";

function fail(error: unknown): void {
  new Notice(error instanceof Error ? error.message : String(error), 8000);
}

/**
 * Every pairing step mints or consumes state, so none of them is repeatable
 * and a lost answer is never retried (`transport.ts`). The user is the one
 * who can act on it: a pairing that may or may not have advanced is one to
 * abandon and start again, and only the person holding both devices can do
 * that. So the reason is surfaced verbatim rather than guessed at here.
 */
function value<T>(sent: Sent<T>, what: string): T {
  if (sent.outcome === "lost") throw new Error(lostMessage(what, sent));
  return sent.value;
}

/**
 * Ask before something irreversible. Revocation is one-way — the server
 * drops the device's wrapped secret — so it is never one stray tap away.
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly detail: string,
    private readonly confirmed: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.detail });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("Revoke")
          .setDestructive()
          .onClick(() => {
            this.close();
            this.confirmed();
          }),
      )
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
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
      const pairing = value(await this.plugin.transport.pairingCreate(), "creating a pairing");
      const secret = newPairingSecret();
      const code = encodePairingCode(pairing.pairing_id, pairing.enroll_token, secret);
      const codeEl = this.contentEl.createEl("pre", { cls: "obsync-code", text: code });
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText("Copy code").onClick(() => {
            void navigator.clipboard.writeText(code);
            new Notice("Pairing code copied.");
          }),
        )
        .addButton((button) =>
          button.setButtonText("Copy link").onClick(() => {
            void navigator.clipboard.writeText(pairingLink(code));
            new Notice("Pairing link copied.");
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
                const sealed = await sealEnvelope(secret, pairingId, { vrk });
                value(
                  await this.plugin.transport.pairingApprove(pairingId, sealed.envelope, sealed.nonce),
                  "approving the new device",
                );
                new Notice("The new device is paired.");
                this.close();
              } catch (error) {
                fail(error);
              }
            })();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Reject").onClick(() => {
          void this.plugin.transport
            .pairingReject(pairingId)
            .then((sent) => value(sent, "rejecting the new device"))
            .catch(fail);
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
      const { state, transport, assertCurrent } = this.plugin.captureSession();
      const parsed = decodePairingCode(this.code);
      const credential = value(
        await transport.pairingClaim(parsed.pairingId, parsed.enrollToken, {
          name: this.plugin.deviceName(),
          platform: this.plugin.platformName(),
          app_version: this.plugin.manifest.version,
        }),
        "claiming the pairing",
      );
      assertCurrent();
      state.data.deviceId = credential.device_id;
      state.data.deviceSecret = credential.device_secret;
      await state.save();
      assertCurrent();
      if (!this.waiting) return;
      this.contentEl.createEl("p", { text: "Waiting for approval on the other device…" });
      while (this.waiting) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        if (!this.waiting) return;
        assertCurrent();
        // Status belongs to the creator. The claimant may only collect its
        // envelope; an explicit not_approved refusal has not consumed it.
        let sealed: PairingEnvelope;
        try {
          sealed = value(
            await transport.pairingEnvelope(parsed.pairingId),
            "collecting the sealed vault key",
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 409 && error.code === "not_approved") {
            this.plugin.log("pairing role=claimant decision=waiting reason=not_approved");
            continue;
          }
          throw error;
        }
        // The envelope is handed over exactly once, so a lost answer has
        // spent it: the vault key is gone and this pairing cannot complete.
        // `value` above makes that terminal; only not_approved polls again.
        const envelope = await openEnvelope(parsed.pairingSecret, parsed.pairingId, sealed.envelope, sealed.nonce);
        assertCurrent();
        state.data.vrk = envelope.vrk;
        await state.save();
        assertCurrent();
        if (!this.waiting) return;
        await this.plugin.restartEngine();
        this.plugin.log("pairing role=claimant decision=paired");
        new Notice("This device is paired. The first sync is running.");
        this.close();
        return;
      }
    } catch (error) {
      this.plugin.log(`pairing role=claimant decision=failed reason=${error instanceof ApiError ? error.code : "local_or_lost"}`);
      fail(error);
    } finally {
      this.waiting = false;
    }
  }
}

/** "Leave this server", or the same thing followed by pairing. */
export type LeaveMode = "leave" | "switch";

/** How many unpushed paths the dialog names before it starts counting. */
const UNPUSHED_SHOWN = 10;

const LEAVE_KEPT =
  "Every note in this vault stays exactly where it is. Leaving changes nothing inside the vault, and the 24 words still open the SAME vault afterwards, so pairing again is not a new vault. This device's name, its folder selection and its two ceilings are kept too.";
const LEAVE_LOST =
  "What is lost is this device's sync identity: the server revokes its device id and credential, and this device forgets the server address, any edge service-token headers, its place in the change feed and its record of every synced file. No other device is touched.";
const LEAVE_AGAIN =
  "Pairing again — with this server or another — is a first sync for this device. Where the server already holds a note at the same path, the local note stays and the server's copy arrives beside it as a conflict copy.";
const LEAVE_LAST_DEVICE =
  "An account whose last active device is revoked can never sync again: nothing in this release re-enrols one, so everything the server stores for this vault would stay there unreachable. Pair another device first and revoke this one from it. You can still leave LOCALLY: this device forgets the server and keeps every note, and the server keeps this device — so revoke it from the dashboard or from another device later.";

/**
 * Leaving a server, with the whole cost stated before the button (issue #79).
 *
 * The dialog counts the edits the server never received BEFORE it offers to
 * leave, because those are the one thing leaving can lose: the notes stay,
 * their unsynced changes have nowhere else to be. Nothing here decides
 * anything — `ObsyncPlugin.leaveServer` owns the order and the refusals, and
 * this draws whichever answer it gives.
 */
export class LeaveServerModal extends Modal {
  private live = true;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
    private readonly mode: LeaveMode,
    private readonly onLeft: () => void = () => undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.mode === "switch" ? "Switch server" : "Leave this server");
    void this.show();
  }

  override onClose(): void {
    this.live = false;
    this.contentEl.empty();
  }

  private cancel(setting: Setting, text = "Cancel"): Setting {
    return setting.addButton((button) => button.setButtonText(text).onClick(() => this.close()));
  }

  /** Count first: what the count is decides which buttons this offers. */
  private async show(): Promise<void> {
    if (this.plugin.state.data.deviceId === null) {
      this.contentEl.createEl("p", { text: "This device is not paired with a server, so there is nothing to leave." });
      this.cancel(new Setting(this.contentEl), "Close");
      return;
    }
    this.contentEl.createEl("p", { text: "Checking for changes the server has not received…" });
    let unpushed: string[];
    try {
      unpushed = await this.plugin.unpushedEdits();
    } catch (error) {
      fail(error);
      this.close();
      return;
    }
    if (!this.live) return;
    this.draw(unpushed);
  }

  private draw(unpushed: string[]): void {
    this.contentEl.empty();
    for (const text of [LEAVE_KEPT, LEAVE_LOST, LEAVE_AGAIN]) this.contentEl.createEl("p", { text });
    if (unpushed.length > 0) {
      this.contentEl.createEl("p", {
        text: `${unpushed.length} file(s) on this device hold changes the server never received. Run Sync now first and they are safe; leave now and they stay in this vault and nowhere else.`,
      });
      const list = this.contentEl.createEl("ul");
      for (const path of unpushed.slice(0, UNPUSHED_SHOWN)) list.createEl("li", { text: path });
      if (unpushed.length > UNPUSHED_SHOWN) {
        list.createEl("li", { text: `… and ${unpushed.length - UNPUSHED_SHOWN} more` });
      }
    }
    const leaving = this.mode === "switch" ? "Leave and switch" : "Leave";
    this.cancel(
      new Setting(this.contentEl).addButton((button) =>
        button
          .setButtonText(unpushed.length === 0 ? leaving : `Discard ${unpushed.length} and leave`)
          .setDestructive()
          .onClick(() => {
            void this.leave({ discardUnpushed: unpushed.length > 0, localOnly: false });
          }),
      ),
    );
  }

  private async leave(choice: LeaveChoice): Promise<void> {
    let result;
    try {
      result = await this.plugin.leaveServer(choice);
    } catch (error) {
      fail(error);
      return;
    }
    // A leave that happened is reported even if the dialog was closed while
    // it ran: the action is done, and only the drawing needs a live dialog.
    if (result.decision === "left") {
      this.left(result.revoked);
      return;
    }
    if (!this.live) return;
    // The count is taken with the queue stopped, so a set that grew since the
    // dialog drew it is the user's own editing: draw the new one and ask again.
    if (result.reason === "unpushed_edits") {
      new Notice("This device has changes the server never received. Leaving was not done.", 8000);
      this.draw(result.unpushed);
      return;
    }
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `The server refused to revoke this device: ${result.detail}.` });
    this.contentEl.createEl("p", { text: LEAVE_LAST_DEVICE });
    this.cancel(
      new Setting(this.contentEl).addButton((button) =>
        button
          .setButtonText("Leave locally anyway")
          .setDestructive()
          .onClick(() => {
            void this.leave({ ...choice, localOnly: true });
          }),
      ),
    );
  }

  private left(revoked: boolean): void {
    new Notice(
      revoked
        ? "This device left the server. Every note is still in this vault."
        : "This device forgot the server, which still holds this device. Every note is still in this vault.",
      10000,
    );
    this.onLeft();
    if (!this.live || this.mode !== "switch") {
      this.close();
      return;
    }
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "Enter the new server's address, then paste a pairing code from a device that already syncs this vault there. For a server with no account yet, use First-time setup in the settings tab with that server's setup token instead.",
    });
    let typed = "";
    new Setting(this.contentEl).setName("Server URL").addText((text) =>
      text.setPlaceholder("sync.example.org").onChange((value) => {
        typed = value;
      }),
    );
    this.cancel(
      new Setting(this.contentEl).addButton((button) =>
        button
          .setButtonText("Continue")
          .setCta()
          .onClick(() => {
            void this.adopt(typed);
          }),
      ),
    );
  }

  private async adopt(typed: string): Promise<void> {
    if (typed.trim() === "") {
      new Notice("Enter the new server's address first.");
      return;
    }
    try {
      await this.plugin.setServerUrl(typed);
    } catch (error) {
      fail(error);
      return;
    }
    if (!this.live) return;
    this.onLeft();
    this.close();
    new PairClaimModal(this.app, this.plugin).open();
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
    // A numbered list, laid out by the stylesheet in two columns of twelve.
    const list = this.contentEl.createEl("ol", { cls: "obsync-phrase" });
    for (const word of words) list.createEl("li", { text: word });
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
            new Notice(`Word ${wrong.join(", ")} does not match. Check the list again.`);
            return;
          }
          new Notice("Recovery phrase confirmed.");
          this.close();
        }),
    );
  }
}

/** Restore a vault key from its 24 words, or start a brand-new vault. */
export class VaultKeyModal extends Modal {
  private phrase = "";
  private opened: object | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const opened = this.opened = {};
    let session: ReturnType<ObsyncPlugin["captureSession"]>;
    try { session = this.plugin.captureSession(); }
    catch (error) { fail(error); return; }
    const assertCurrent = (): void => {
      session.assertCurrent();
      if (this.opened !== opened) throw new Error("This vault-key dialog was closed. Open it again before restoring a key.");
    };
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
        button.setButtonText("Restore").onClick(async () => {
          try {
            assertCurrent();
            const entropy = await entropyFromPhrase(normalisePhrase(this.phrase));
            assertCurrent();
            await this.plugin.adoptVaultKey(hex(entropy));
            assertCurrent();
            new Notice("Vault key restored.");
            this.close();
          } catch (error) {
            fail(error);
          }
        }),
      )
      .addButton((button) =>
        button.setButtonText("Create a new vault key").onClick(async () => {
          try {
            assertCurrent();
            await this.plugin.adoptVaultKey(hex(newVaultKey()));
            assertCurrent();
            this.close();
            new RecoveryPhraseModal(this.app, this.plugin, true).open();
          } catch (error) { fail(error); }
        }),
      );
  }

  override onClose(): void {
    this.opened = null;
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
    this.setTitle("Sync status");
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
      this.contentEl.createEl("p", { text: "Sync is not running on this device yet." });
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
                new Notice(`Fetched ${entry.path}.`);
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
