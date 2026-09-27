/**
 * The plugin's dialogs: pairing (both roles), the recovery phrase, the sync
 * status, and the remote-only list.
 *
 * These are the only files besides `main.ts` that touch Obsidian's UI
 * classes, so every other module stays testable without Obsidian. Plain
 * `Modal`, `Setting` and `Notice`: no framework, no remote asset, and no
 * inline style beyond the classes in `styles.css`.
 *
 * PLATFORM. Every dialog is single-column and works at 390 px. Pairing shows
 * the code as text, as a copy button and as an `obsidian://` link, because
 * typing 103 characters on a phone is not a plan.
 */

import { App, Modal, Notice, Setting, type TextComponent } from "obsidian";
import type ObsyncPlugin from "../main";
import type { LeaveChoice, LeaveRefusal } from "../main";
import { formatBytes } from "../policy";
import { RemoteOnlyKind, remoteOnlyList, unwritableText } from "../sync/pull";
import {
  PAIRING_WINDOW_MS,
  PHRASE_WORDS,
  PairingVault,
  PendingClaim,
  VaultEnvelope,
  decodePairingCode,
  encodePairingCode,
  entropyFromPhrase,
  matchCode,
  newPairingSecret,
  newVaultKey,
  normalisePhrase,
  openEnvelope,
  openPairingVault,
  sealPairingVault,
  pairingLink,
  platformLabel,
  recoveryPhrase,
  refusalText,
  sealEnvelope,
} from "../pairing";
import { hex, unhex } from "../crypto";
import { ApiError, PairingClaimant, PairingEnvelope, PairingStatus, Sent, Transport, lostMessage } from "../transport";

function fail(error: unknown): void {
  new Notice(error instanceof Error ? error.message : String(error), 8000);
}

/** A pairing refusal or outcome, in words (issue #154); the log line keeps the code. */
function tell(text: string): void {
  new Notice(`obsync: ${text}`, 12000);
}

function reasonOf(error: unknown): string {
  return error instanceof ApiError ? error.code : "local_or_lost";
}

/** Local wall-clock time, "14:05", for when a claim arrived. */
function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * A field whose text is a code or a secret, never prose (issue #208). A phone
 * keyboard must not capitalise, correct, suggest or LEARN it: a learned setup
 * token, pairing code or recovery word stays in the keyboard's dictionary, its
 * suggestion strip and any keyboard history it syncs. On Android these four
 * took the setup token's input type from 0xc0a1 (capitals, corrections,
 * suggestions, learning) to 0x800a1. Desktop only loses the spellcheck
 * underline.
 */
export function literal(el: HTMLInputElement | HTMLTextAreaElement, inputMode?: "url"): void {
  for (const name of ["autocapitalize", "autocorrect", "autocomplete"]) el.setAttribute(name, "off");
  el.setAttribute("spellcheck", "false");
  if (inputMode !== undefined) el.setAttribute("inputmode", inputMode);
}

/**
 * A one-time secret pasted into a field, such as the setup token (issue #169):
 * masked like a password, with a Show toggle to check what was pasted, so a
 * screenshot or a screen share taken while asking for help does not carry it.
 * The caller empties it after every attempt; the token is never shown again.
 */
export function secretText(setting: Setting, placeholder: string, value: string, onChange: (value: string) => void): () => void {
  let input: TextComponent | null = null;
  setting.addText((field) => {
    input = field;
    field.inputEl.type = "password";
    literal(field.inputEl);
    field.setPlaceholder(placeholder).setValue(value).onChange(onChange);
  });
  setting.addExtraButton((button) => button.setIcon("eye").setTooltip("Show").onClick(() => {
    if (input === null) return;
    const show = input.inputEl.type === "password";
    input.inputEl.type = show ? "text" : "password";
    button.setIcon(show ? "eye-off" : "eye").setTooltip(show ? "Hide" : "Show");
  }));
  return () => { input?.setValue(""); };
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
 * Cancel holds the focus, so Enter is never the destructive answer, and a
 * dialog closed any other way is a no (`declined`).
 *
 * CANCEL IS DRAWN FIRST, because that is what gives it the focus: once
 * `onOpen` returns, Obsidian moves the focus to the dialog's first button
 * (measured on 1.13.4 and 1.13.7), over any focus given inside `onOpen`. With
 * the action drawn first, Enter revoked a device or replaced the vault key.
 */
export class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly heading: string,
    private readonly detail: string,
    private readonly confirmed: () => void,
    private readonly action = "Revoke",
    private readonly declined: () => void = () => undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.detail });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.action)
          .setDestructive()
          .onClick(() => {
            this.answered = true;
            this.close();
            this.confirmed();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.declined();
    this.answered = true;
  }
}

/** A `ConfirmModal` as a question: true only for the destructive answer. */
export function confirmFirst(app: App, heading: string, detail: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, heading, detail, () => resolve(true), action, () => resolve(false)).open();
  });
}

