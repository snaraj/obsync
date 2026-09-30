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

import { App, Modal, Setting, type TextComponent } from "obsidian";
import type ObsyncPlugin from "../main";
import type { LeaveChoice, LeaveRefusal } from "../main";
import { RECOVERY_MISMATCH } from "../accountRecovery";
import { formatBytes } from "../policy";
import { KEYS_LOST } from "../state";
import { RECENT_MAX, titles, type NoticeKind } from "../notices";
import { RemoteOnlyKind, remoteOnlyList, unwritableText } from "../sync/pull";
import {
  PAIRING_WINDOW_MS,
  PHRASE_WORDS,
  PairingKeyExchange,
  PairingVault,
  PendingClaim,
  VaultEnvelope,
  decodePairingCode,
  encodePairingCode,
  entropyFromPhrase,
  isV2Secret,
  keptOutcome,
  matchCode,
  matchCodeV2,
  newPairingKeyExchange,
  newPairingSecret,
  newVaultKey,
  normalisePhrase,
  openEnvelope,
  openEnvelopeV2,
  openPairingVault,
  sealPairingVault,
  pairingLink,
  platformLabel,
  recoveryPhrase,
  refusalText,
  sealEnvelope,
  sealEnvelopeV2,
  serverPairsV2,
} from "../pairing";
import { hex, unhex } from "../crypto";
import { ApiError, PairingClaimant, PairingEnvelope, PairingStatus, Sent, Transport, lostMessage } from "../transport";

/** A failure in its own words, as the answer to the person's click (`notices.ts`, kind `confirm`). */
function fail(plugin: ObsyncPlugin, error: unknown): void {
  plugin.notices.show({ kind: "confirm", text: error instanceof Error ? error.message : String(error) });
}

/** "1 note", "7 notes": the approval prompt and the claimant's question count the same way. */
function notes(count: number): string {
  return `${count} note${count === 1 ? "" : "s"}`;
}

/**
 * A pairing refusal or outcome, in words (issue #154); the log line keeps the
 * code. The answer to a click by default; an `error` when it lands behind a
 * closed dialog, where nobody is watching for it.
 */