/** What a pairing that ends on either side tells the person (issues #153, #154). */
const PAIR_AGAIN = "Make a new code on the other device with Pair a new device, and pair again.";
const MISMATCH =
  "The new device's code does not match this one -- most likely one character was mistyped -- so it could never open the vault key. It was refused and nothing was shared. Make a new code here and paste it whole on the new device.";
const CLAIM_ENDED: Record<string, string> = {
  refused: "The other device did not approve this device: it was refused there, or the code expired first. Nothing was shared. To try again, make a new code there with Pair a new device, and paste it whole.",
  expired: `The pairing code expired before this device received the vault key, so nothing was shared. ${PAIR_AGAIN}`,
  unopened: "This device could not open the vault key it was sent: the code it used does not match the other device's, most likely one mistyped character, or the key was changed on the way. Nothing was shared. Make a new code there with Pair a new device, and paste it whole.",
  consumed: `This device collected the vault key but stopped before keeping it, so it holds none. ${PAIR_AGAIN}`,
  declined: "Pairing cancelled: nothing was uploaded, and this device was removed from the server again.",
};
const STILL_LISTED = " obsync could not remove this device from the server again: revoke it from the other device's Devices list.";

/**
 * Creator side of pairing. Mints the pairing, keeps `PS` on this device,
 * polls for a claimant, and seals the vault key only after the user has
 * approved it by name, platform, time and match code. It says "paired" only
 * once the SERVER reports the key collected, which is also what activates
 * the new device (issue #153).
 *
 * `PS` lives in this dialog and nowhere else, so once it closes nobody can
 * approve this pairing: a claimant still waiting is refused then, rather than
 * left to wait out the ten minutes.
 */
export class PairCreateModal extends Modal {
  private polling = false;
  private closed = false;
  /** The claim on screen until it is answered, by a button or by closing. */
  private asking: string | null = null;
  /** Approved, and not yet seen collected or ended. */
  private collecting = false;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.closed = false;
    this.setTitle("Pair a new device");
    this.contentEl.createEl("p", {
      text: "On the new device, choose Pair this device in obsync and paste this code or its link. It expires in ten minutes and carries the only copy of your vault key that will ever cross the network — sealed so the server cannot read it.",
    });
    void this.run();
  }

  override onClose(): void {
    this.polling = false;
    this.closed = true;
    this.contentEl.empty();
    const asking = this.asking;
    this.asking = null;
    if (asking !== null) {
      void this.refuse(asking, "closed", "Pairing ended: closing that dialog refused the device that was waiting, and nothing was shared with it. To pair it, make a new code.");
    } else if (this.collecting) {
      this.collecting = false;
      tell("Approved. The new device finishes pairing by itself, and appears under Devices once it holds the vault key.");
    }
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
          statusEl.setText("This code expired before a device used it. Close this and make a new one.");
          return;
        }
        // Only a claim is news here: "approved" or "consumed" before this
        // device approved anything is not a state it can have caused.
        if (status.state === "claimed" && status.claimant) {
          codeEl.remove();
          this.polling = false;
          await this.approve(pairing.pairing_id, secret, status.claimant, statusEl);
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
    } catch (error) {
      this.plugin.log(`pairing role=creator decision=failed reason=${reasonOf(error)}`);
      tell(refusalText(error));
      this.close();
    }
  }

  /**
   * Ask about one claim: its name, what it is, when it arrived and the code
   * its own screen shows (issue #152). A claim whose sealed vault details do
   * not open under this code's secret comes from a device that does not hold
   * it -- one mistyped character does that -- and could never open the key,
   * so it is refused before anyone is asked (issue #153).
   */
  private async approve(pairingId: string, secret: Uint8Array<ArrayBuffer>, claimant: PairingClaimant, statusEl: HTMLElement): Promise<void> {
    const asked = new Date();
    this.asking = pairingId;
    let vault: PairingVault | null = null;
    if (claimant.vault !== undefined) {
      try {
        vault = await openPairingVault(secret, pairingId, claimant.vault);
      } catch {
        if (this.asking !== pairingId) return;
        this.asking = null;
        statusEl.setText(MISMATCH);
        await this.refuse(pairingId, "code_mismatch", null);
        return;
      }
    }
    const code = await matchCode(secret, pairingId, claimant.device_id);
    if (this.closed) return;
    statusEl.setText(
      `Approve "${claimant.name}" (${platformLabel(claimant.platform)}, obsync ${claimant.app_version}), asking since ${clock(asked)}? ` +
        `Approve only if the new device shows the code ${code}.` +
        (vault === null ? "" : ` It will sync vault "${vault.name}" (${vault.notes} notes) with this server's vault.`),
    );
    const answer = new Setting(this.contentEl);
    answer
      .addButton((button) =>
        button
          .setButtonText("Approve")
          .setCta()
          .onClick(() => {
            void this.approved(pairingId, secret, claimant, statusEl, answer);
          }),
      )
      .addButton((button) =>
        button.setButtonText("Reject").onClick(() => {
          if (this.asking !== pairingId) return;
          this.asking = null;
          void this.refuse(pairingId, "rejected", "Rejected: that device was refused, and nothing was shared with it.");
          this.close();
        }),
      );
  }

  private async approved(
    pairingId: string,
    secret: Uint8Array<ArrayBuffer>,
    claimant: PairingClaimant,
    statusEl: HTMLElement,
    answer: Setting,
  ): Promise<void> {
    if (this.asking !== pairingId) return;
    this.asking = null;
    try {
      const vrk = this.plugin.state.data.vrk;
      if (!vrk) throw new Error("This device holds no vault key, so it cannot pair another. Restore its recovery phrase first.");
      const sealed = await sealEnvelope(secret, pairingId, { vrk });
      value(await this.plugin.transport.pairingApprove(pairingId, sealed.envelope, sealed.nonce), "approving the new device");
      this.plugin.log("pairing role=creator decision=approved");
      this.collecting = true;
      answer.settingEl.remove();
      statusEl.setText("Approved. Waiting for the new device to collect the vault key…");
      await this.watch(pairingId, claimant, statusEl);
    } catch (error) {
      this.collecting = false;
      this.plugin.log(`pairing role=creator decision=failed reason=${reasonOf(error)}`);
      tell(refusalText(error));
    }
  }

  /** After approval: done when the server reports the key collected, and not before. */
  private async watch(pairingId: string, claimant: PairingClaimant, statusEl: HTMLElement): Promise<void> {
    while (this.collecting) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (!this.collecting) return;
      let state: PairingStatus["state"] | "ended";
      try {
        state = (await this.plugin.transport.pairingStatus(pairingId)).state;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "unknown_pairing")) throw error;
        state = "ended";
      }
      if (!this.collecting) return;
      if (state === "consumed") {
        this.collecting = false;
        this.plugin.log("pairing role=creator decision=paired");
        new Notice(`The new device, "${claimant.name}", is paired: it holds the vault key now.`);
        void this.plugin.refreshDeviceNames();
        this.close();
        return;
      }
      if (state === "expired" || state === "ended") {
        this.collecting = false;
        this.plugin.log(`pairing role=creator decision=failed reason=${state === "ended" ? "ended_unseen" : "not_collected"}`);
        statusEl.setText(state === "ended"
          ? "This pairing ended before this device saw the new one collect the vault key. If the new device is not under Devices, make a new code and pair it again."
          : "The new device did not collect the vault key before the code expired, so nothing was shared with it. To pair it, make a new code and paste it there.");
        return;
      }
    }
  }

  /** Refuse a claim: its device is destroyed with its secret. `told` is the notice, if any. */
  private async refuse(pairingId: string, reason: string, told: string | null): Promise<void> {
    try {
      value(await this.plugin.transport.pairingReject(pairingId), "refusing the new device");
      this.plugin.log(`pairing role=creator decision=refused reason=${reason}`);
      if (told !== null) tell(told);
    } catch (error) {
      this.plugin.log(`pairing role=creator decision=failed reason=${reasonOf(error)} refusing=${reason}`);
      tell(refusalText(error));
    }
  }
}

/**
 * A pairing claim waiting for its vault key (issue #153). The claim dialog
 * shows it while open and hands it on when closed, and a restart resumes it
 * from its own secret entry inside the ten minutes. One at a time: a newer
 * claim stops the older first (`stopWaiting`).
 */
export interface Waiting {
  claim: PendingClaim;
  /** The match code, once derived. */
  code: string | null;
  /** What the dialog says, while there is one; terminal outcomes raise a notice as well. */
  show: (text: string) => void;
  stop: boolean;
  /** True once this device is paired by it. */
  done: Promise<boolean>;
}

/** Start waiting on a claim: hold it for a restart, then collect in the background. */
export function awaitApproval(
  plugin: ObsyncPlugin,
  app: App,
  claim: PendingClaim,
  show: (text: string) => void,
  resumed = false,
): Waiting {
  const waiting: Waiting = { claim, code: null, show, stop: false, done: Promise.resolve(false) };
  plugin.waiting = waiting;
  if (!resumed && !plugin.state.holdClaim(JSON.stringify(claim))) {
    plugin.log("pairing role=claimant decision=unkept reason=secret_storage");
  }
  waiting.done = collect(plugin, app, waiting, resumed);
  return waiting;
}

/** Stop an earlier claim before a new one, and let it take back what it may hold. */
async function stopWaiting(plugin: ObsyncPlugin): Promise<void> {
  const earlier = plugin.waiting;
  if (earlier === null) return;
  earlier.stop = true;
  await earlier.done;
}

class ClaimEnded extends Error {
  constructor(readonly reason: "expired" | "unopened" | "declined" | "superseded") {
    super(reason);
  }
}

/** The claimant's end of an ApiError that ends a claim. */
const CLAIM_REFUSALS: Record<string, string> = {
  bad_signature: "refused",
  pairing_expired: "expired",
  envelope_consumed: "consumed",
};