function tell(plugin: ObsyncPlugin, text: string, kind: NoticeKind = "confirm"): void {
  plugin.notices.show({ kind, text });
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

const PAIR_INTRO =
  "On the new device, choose Pair this device in obsync and TYPE this code. It expires in ten minutes and carries the secret that unlocks your vault key on the new device. Don't email or message it to yourself, or send its link through a work chat: anyone who can read that channel could unlock your vault.";
const SERVER_TOO_OLD =
  "Your obsync server runs a version older than 1.1.5, or does not say which, so no code was made. Update your obsync server to 1.1.5 or later, then pair again. See Troubleshooting, \"Pairing says to update your obsync server\".";
const KEY_DROPPED =
  "did not keep the vault key and removed itself from the server: the code it used did not match this one, or pairing was cancelled on it. It does not sync; to pair it, make a new code and paste it whole there.";
const KEY_UNCONFIRMED =
  "collected the vault key but has not started syncing within ten minutes. Look at it: if it asks whether to add its notes, answer there; if it says it could not open the vault key, remove it under Devices.";
/** Two-second reads for ten minutes: while the new device collects the key, and again while it opens it. */
const CONFIRM_POLLS = 300;

/** A server-reported version as one safe log word. */
function versionWord(version: unknown): string {
  if (version === null || version === undefined) return "unreported";
  return typeof version === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? version : "unreadable";
}

/**
 * Creator side of pairing. Mints the pairing, keeps `PS` on this device,
 * polls for a claimant, and seals the vault key only after the user has
 * approved it by name, platform, time and match code. It says "paired" only
 * once the new device KEPT the key it collected (`keptOutcome`): collection,
 * which activates it (issue #153), is not yet a pairing. Before any code, it
 * refuses a server older than 1.1.5 (`serverPairsV2`).
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
    void this.run();
  }

  override onClose(): void {
    this.polling = false;
    this.closed = true;
    this.contentEl.empty();
    const asking = this.asking;
    this.asking = null;
    if (asking !== null) {
      void this.refuse(asking, "closed", "pairing ended: closing that dialog refused the device that was waiting, and nothing was shared with it. To pair it, make a new code.");
    }
  }

  private async run(): Promise<void> {
    const introEl = this.contentEl.createEl("p", { text: "Checking your obsync server…" });
    try {
      // SAID EARLY (owner ruling, 2026-09-29). A server older than 1.1.5
      // drops the key exchange, so a code made through it could never pair a
      // 1.1.5 device: the two screens would only show different numbers. The
      // server's version is read before anything is minted, and it can only
      // REFUSE: a forged or stripped answer ends here, never in a weaker
      // pairing, and the exchange's own strip detection is unchanged.
      const server = await this.serverVersion();
      if (this.closed) return;
      if (!serverPairsV2(server)) {
        this.plugin.log(`pairing role=creator decision=refused reason=server_too_old server=${versionWord(server)}`);
        introEl.setText(SERVER_TOO_OLD);
        return;
      }
      introEl.setText(PAIR_INTRO);
      const pairing = value(await this.plugin.transport.pairingCreate(), "creating a pairing");
      const secret = newPairingSecret();
      const code = encodePairingCode(pairing.pairing_id, pairing.enroll_token, secret);
      const codeEl = this.contentEl.createEl("pre", { cls: "obsync-code", text: code });
      new Setting(this.contentEl)
        .addButton((button) =>
          button.setButtonText("Copy code").onClick(() => {
            void navigator.clipboard.writeText(code);
            tell(this.plugin, "pairing code copied. Type it into your other device; don't send it through work email or chat.");
          }),
        )
        .addButton((button) =>
          button.setButtonText("Copy link").onClick(() => {
            void navigator.clipboard.writeText(pairingLink(code));
            tell(this.plugin, "pairing link copied. Open it on your other device; don't send it through work email or chat.");
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
      tell(this.plugin, refusalText(error));
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
    // v2 when the claim carried a key-exchange public key; else the legacy
    // path with a plain warning that the other device is older. An older
    // server never gets here (`run` refuses it before a code exists); a key
    // stripped on the way looks identical, and the claimant's mismatched code
    // catches that (a v2 claimant never opens a legacy envelope).
    const claimantKey = claimant.claimant_pub;
    const code = claimantKey === undefined
      ? await matchCode(secret, pairingId, claimant.device_id)
      : await matchCodeV2(secret, pairingId, claimant.device_id, claimantKey);
    if (this.closed) return;
    statusEl.setText(
      `Approve "${claimant.name}" (${platformLabel(claimant.platform)}, obsync ${claimant.app_version}), asking since ${clock(asked)}? ` +
        `Approve only if the new device shows the code ${code}.` +
        (claimantKey === undefined
          ? " That device runs an older obsync; update it so pairing can protect the code you shared."
          : "") +
        (vault === null ? "" : ` It will sync vault "${vault.name}" (${notes(vault.notes)}) with this server's vault.`),
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
          void this.refuse(pairingId, "rejected", "rejected: that device was refused, and nothing was shared with it.");
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
      const claimantKey = claimant.claimant_pub;
      let sealed: { envelope: string; nonce: string };
      let creatorKey: string | undefined;
      let kex: string;
      if (claimantKey === undefined) {
        // Legacy claimant (or a stripped v2 key): seal under PS alone, as 1.1.4.
        sealed = await sealEnvelope(secret, pairingId, { vrk });
        kex = "legacy";
      } else {
        // v2: an ephemeral P-256 exchange; the envelope needs both the code and
        // the live agreement to open, so a captured code alone no longer does.
        let ours: PairingKeyExchange | null = await newPairingKeyExchange();
        creatorKey = ours.publicKey;
        sealed = await sealEnvelopeV2(ours, claimantKey, secret, pairingId, { vrk });
        ours = null; // drop the reference: the ephemeral private key is not kept
        kex = "v2";
      }
      value(await this.plugin.transport.pairingApprove(pairingId, sealed.envelope, sealed.nonce, creatorKey), "approving the new device");
      this.plugin.log(`pairing role=creator decision=approved kex=${kex}`);
      // DONE HERE ONCE THE APPROVAL LANDS (1.1.5): what is left is the new
      // device's to do, so this dialog closes, and the rest is watched
      // behind it and said in a notice. `PS` is not needed past the seal.
      this.collecting = true;
      this.plugin.register?.(() => { this.collecting = false; });
      answer.settingEl.remove();
      this.close();
      tell(this.plugin, `approved "${claimant.name}": it finishes pairing by itself, and obsync tells you here when it has.`);
      await this.watch(pairingId, claimant);
    } catch (error) {
      this.collecting = false;
      this.plugin.log(`pairing role=creator decision=failed reason=${reasonOf(error)}`);
      tell(this.plugin, refusalText(error), "error");
    }
  }

  /**
   * After approval, behind the closed dialog: done when the server reports
   * the key collected, and not before. No dialog ends it now, so it ends by
   * itself with the code's ten minutes (`CONFIRM_POLLS`), whatever the
   * server keeps answering, or when the plugin unloads (`approved`).
   */
  private async watch(pairingId: string, claimant: PairingClaimant): Promise<void> {
    let state: PairingStatus["state"] | "ended" = "expired";
    for (let poll = 1; poll <= CONFIRM_POLLS; poll++) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (!this.collecting) return;
      try {
        state = (await this.plugin.transport.pairingStatus(pairingId)).state;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "unknown_pairing")) throw error;
        state = "ended";
      }
      if (!this.collecting) return;
      if (state === "consumed") {
        await this.confirmKept(claimant);
        return;
      }
      if (state === "expired" || state === "ended") break;
    }
    this.collecting = false;
    this.plugin.log(`pairing role=creator decision=failed reason=${state === "ended" ? "ended_unseen" : "not_collected"}`);
    tell(this.plugin, state === "ended"
      ? `pairing "${claimant.name}" ended before this device saw it collect the vault key. If it is not under Devices, make a new code and pair it again.`
      : `"${claimant.name}" did not collect the vault key before the code expired, so nothing was shared with it. To pair it, make a new code and paste it there.`, "error");
  }

  /**
   * "PAIRED" ONLY ONCE THE NEW DEVICE KEPT THE KEY (owner ruling, lab leg B3):
   * a device that collected it and could not open it was announced as paired
   * here while its own screen said nothing was shared. Its row in the device
   * list decides (`keptOutcome`); a failed read decides nothing and is logged
   * once.
   */
  private async confirmKept(claimant: PairingClaimant): Promise<void> {
    let unread = false;
    for (let poll = 1; poll <= CONFIRM_POLLS; poll++) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      if (!this.collecting) return;
      let outcome: ReturnType<typeof keptOutcome>;
      try {
        const { devices } = await this.plugin.transport.devices();
        outcome = keptOutcome(devices.find((device) => device.device_id === claimant.device_id));
      } catch (error) {
        if (!unread) this.plugin.log(`pairing role=creator decision=waiting reason=devices_unread error=${reasonOf(error)}`);
        unread = true;
        continue;
      }
      if (!this.collecting) return;
      if (outcome === "kept") {
        this.collecting = false;
        this.plugin.log(`pairing role=creator decision=paired polls=${poll}`);
        tell(this.plugin, `"${claimant.name}" is paired: it holds the vault key now.`);
        void this.plugin.refreshDeviceNames();
        return;
      }
      if (outcome === "dropped") {
        this.collecting = false;
        this.plugin.log(`pairing role=creator decision=failed reason=key_not_kept polls=${poll}`);
        tell(this.plugin, `"${claimant.name}" ${KEY_DROPPED}`, "error");
        return;
      }
    }
    if (!this.collecting) return;
    this.collecting = false;
    this.plugin.log(`pairing role=creator decision=failed reason=key_unconfirmed polls=${CONFIRM_POLLS}`);
    tell(this.plugin, `"${claimant.name}" ${KEY_UNCONFIRMED}`, "error");
  }

  /** The release the server reports (`GET /v1/plugin/manifest`), or `null` when it reports none. */
  private async serverVersion(): Promise<unknown> {
    try {
      return (await this.plugin.transport.pluginManifest({ interactive: true })).version;
    } catch (error) {
      if (error instanceof ApiError && error.code === "plugin_unavailable") return null;
      throw error;
    }
  }

  /** Refuse a claim: its device is destroyed with its secret. `told` is the notice, if any. */
  private async refuse(pairingId: string, reason: string, told: string | null): Promise<void> {
    try {
      value(await this.plugin.transport.pairingReject(pairingId), "refusing the new device");
      this.plugin.log(`pairing role=creator decision=refused reason=${reason}`);
      if (told !== null) tell(this.plugin, told);
    } catch (error) {
      this.plugin.log(`pairing role=creator decision=failed reason=${reasonOf(error)} refusing=${reason}`);
      tell(this.plugin, refusalText(error));
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
  /**
   * The v2 ephemeral key exchange, memory-only for this claim, or `null` for a
   * legacy claim. The private key is non-extractable and is never persisted, so
   * a v2 claim finishes only while this process lives; it survives closing the
   * dialog (the wait continues in `plugin.waiting`) but not a full restart.
   */
  keyExchange: PairingKeyExchange | null;
}

/** Start waiting on a claim: hold it for a restart, then collect in the background. */
export function awaitApproval(
  plugin: ObsyncPlugin,
  app: App,
  claim: PendingClaim,
  show: (text: string) => void,
  resumed = false,
  keyExchange: PairingKeyExchange | null = null,
): Waiting {
  const waiting: Waiting = { claim, code: null, show, stop: false, done: Promise.resolve(false), keyExchange };
  plugin.waiting = waiting;
  // A v2 claim is never written to disk: its ephemeral private key cannot be,
  // so a restart cannot complete it, and holding the rest would only strand a
  // device the server destroys at the window's end. A legacy claim is held for
  // a restart exactly as before.
  if (!resumed && keyExchange === null && !plugin.state.holdClaim(JSON.stringify(claim))) {
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
  const kex = waiting.keyExchange;
  // Whether the server may hold this device as ACTIVE: collection activates.
  let active = resumed;
  // Once the key is kept this device is paired, and nothing takes it back.
  let kept = false;
  try {
    waiting.code = kex === null
      ? await matchCode(secret, claim.pairingId, claim.deviceId)
      : await matchCodeV2(secret, claim.pairingId, claim.deviceId, kex.publicKey);
    const asked = (code: string): string => `Waiting for approval on the other device. Its prompt shows the code ${code}: if it shows another, choose Reject there.`
      + (kex === null ? " That device runs an older obsync; update it so pairing can protect the code you shared." : "");
    waiting.show(asked(waiting.code));
    // The code is for comparing now, never for keeping: Recent, the command
    // line and the log read "•••" in its place (`SyncNotice.code`).
    if (resumed) plugin.notices.show({ kind: "question", key: "pairing", text: `still pairing this device. ${asked("{code}")}`, code: waiting.code });
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
        if (kex === null) {
          envelope = await openEnvelope(secret, claim.pairingId, sealed.envelope, sealed.nonce);
        } else if (typeof sealed.creator_pub !== "string") {
          // This device asked for a key exchange (it saw the v2 marker) but the
          // creator sent no key: the field was stripped, or the creator is not
          // really v2. Refuse rather than fall back to the weaker seal.
          throw new Error("pairing: the other device did not complete the key exchange");
        } else {
          envelope = await openEnvelopeV2(kex, sealed.creator_pub, secret, claim.pairingId, sealed.envelope, sealed.nonce);
        }
      } catch {
        throw new ClaimEnded("unopened");
      }
      assertCurrent();
      if (waiting.stop) throw new ClaimEnded("superseded");
      // BEFORE THE KEY IS KEPT, because a kept key starts the first sync,
      // and that sync publishes every note here to every device syncing
      // the vault (issue #141). A copy of the same vault holds nothing new
      // and pairs without a question; anything else asks, Cancel first.
      // The approval has happened, and the dialog says so while it compares:
      // a phone with 6,069 files read "Waiting for approval" for 62 s (#236).
      waiting.show("Approved. Comparing the notes here with your server's vault before anything is sent. A large vault takes a minute.");
      const unknown = await plugin.notesUnknownTo(envelope.vrk);
      assertCurrent();
      if (unknown > 0 && !(await confirmFirst(
        app,
        "Add this vault's notes to the server's vault?",
        `This vault has ${notes(unknown)} the server's vault does not. Pairing uploads ${unknown === 1 ? "it" : "them"} to every ` +
          "device that syncs with this server. One server holds one vault: a different vault needs a server of its own.",
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
      // Another vault's key is a phrase this device has not confirmed, as
      // `adoptVaultKey` has it (issue #170).
      if (state.data.vrk !== envelope.vrk) state.data.recoveryPhrase = "unconfirmed";
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
      tell(plugin, "this device is paired, and its first sync is running.");
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
      tell(plugin, refusalText(error), "error");
      return kept;
    }
    let text = Object.hasOwn(CLAIM_ENDED, reason) ? CLAIM_ENDED[reason] as string : `${refusalText(error)} ${PAIR_AGAIN}`;
    if (active && !(await revokeSelf(plugin, transport, claim))) text += STILL_LISTED;
    if (plugin.waiting === waiting) plugin.waiting = null;
    state.holdClaim(null);
    if (reason !== "superseded") {
      waiting.show(text);
      tell(plugin, text, "error");
    }
    return false;
  }
}

/**
 * A DEVICE THAT SYNCS IS NEVER RE-PAIRED IN PLACE (issue #143), whether a code,
 * a link or the palette asked (issue #154): what it is told instead, or `null`
 * when it may pair.
 */
export function alreadyPaired(plugin: ObsyncPlugin): string | null {
  if (!plugin.state.paired || plugin.forgottenDevice) return null;
  return `This device already syncs with ${plugin.state.data.serverUrl} as "${plugin.deviceName()}", so nothing was claimed. ` +
    "To add another device, choose Pair a new device here. To pair this one again, use Leave this server in obsync's settings first.";
}

/** Claimant side: paste the code or the link, claim the pairing, wait for approval. */
export class PairClaimModal extends Modal {
  private code = "";
  private codeField: TextComponent | null = null;
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
      this.codeField = text;
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
    tell(this.plugin, "still waiting for approval in the background. Approve this device on the other device, and pairing finishes by itself; the code works for ten minutes from when it was made.");
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
    const paired = alreadyPaired(this.plugin);
    if (paired !== null) {
      this.plugin.log("pairing role=claimant decision=refused reason=already_paired");
      fail(this.plugin, new Error(paired));
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
        fail(this.plugin, new Error(nested));
        this.close();
        return;
      }
      const { state, transport, assertCurrent } = this.plugin.captureSession();
      const parsed = decodePairingCode(this.code);
      const name = await this.plugin.nameThisDevice();
      const vault = await sealPairingVault(parsed.pairingSecret, parsed.pairingId, {
        name: this.app.vault.getName(), notes: this.app.vault.getMarkdownFiles().length,
      });
      // The code's own marker (read out of band, never from the network) says
      // the creator is v2-capable, so this device offers an ephemeral key. Its
      // absence means an older creator: pair the legacy way (see the warning).
      const keyExchange = isV2Secret(parsed.pairingSecret) ? await newPairingKeyExchange() : null;
      assertCurrent();
      if (this.closed) return;
      const credential = value(
        await transport.pairingClaim(parsed.pairingId, parsed.enrollToken, {
          name,
          platform: this.plugin.platformName(),
          app_version: this.plugin.manifest.version,
          vault,
          ...(keyExchange === null ? {} : { claimant_pub: keyExchange.publicKey }),
        }),
        "claiming the pairing",
      );
      assertCurrent();
      this.plugin.log("pairing role=claimant decision=claimed");
      // Claimed, the code opens nothing more: it leaves the screen, where a
      // screenshot of "Waiting for approval" still showed it (iPhone pass, 2026-09-26).
      this.code = "";
      this.codeField?.setValue("");
      // HELD, NOT KEPT (issue #153): the credential is this claim's until the
      // key it was approved for is kept with it.
      this.waiting = awaitApproval(this.plugin, this.app, {
        pairingId: parsed.pairingId,
        pairingSecret: hex(parsed.pairingSecret),
        deviceId: credential.device_id,
        deviceSecret: credential.device_secret,
        serverUrl: state.data.serverUrl,
        claimedAt: Date.now(),
      }, (text) => this.show(text), false, keyExchange);
      const done = this.waiting.done;
      if (this.closed) this.handOff();
      if (await done) this.close();
    } catch (error) {
      this.plugin.log(`pairing role=claimant decision=failed reason=${reasonOf(error)}`);
      const text = refusalText(error);
      this.show(text);
      tell(this.plugin, text);
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
  "What is lost is this device's sync identity: the server revokes its device id and credential, and this device forgets the server address, any custom request headers, its place in the change feed and its record of every synced file. No other device is touched.";
const LEAVE_AGAIN =
  "Pairing again — with this server or another — is a first sync for this device. Identical notes stay one note. If a local note differs from the server's note at the same path, both versions are kept for you to review.";
const LEAVE_UNKNOWN_DEVICE =
  "This server does not recognise this device: it was rebuilt or restored from a backup, or it is not the server this device paired with, so there is nothing there this device can revoke. You can leave on this device only: this device forgets the server and keeps every note, and the 24 words still open the same vault. If the server does still list this device, revoke it from the dashboard or from another device.";
const LEAVE_LAST_DEVICE =
  "This account has no registered vault recovery yet, or the server is too old to support it. Update both server and plugin while a device still syncs, then keep the setup token and 24-word recovery phrase before leaving. You can also pair another device first. Leaving on this device only keeps every note and leaves this credential active on the server; losing that final credential before recovery is registered can strand the account.";
const LEAVE_ONLY_HERE =
  "You can leave on this device only: this device forgets the server and its credential and keeps every note, and the 24 words still open the same vault. The server still lists this device until you remove it from another device's Devices list or the dashboard.";
/** `409 recovery_too_new` (1.1.5): the words the server's own hold stands for. */
const LEAVE_RECOVERY_TOO_NEW =
  "This is the only device syncing this vault, and its recovery key was set less than 7 days ago. For your safety the server keeps its last device until that key is 7 days old, so a stolen device credential cannot lock you out of your own server. Pair another device first, or leave on this device only: it forgets the server and keeps every note, and the server lists this device until you remove it.";
const LEAVING =
  "Leaving: stopping sync on this device, then asking the server to remove it. This takes a few seconds. You can close this window; a notice says when it is done.";
const LEFT_ONLY_HERE =
  "this device has left; your server still lists it until you remove it from another device's Devices list or the dashboard.";

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
      fail(this.plugin, error);
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
      fail(this.plugin, error);
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
      tell(this.plugin, "this device has changes your server never received, so it did not leave.");
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
      : reason === "recovery_too_new"
      ? [LEAVE_RECOVERY_TOO_NEW]
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
    tell(this.plugin,
      revoked
        ? "this device left the server; every note is still in this vault."
        : this.refusal === "last_device" || this.refusal === "recovery_too_new"
          ? "this device forgot the server, which still lists it; every note is still in this vault."
          : this.refusal === "bad_signature"
            ? "this device forgot the server, which did not recognise it; every note is still in this vault."
            : LEFT_ONLY_HERE,
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
      tell(this.plugin, "enter the new server's address first.");
      return;
    }
    try {
      await this.plugin.setServerUrl(typed);
    } catch (error) {
      fail(this.plugin, error);
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
            tell(this.plugin, `word ${wrong.join(", ")} does not match; check the list again.`);
            return;
          }
          this.plugin.state.data.recoveryPhrase = "confirmed";
          this.plugin.log("phrase decision=confirmed");
          void this.plugin.state.save().catch(() => {});
          tell(this.plugin, "recovery phrase confirmed.");
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
    catch (error) { fail(this.plugin, error); return; }
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
            tell(this.plugin, "vault key restored.");
            this.close();
          } catch (error) {
            fail(this.plugin, error);
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
          } catch (error) { fail(this.plugin, error); }
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
    // Above everything, until a registration of this device's own succeeds (1.1.5).
    if (this.plugin.recoveryMismatch) {
      new Setting(this.contentEl)
        .setName("Security warning")
        .setDesc(RECOVERY_MISMATCH)
        .addButton((button) => button.setButtonText("Open the guide").setCta().onClick(() => { this.plugin.openSetupGuide(); }));
    }
    this.nextStep();
    const data = this.plugin.state.data;
    const rows: [string, string, string?][] = [
      ["Server", data.serverUrl === "" ? "not configured" : data.serverUrl],
      // A person reads the name every other screen uses; the id, smaller
      // beneath it, is for support (iPhone pass, 2026-09-26).
      data.deviceId === null ? ["This device", "not paired"] : ["This device", this.plugin.deviceName(), data.deviceId],
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
    for (const [name, value, detail] of rows) {
      const row = table.createEl("tr");
      row.createEl("td", { text: name });
      const cell = row.createEl("td", { text: value });
      if (detail !== undefined) cell.createEl("div", { text: detail, cls: "setting-item-description" });
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
            void this.plugin.resumeNote(fileId).then(() => this.close(), (error: unknown) => fail(this.plugin, error));
          }),
        );
    }
    // What the notices said, including those a setting kept off the screen
    // and those a flood folded into "N more" (`notices.ts`).
    this.contentEl.createEl("h3", { text: "Recent" });
    drawRecent(this.contentEl, this.plugin, () => this.close(), RECENT_SHOWN);
    if (this.plugin.notices.recent().length > RECENT_SHOWN) {
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Show all").onClick(() => {
        this.close();
        this.plugin.showRecent();
      }));
    }
  }

  /** The state that needs doing something about, what it is, and the button that does it. */
  private nextStep(): void {
    // A crash left this device with no keys (issue #230): what Settings says, and the one way back.
    if (this.plugin.state.keysLost) {
      new Setting(this.contentEl)
        .setName("What to do")
        .setDesc(KEYS_LOST)
        .addButton((button) => button.setButtonText("Pair this device").setCta().onClick(() => {
          this.close();
          new PairClaimModal(this.app, this.plugin).open();
        }));
      return;
    }
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
    const pair = status.code === "credential_rejected";
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

  /** On screen now: between its open and its close. */
  isShown(): boolean {
    return this.unwatch !== null;
  }

  forward(): void {
    forward(this, () => this.render());
  }

  override onClose(): void {
    this.unwatch?.();
    this.unwatch = null;
    this.contentEl.empty();
  }
}