/**
 * Take back a device the server may have activated for a claim that ends
 * without its key, signed as that claim (`ObsyncPlugin.credential`). True
 * when nothing active remains: a pending device is never active and the
 * server destroys it at the end of the window.
 */
async function revokeSelf(plugin: ObsyncPlugin, transport: Transport, claim: PendingClaim): Promise<boolean> {
  try {
    const sent = await transport.revokeDevice(claim.deviceId);
    plugin.log(`pairing role=claimant decision=${sent.outcome === "ok" ? "revoked" : "unconfirmed"} reason=keyless`);
    return sent.outcome === "ok";
  } catch (error) {
    const gone = error instanceof ApiError && ["device_pending", "bad_signature", "device_revoked"].includes(error.code);
    plugin.log(`pairing role=claimant decision=${gone ? "gone" : "failed"} reason=keyless code=${reasonOf(error)}`);
    return gone;
  }
}

/**
 * Wait for approval, collect the sealed vault key once, open it and keep it
 * -- with the credential, in ONE save, and only then (issue #153). Until that
 * save this device holds no credential of its own: the claim signs its
 * collection, and a claim that ends without the key takes back whatever the
 * server may have activated and says why, in words, on this device.
 */
async function collect(plugin: ObsyncPlugin, app: App, waiting: Waiting, resumed: boolean): Promise<boolean> {
  const { claim } = waiting;
  const started = Date.now();
  const { state, transport, assertCurrent } = plugin.captureSession();
  const secret = unhex(claim.pairingSecret);
  // Whether the server may hold this device as ACTIVE: collection activates.
  let active = resumed;
  // Once the key is kept this device is paired, and nothing takes it back.
  let kept = false;
  try {
    waiting.code = await matchCode(secret, claim.pairingId, claim.deviceId);
    const asked = `Waiting for approval on the other device. Its prompt shows the code ${waiting.code}: if it shows another, choose Reject there.`;
    waiting.show(asked);
    if (resumed) tell(`still pairing this device. ${asked}`);
    for (;;) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      assertCurrent();
      if (waiting.stop) throw new ClaimEnded("superseded");
      if (Date.now() >= claim.claimedAt + PAIRING_WINDOW_MS) throw new ClaimEnded("expired");
      // Status belongs to the creator. The claimant may only collect its
      // envelope; an explicit not_approved refusal has not consumed it.
      let sent: Sent<PairingEnvelope>;
      try {
        sent = await transport.pairingEnvelope(claim.pairingId);
      } catch (error) {
        active = error instanceof ApiError && error.code === "envelope_consumed";
        if (error instanceof ApiError && error.status === 409 && error.code === "not_approved") {
          plugin.log("pairing role=claimant decision=waiting reason=not_approved");
          continue;
        }
        throw error;
      }
      // Answered or lost, the server may have activated this device now. The
      // envelope is handed over exactly once, so a lost answer has spent it.
      active = true;
      const sealed = value(sent, "collecting the sealed vault key");
      let envelope: VaultEnvelope;
      try {
        envelope = await openEnvelope(secret, claim.pairingId, sealed.envelope, sealed.nonce);
      } catch {
        throw new ClaimEnded("unopened");
      }
      assertCurrent();
      if (waiting.stop) throw new ClaimEnded("superseded");
      // BEFORE THE KEY IS KEPT, because a kept key starts the first sync,
      // and that sync publishes every note here to every device syncing
      // the vault (issue #141). A copy of the same vault holds nothing new
      // and pairs without a question; anything else asks, Cancel first.
      const unknown = await plugin.notesUnknownTo(envelope.vrk);
      assertCurrent();
      if (unknown > 0 && !(await confirmFirst(
        app,
        "Add this vault's notes to the server's vault?",
        `This vault holds ${unknown} note(s) that are not in the vault ${state.data.serverUrl} holds. Pairing ` +
          "uploads them to every device syncing that vault. One server holds one vault: a different vault needs a server of its own.",
        "Pair and upload",
      ))) {
        plugin.log(`pairing role=claimant decision=declined unknown=${unknown}`);
        throw new ClaimEnded("declined");
      }
      // A credential an older pairing left without a key is replaced here;
      // it is revoked once this one can sign for it.
      const stranded = state.data.vrk === null ? state.data.deviceId : null;
      state.data.deviceId = claim.deviceId;
      state.data.deviceSecret = claim.deviceSecret;
      state.data.vrk = envelope.vrk;
      await state.save();
      assertCurrent();
      kept = true;
      plugin.waiting = null;
      state.holdClaim(null);
      if (stranded !== null && stranded !== claim.deviceId) {
        const retired = await transport.revokeDevice(stranded).catch(() => null);
        plugin.log(`pairing role=claimant decision=${retired?.outcome === "ok" ? "revoked" : "kept"} reason=stranded_enrolment`);
      }
      await plugin.restartEngine();
      plugin.log(`pairing role=claimant decision=paired duration_ms=${Date.now() - started}`);
      new Notice("This device is paired. The first sync is running.");
      return true;
    }
  } catch (error) {
    const code = error instanceof ApiError ? error.code : "";
    const reason = error instanceof ClaimEnded ? error.reason
      : Object.hasOwn(CLAIM_REFUSALS, code) ? CLAIM_REFUSALS[code] as string : code === "" ? "local_or_lost" : code;
    plugin.log(`pairing role=claimant decision=${kept ? "paired" : "failed"} reason=${reason} duration_ms=${Date.now() - started}`);
    // A newer session of this plugin owns the state now, and resumes this
    // claim from its entry; a state that stopped is the next session's too.
    // Nothing is taken back or dropped from here, and a kept key is kept.
    let stale = false;
    try { assertCurrent(); } catch { stale = true; }
    if (stale || kept) {
      tell(refusalText(error));
      return kept;
    }
    let text = Object.hasOwn(CLAIM_ENDED, reason) ? CLAIM_ENDED[reason] as string : `${refusalText(error)} ${PAIR_AGAIN}`;
    if (active && !(await revokeSelf(plugin, transport, claim))) text += STILL_LISTED;
    if (plugin.waiting === waiting) plugin.waiting = null;
    state.holdClaim(null);
    if (reason !== "superseded") {
      waiting.show(text);
      tell(text);
    }
    return false;
  }
}