/**
 * A DIALOG ASKED FOR AGAIN WHILE IT SHOWS (#269): the palette, a hotkey or a
 * notice opened a second one over the first. The one showing comes in front
 * of any other dialog instead -- its keys first, so Escape closes it first --
 * and is drawn afresh.
 */
function forward(modal: Modal, draw: () => void): void {
  modal.app.keymap.popScope(modal.scope);
  modal.app.keymap.pushScope(modal.scope);
  modal.containerEl.ownerDocument.body.appendChild(modal.containerEl);
  draw();
}

/** How many of the newest notices Show sync status lists; Show all lists every one kept. */
const RECENT_SHOWN = 10;

/** Recent notices, newest first, with the time each came and a button for each note it names. */
function drawRecent(el: HTMLElement, plugin: ObsyncPlugin, close: () => void, limit: number): void {
  const entries = plugin.notices.recent();
  if (entries.length === 0) {
    new Setting(el).setDesc("Nothing since obsync started.");
    return;
  }
  for (const entry of entries.slice(0, limit)) {
    const setting = new Setting(el).setName(entry.text).setDesc(clock(new Date(entry.at)));
    const names = titles(entry.paths);
    entry.paths.slice(0, 3).forEach((path, index) => setting.addButton((button) => button
      .setButtonText(entry.paths.length === 1 ? "Open" : `Open ${names[index] ?? ""}`)
      .onClick(() => {
        close();
        plugin.openNote(path);
      })));
  }
}

/** Show recent sync activity: every notice Recent keeps, from the palette and Settings. */
export class RecentModal extends Modal {
  private shown = false;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.shown = true;
    this.setTitle("Recent sync activity");
    this.draw();
  }

  isShown(): boolean {
    return this.shown;
  }

  forward(): void {
    forward(this, () => this.draw());
  }

  private draw(): void {
    this.contentEl.empty();
    drawRecent(this.contentEl, this.plugin, () => this.close(), RECENT_MAX);
  }

  override onClose(): void {
    this.shown = false;
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
                  this.plugin.notices.show({ kind: "confirm", text: "fetched {notes}.", paths: [entry.path] });
                  this.render();
                } catch (error) {
                  fail(this.plugin, error);
                }
              })();
            }),
          );
      }
    }
  }
}