/** Claimant side: paste the code or the link, claim the pairing, wait for approval. */
export class PairClaimModal extends Modal {
  private code = "";
  private busy = false;
  private closed = false;
  private statusEl: HTMLElement | null = null;
  private waiting: Waiting | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
    code?: string,
    private readonly afterClose: () => void = () => undefined,
  ) {
    super(app);
    this.code = code ?? "";
  }

  override onOpen(): void {
    this.closed = false;
    this.setTitle("Pair this device");
    this.contentEl.createEl("p", {
      text: "On a device that already syncs this vault, choose Pair a new device, then paste its code or its link here. Approve this device there when it asks.",
    });
    new Setting(this.contentEl).setName("Pairing code").addText((text) => {
      literal(text.inputEl);
      text.setValue(this.code).onChange((value) => {
        this.code = value;
      });
    });
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
    this.closed = true;
    this.contentEl.empty();
    this.handOff();
    this.afterClose();
  }

  /** A closed dialog is not a cancelled pairing: the claim finishes behind it (issue #153). */
  private handOff(): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting === null || this.plugin.waiting !== waiting) return;
    waiting.show = () => undefined;
    tell("still waiting for approval in the background. Approve this device on the other device, and pairing finishes by itself; the code works for ten minutes from when it was made.");
  }

  private show(text: string): void {
    if (!this.closed) (this.statusEl ??= this.contentEl.createEl("p")).setText(text);
  }

  private async claim(): Promise<void> {
    if (this.busy) return;
    // A DEVICE THAT SYNCS IS NEVER RE-PAIRED IN PLACE (issue #143). A claim
    // replaces its credential with a pending one while its cursor and file
    // records stay, so sync stopped, a stray device appeared, and a first
    // sync against another server's records doubled the vault. Leaving first
    // clears all three; a pairing link opened here, even one this device
    // made, claims nothing.
    if (this.plugin.state.paired && !this.plugin.forgottenDevice) {
      this.plugin.log("pairing role=claimant decision=refused reason=already_paired");
      fail(new Error(
        `This device already syncs with ${this.plugin.state.data.serverUrl} as "${this.plugin.deviceName()}", ` +
          "so nothing was claimed. To pair it again, use Leave this server in obsync's settings first.",
      ));
      this.close();
      return;
    }
    try {
      this.busy = true;
      if (this.plugin.forgottenDevice) await this.plugin.resetForgottenEnrollment();
      await stopWaiting(this.plugin);
      if (this.closed) return;
      // BEFORE ANY REQUEST (issue #180): a vault inside a synced vault that
      // pairs with it copies that vault into itself, one level per sync.
      const nested = await this.plugin.nestedRefusal("pairing role=claimant");
      if (nested !== null) {
        fail(new Error(nested));
        this.close();
        return;
      }
      const { state, transport, assertCurrent } = this.plugin.captureSession();
      const parsed = decodePairingCode(this.code);
      const name = await this.plugin.nameThisDevice();
      const vault = await sealPairingVault(parsed.pairingSecret, parsed.pairingId, {
        name: this.app.vault.getName(), notes: this.app.vault.getMarkdownFiles().length,
      });
      assertCurrent();
      if (this.closed) return;
      const credential = value(
        await transport.pairingClaim(parsed.pairingId, parsed.enrollToken, {
          name,
          platform: this.plugin.platformName(),
          app_version: this.plugin.manifest.version,
          vault,
        }),
        "claiming the pairing",
      );
      assertCurrent();
      this.plugin.log("pairing role=claimant decision=claimed");
      // HELD, NOT KEPT (issue #153): the credential is this claim's until the
      // key it was approved for is kept with it.
      this.waiting = awaitApproval(this.plugin, this.app, {
        pairingId: parsed.pairingId,
        pairingSecret: hex(parsed.pairingSecret),
        deviceId: credential.device_id,
        deviceSecret: credential.device_secret,
        serverUrl: state.data.serverUrl,
        claimedAt: Date.now(),
      }, (text) => this.show(text));
      const done = this.waiting.done;
      if (this.closed) this.handOff();
      if (await done) this.close();
    } catch (error) {
      this.plugin.log(`pairing role=claimant decision=failed reason=${reasonOf(error)}`);
      const text = refusalText(error);
      this.show(text);
      tell(text);
    } finally {
      this.busy = false;
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
  "Pairing again — with this server or another — is a first sync for this device. Identical notes stay one note. If a local note differs from the server's note at the same path, both versions are kept for you to review.";
const LEAVE_UNKNOWN_DEVICE =
  "This server does not recognise this device: it was rebuilt or restored from a backup, or it is not the server this device paired with, so there is nothing there this device can revoke. You can leave on this device only: this device forgets the server and keeps every note, and the 24 words still open the same vault. If the server does still list this device, revoke it from the dashboard or from another device.";
const LEAVE_LAST_DEVICE =
  "This account has no registered vault recovery yet, or the server is too old to support it. Update both server and plugin while a device still syncs, then keep the setup token and 24-word recovery phrase before leaving. You can also pair another device first. Leaving on this device only keeps every note and leaves this credential active on the server; losing that final credential before recovery is registered can strand the account.";
const LEAVE_ONLY_HERE =
  "You can leave on this device only: this device forgets the server and its credential and keeps every note, and the 24 words still open the same vault. The server still lists this device until you remove it from another device's Devices list or the dashboard.";
const LEAVING =
  "Leaving: stopping sync on this device, then asking the server to remove it. This takes a few seconds. You can close this window; a notice says when it is done.";
const LEFT_ONLY_HERE =
  "This device has left. Your server still lists it until you remove it from another device's Devices list or the dashboard.";

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
  /** Why the server kept this device, when leaving on this device only is what the user chose. */
  private refusal: LeaveRefusal = "last_device";
  /**
   * Set by the press that starts a leave, before anything is awaited, and the
   * buttons are gone from the dialog the same moment: one press is one leave
   * (issue #157, S22).
   */
  private leaving = false;
  /** What the dialog showed before the press, to go back to if the leave fails outright. */
  private screen: () => void = () => undefined;

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
    this.screen = () => this.draw(unpushed);
    this.contentEl.empty();
    for (const text of [LEAVE_KEPT, LEAVE_LOST, LEAVE_AGAIN]) this.contentEl.createEl("p", { text });
    if (unpushed.length > 0) {
      // Sync now is advice only where it can work: not offline, and not for a
      // device the server no longer accepts (S40, S80).
      const now = this.plugin.sendsNow
        ? "Run Sync now first and they are safe; leave now"
        : "They cannot be sent now: the server is out of reach or no longer accepts this device. Leave now";
      this.contentEl.createEl("p", {
        text: `${unpushed.length} file(s) on this device hold changes the server never received. ${now} and they stay in this vault and nowhere else.`,
      });
      const list = this.contentEl.createEl("ul");
      for (const path of unpushed.slice(0, UNPUSHED_SHOWN)) list.createEl("li", { text: path });
      if (unpushed.length > UNPUSHED_SHOWN) {
        list.createEl("li", { text: `… and ${unpushed.length - UNPUSHED_SHOWN} more` });
      }
    }
    const leaving = this.mode === "switch" ? "Leave and switch" : "Leave";
    this.cancel(new Setting(this.contentEl)).addButton((button) =>
      button
        .setButtonText(unpushed.length === 0 ? leaving : `Discard ${unpushed.length} and leave`)
        .setDestructive()
        .onClick(() => {
          void this.leave({ discardUnpushed: unpushed.length > 0, localOnly: false });
        }),
    );
  }

  private async leave(choice: LeaveChoice): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    // Progress at once, in place of the buttons: the stop, the revoke and a
    // refusal each take seconds, and a dialog that sat unchanged for them read
    // as a press that did nothing (S22, S40).
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: LEAVING });
    let result;
    try {
      result = await this.plugin.leaveServer(choice);
    } catch (error) {
      fail(error);
      if (this.live) this.screen();
      return;
    } finally {
      this.leaving = false;
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
    this.refusal = result.reason;
    this.refused(choice, result.reason, result.detail);
  }

  /** The revoke did not happen: why, in one sentence, and the local leave. */
  private refused(choice: LeaveChoice, reason: LeaveRefusal, detail: string): void {
    this.screen = () => this.refused(choice, reason, detail);
    this.contentEl.empty();
    const texts = reason === "bad_signature"
      ? [LEAVE_UNKNOWN_DEVICE]
      : [
        reason === "unreachable"
          ? "The server did not answer, so it could not remove this device."
          : `The server refused to revoke this device: ${detail}.`,
        reason === "last_device" ? LEAVE_LAST_DEVICE : LEAVE_ONLY_HERE,
      ];
    for (const text of texts) this.contentEl.createEl("p", { text });
    this.cancel(new Setting(this.contentEl)).addButton((button) =>
      button
        .setButtonText("Leave on this device only")
        .setDestructive()
        .onClick(() => {
          void this.leave({ ...choice, localOnly: true });
        }),
    );
  }

  private left(revoked: boolean): void {
    new Notice(
      revoked
        ? "This device left the server. Every note is still in this vault."
        : this.refusal === "last_device"
          ? "This device forgot the server, which still holds this device. Every note is still in this vault."
          : this.refusal === "bad_signature"
            ? "This device forgot the server, which did not recognise it. Every note is still in this vault."
            : LEFT_ONLY_HERE,
      10000,
    );
    this.onLeft();
    if (!this.live || this.mode !== "switch") {
      this.close();
      return;
    }
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "Enter the new server's address. Set up an empty server with its setup token, recover an existing account with that token and this vault’s key, or pair from a device already syncing there.",
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
          .setButtonText("Pair with existing vault")
          .onClick(() => { void this.adopt(typed, "pair"); }),
      ).addButton((button) => button.setButtonText("Set up or recover").setCta()
        .onClick(() => { void this.adopt(typed, "setup"); })
      ),
    );
  }

  private async adopt(typed: string, mode: "pair" | "setup"): Promise<void> {
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
    if (mode === "pair") new PairClaimModal(this.app, this.plugin, undefined, this.onLeft).open();
    else new AccountSetupModal(this.app, this.plugin).open();
  }
}

export class AccountSetupModal extends Modal {
  constructor(app: App, private readonly plugin: ObsyncPlugin) { super(app); }
  override onOpen(): void {
    this.setTitle("Set up or recover this account");
    this.contentEl.createEl("p", { text: "Enter this server’s setup token. An existing account also requires the vault key retained on this device, or its restored 24-word recovery phrase. An empty server uses this vault’s key." });
    let token = "";
    const clear = secretText(new Setting(this.contentEl).setName("Setup token"), "Setup token", "", (value) => { token = value.trim(); });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("Set up or recover").setCta().onClick(() => {
        const typed = token;
        token = "";
        void this.plugin.setUpAccount(typed, "obsync").then(() => {
          // Used once, then gone from the screen, whatever the answer (#169).
          clear();
          if (this.plugin.state.data.deviceId !== null) this.close();
        });
      }));
  }
  override onClose(): void { this.contentEl.empty(); }
}

/** What a device that has not confirmed its 24 words is told, wherever it is told (issue #170). */
export const RECOVERY_UNCONFIRMED =
  "Not confirmed — Show and confirm. Write the 24 words down, away from this device, and type three of them back: without them and without a paired device this vault cannot be recovered.";

/**
 * Show the recovery phrase and make the user prove they wrote it down: three
 * words, by position, before the dialog will close as confirmed. The phrase
 * is the only way back into a vault whose devices are all gone.
 *
 * THE DEVICE REMEMBERS THE ANSWER (issue #170). Passing the check records
 * it. Closing a dialog opened to confirm -- Escape, the cross, a tap outside
 * -- records a skip, which the next start mentions ONCE; Settings and Show
 * sync status say "not confirmed" until the check is passed. The check is
 * offered whenever this device has not passed it, however the dialog opened.
 */
export class RecoveryPhraseModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
    private readonly confirmFirst: boolean,
    private readonly afterClose: () => void = () => undefined,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Recovery phrase");
    void this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
    const data = this.plugin.state.data;
    if (this.confirmFirst && data.vrk !== null && data.recoveryPhrase !== "confirmed") {
      data.recoveryPhrase = "skipped";
      this.plugin.log("phrase decision=skipped");
      void this.plugin.state.save().catch(() => {});
    }
    this.afterClose();
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
    if (!this.confirmFirst && this.plugin.state.data.recoveryPhrase === "confirmed") return;

    const asked = [3, 11, 20];
    const answers = new Map<number, string>();
    for (const position of asked) {
      new Setting(this.contentEl).setName(`Word ${position}`).addText((text) => {
        literal(text.inputEl);
        text.onChange((value) => answers.set(position, value.trim().toLowerCase()));
      });
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
          this.plugin.state.data.recoveryPhrase = "confirmed";
          this.plugin.log("phrase decision=confirmed");
          void this.plugin.state.save().catch(() => {});
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
    new Setting(this.contentEl).setName("Recovery phrase").addTextArea((text) => {
      literal(text.inputEl);
      text.setPlaceholder(`${PHRASE_WORDS} words, separated by spaces`).onChange((value) => {
        this.phrase = value;
      });
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("Restore").onClick(async () => {
          try {
            assertCurrent();
            const entropy = await entropyFromPhrase(normalisePhrase(this.phrase));
            assertCurrent();
            await this.plugin.restoreVaultKey(hex(entropy));
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
            const vrk = hex(newVaultKey());
            // A new key opens nothing the server holds: on a server with a
            // vault it strands every other device (issue #140). Asked first.
            if (await this.plugin.vaultKeyStrands(vrk) && !(await confirmFirst(
              this.app,
              "Create a new vault key?",
              "The vault on this server was sealed with another key, and a new key cannot open it. Every device " +
                "syncing that vault would stop receiving this device's changes, and this device would stop receiving " +
                "theirs. To sync that vault, restore its 24 words or pair from a device that syncs it; a different " +
                "vault needs a server of its own.",
              "Create a new key",
            ))) {
              this.plugin.log("vaultkey decision=declined reason=strands_vault");
              return;
            }
            assertCurrent();
            await this.plugin.adoptVaultKey(vrk);
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

/**
 * What the status indicator cannot say, and the one thing to do next (#156).
 *
 * IT STAYS TRUE WHILE IT IS OPEN. It rendered once, so a window opened while
 * a device was offline still said so thirteen minutes after the status bar
 * had moved on (S74); it now redraws on every status change until it closes.
 * And a state that needs the person carries its next step as a button: Retry
 * now while the server is not answering, with when the next try runs by
 * itself; Pair again for a device the server no longer knows; Open settings
 * for something in front of the server; Retry now once a clock or a full
 * server has been fixed.
 */
export class StatusModal extends Modal {
  private unwatch: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Sync status");
    this.render();
    this.unwatch = this.plugin.onStatusChange(() => this.render());
  }

  private render(): void {
    this.contentEl.empty();
    this.nextStep();
    const data = this.plugin.state.data;
    const rows: [string, string][] = [
      ["Server", data.serverUrl === "" ? "not configured" : data.serverUrl],
      ["This device", data.deviceId ?? "not paired"],
      ["Vault key", data.vrk === null ? "absent" : "present"],
      ["State", this.plugin.statusText()],
      // Every file the feed moved past because this device could not write
      // it, by name and in plain words (issue #144).
      ...Object.values(data.parked).map((entry): [string, string] => ["Waiting to be written", unwritableText(entry.path, entry.reason)]),
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
    // The one thing to do that nothing else here would show (issue #170).
    if (data.vrk !== null && data.recoveryPhrase !== "confirmed") {
      new Setting(this.contentEl)
        .setName("Recovery phrase")
        .setDesc(RECOVERY_UNCONFIRMED)
        .addButton((button) => button.setButtonText("Show and confirm").setCta().onClick(() => {
          this.close();
          new RecoveryPhraseModal(this.app, this.plugin, true).open();
        }));
    }
    // Every note paused because something here rewrites it after every sync,
    // each with its own way back (issue #179).
    for (const [fileId, entry] of Object.entries(data.paused)) {
      new Setting(this.contentEl)
        .setName(entry.path)
        .setDesc("Paused: repeated rewrites after sync were detected on a paired device. Stop the plugin rewriting synced notes, then resume.")
        .addButton((button) =>
          button.setButtonText("Resume").onClick(() => {
            void this.plugin.resumeNote(fileId).then(() => this.close(), fail);
          }),
        );
    }
  }

  /** The state that needs doing something about, what it is, and the button that does it. */
  private nextStep(): void {
    const status = this.plugin.currentStatus();
    if (status.kind === "offline") {
      const at = this.plugin.nextRetryAt();
      new Setting(this.contentEl)
        .setName("Your server is not answering")
        .setDesc(at === null
          ? "obsync tries again by itself, and at once when this device's network comes back."
          : `obsync tries again by itself at ${new Date(at).toLocaleTimeString()}, and at once when this device's network comes back.`)
        .addButton((button) => button.setButtonText("Retry now").setCta().onClick(() => { this.plugin.retry(); }));
      return;
    }
    if (status.kind !== "error") return;
    const pair = status.code === "forgotten_device";
    const settings = pair || status.code === "edge";
    new Setting(this.contentEl)
      .setName("What to do")
      .setDesc(status.message)
      .addButton((button) => button
        .setButtonText(pair ? "Pair again" : settings ? "Open settings" : "Retry now")
        .setCta()
        .onClick(() => {
          if (settings) {
            this.close();
            this.plugin.openSettings();
          } else this.plugin.retry();
        }));
  }

  override onClose(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.contentEl.empty();
  }
}

/** What each kind of "Remote only" entry is, in the order the view shows them. */
export const REMOTE_ONLY_HEADINGS: [RemoteOnlyKind, string][] = [
  ["older", "On this device in an older version: the newer one on the server was not downloaded. Fetch it to replace the copy here."],
  ["limit", "Not on this device, because they are larger than this device allows. Fetch one when you need it."],
  ["available", "Not on this device yet, and within this device's limits now. Fetch one to bring it here."],
];

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
    // One heading per reason, above only the entries it is true of (issue #161).
    for (const [kind, heading] of REMOTE_ONLY_HEADINGS) {
      const group = entries.filter((entry) => entry.kind === kind);
      if (group.length === 0) continue;
      this.contentEl.createEl("p", { text: heading });
      for (const entry of group) {
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
}
