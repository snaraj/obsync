/**
 * The settings tab, as one list of rows Obsidian renders from
 * `getSettingDefinitions()`. That is also what makes every row searchable
 * from Settings, and why the floor is Obsidian 1.13.0: the declarative tab
 * arrived there, and the vendored API declaration is pinned at exactly that
 * version so the compiler refuses any member the floor does not have.
 *
 * Nothing here can turn a security property off. There is no "encrypt"
 * toggle, no "sign requests" toggle and no "verify" toggle, because those
 * are not settings (AGENTS.md requirement 4); the settings are the server
 * address, the edge headers an access-controlled deployment requires, the
 * device-local folder selection, and the two ceilings, which are device
 * policy and are shown with their consequence.
 *
 * FIRST RUN. A folder selection typed but not yet saved is applied by
 * "Set up" and "Pair this device" before either proceeds, so what the reader
 * sees on the screen is what the device syncs. Before pairing there is no
 * transfer to wait for, so this costs nothing and removes the one step a
 * stranger skipped in validation. A bare host name in Server URL is
 * completed with `https://`, the only scheme mobile accepts. The account
 * name is not asked for: it is a dashboard label and every server holds one
 * account.
 *
 * PROVIDER NEUTRALITY. No ingress, tunnel or access provider is named here
 * or anywhere under `plugin/src`; the edge headers are a name/value list the
 * deployer fills in.
 *
 * PLATFORM. Mobile Obsidian refuses plain HTTP, so a non-HTTPS URL is
 * refused on mobile at entry rather than failing on every request. The
 * ceilings default per platform (`policy.ts`) and their descriptions state
 * why: desktop streams a file in 8 MiB windows through Node's filesystem,
 * mobile reads whole files through the vault adapter.
 */

import { FORGOTTEN_DEVICE } from "../accountRecovery";
import { Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type { App, ButtonComponent, SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type ObsyncPlugin from "../main";
import { formatBytes, parseBytes, type Policy } from "../policy";
import { parseSyncFolders } from "../syncScope";
import { refusalStatus, refusalText } from "../sync/engine";
import type { EdgeHeader } from "../state";
import { HEADER_NAME, ownHeader, type DeviceRecord } from "../transport";
import { VaultPathError } from "../vaultPath";
import { ConfirmModal, LeaveServerModal, PairClaimModal, PairCreateModal, RECOVERY_UNCONFIRMED, RecoveryPhraseModal, VaultKeyModal, confirmFirst, literal, secretText } from "./modals";

/** The dashboard's label for the one account a server holds. */
export const ACCOUNT_NAME = "obsync";

/** What a copied vault, or one whose folder was renamed outside Obsidian, is told (issue #168). */
export const COPIED_VAULT = "This vault is a copy, or its folder was renamed. It will not sync as the original. Pair it as a new device, or start fresh.";

/**
 * The project's setup guide. A fixed address in the source, never one a server
 * supplies, and opened only when the person presses for it: the plugin itself
 * sends nothing there.
 */
export const SETUP_GUIDE_URL = "https://snaraj.github.io/obsync/setup/";

/** One row: a name, a description, when it shows, and what it draws. */
interface Row {
  name: string;
  desc?: string | (() => string);
  visible?: () => boolean;
  render?: (setting: Setting) => void;
}

interface Group {
  heading: string;
  visible?: () => boolean;
  rows: Row[];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * `https://` is the default, not a requirement: a bare host is completed,
 * never refused. Only the ORIGIN is kept -- scheme and host lower-cased, the
 * port, nothing after it. obsync is served at the root of its address, and an
 * address copied from a browser kept its `/readyz` or `/login?token=…`: every
 * request then answered 404 "no route", and a sign-in token sat in this
 * vault's settings (2026-09-24 battery, S08; #137). An address the platform
 * cannot parse is kept as typed, for the refusal and the request to explain.
 */
export function normalizeServerUrl(value: string): string {
  const typed = value.trim().replace(/\/+$/, "");
  if (typed === "") return "";
  const url = SCHEME.test(typed) ? typed : "https://" + typed;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? url : origin;
  } catch {
    return url;
  }
}

/** Plain HTTP that never leaves this computer: the README's one-computer trial. */
const LOOPBACK = /^http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * Why this device may not adopt a normalised address, or `null`; an empty
 * address is "not configured", not a refusal. The row below and
 * `ObsyncPlugin.setServerUrl` share this rule.
 *
 * PLAIN HTTP IS REFUSED ON EVERY PLATFORM, loopback on a desktop excepted.
 * Mobile Obsidian refuses it outright. A desktop used to accept it, and a
 * plain HTTP address in front of a terminator that redirects to HTTPS worked,
 * silently: the setup token -- also the dashboard's recovery sign-in -- and
 * every later request crossed the network in the clear before the redirect
 * (2026-09-24 battery, S08; #136). `normalizeServerUrl` lower-cases the
 * scheme, so the `Https://` a phone keyboard capitalises is the address it means.
 */
export function serverUrlRefusal(url: string, isMobile: boolean): string | null {
  if (url === "" || url.startsWith("https://")) return null;
  if (isMobile) return "Mobile Obsidian only reaches HTTPS servers.";
  return LOOPBACK.test(url)
    ? null
    : "Use your server's https address. Plain HTTP would send the setup token and every request unencrypted; it is accepted only for this computer itself (localhost or 127.0.0.1).";
}

/** The form every edge-header refusal ends with. No provider is named (`PROVIDER NEUTRALITY` above). */
const HEADER_FORM = "Write one header per line as Name: value, for example X-Access-Id: 1234.";
const QUOTES = "\"'“”‘’";
/** What a header copied out of a command line carries around it: `-H`/`--header`, and a trailing `\`. */
const FLAG = /^(?:-H|--header)(?=[\s=\"'“”‘’])[\s=]*/;
const CONTINUATION = /\s+\\$/;

/** One character, as a person can find it again in what they typed. */
function character(char: string): string {
  const code = `U+${(char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`;
  if ("“”‘’".includes(char)) return `a curly quote (${char}). Use straight quotes, or none`;
  if (/[\s\p{C}]/u.test(char)) return `an invisible character (${code}). Delete it and type the line again`;
  return `"${char}" (${code}), and a header can carry only plain ASCII letters, digits and punctuation. Retype it`;
}

/**
 * The edge headers as typed, or the first line that cannot be sent and why
 * (issue #183). A line copied out of a command line -- `-H "Name: value"`,
 * `--header='Name: value'`, a trailing `\` -- or wrapped in quotes, straight
 * or curly, is unwrapped, and `trimmed` says so. Anything else that is not
 * `Name: value` with an HTTP token for a name and plain printable ASCII for a
 * value is refused, naming the line and the character: saved as it was, the
 * platform dropped such a header or sent curly quotes as the value, and the
 * proxy turned every request away with nothing in obsync pointing here.
 * Names obsync sets itself are refused too (`ownHeader`).
 */
export function parseEdgeHeaders(text: string): { headers: EdgeHeader[]; trimmed: string[] } | { refusal: string; reason: string } {
  const headers: EdgeHeader[] = [];
  const trimmed: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, typed] of lines.entries()) {
    const where = `line ${index + 1}`;
    let line = typed.trim();
    if (line === "") continue;
    let offset = typed.indexOf(line);
    const cut: string[] = [];
    const flag = FLAG.exec(line);
    if (flag !== null) {
      cut.push(`a pasted ${flag[0].trim().replace(/=$/, "")}`);
      offset += flag[0].length;
      line = line.slice(flag[0].length);
    }
    if (CONTINUATION.test(line)) {
      cut.push("a trailing \\");
      line = line.replace(CONTINUATION, "");
    }
    if (line.length >= 2 && QUOTES.includes(line[0] as string) && QUOTES.includes(line[line.length - 1] as string)) {
      cut.push("quotes");
      offset += 1;
      line = line.slice(1, -1);
    }
    if (cut.length !== 0) trimmed.push(`Trimmed ${cut.join(" and ")} from ${where}.`);
    const odd = /[^\t\x20-\x7e]/u.exec(line);
    if (odd !== null) {
      const at = Array.from(typed.slice(0, offset + odd.index)).length + 1;
      return { refusal: `${where}, character ${at}, is ${character(odd[0])}.`, reason: "not_ascii" };
    }
    const colon = line.indexOf(":");
    if (colon < 0) return { refusal: `${where} has no colon. ${HEADER_FORM}`, reason: "no_colon" };
    const name = line.slice(0, colon).trim(), value = line.slice(colon + 1).trim();
    if (name === "") return { refusal: `${where} has no header name before the colon. ${HEADER_FORM}`, reason: "no_name" };
    const bad = Array.from(name).find((char) => !HEADER_NAME.test(char));
    if (bad !== undefined) {
      const shown = bad === " " ? "a space" : bad === "\t" ? "a tab" : QUOTES.includes(bad) ? `a quote (${bad})` : `"${bad}"`;
      return { refusal: `${where}: a header name cannot contain ${shown}. ${HEADER_FORM}`, reason: "bad_name" };
    }
    if (ownHeader(name)) return { refusal: `${where}: obsync sets ${name} itself, so it cannot be a custom request header. Remove that line.`, reason: "own_header" };
    if (value === "") return { refusal: `${where} has no value after the colon. ${HEADER_FORM}`, reason: "no_value" };
    headers.push({ name, value });
  }
  return { headers, trimmed };
}

/**
 * Every refusal of the folder rule, in words. The refusal's code goes to the
 * log and never to the person: "refused: not a vault path (hidden_segment)"
 * was right and read as jargon (issue #150, S30f).
 */
const SELECTION_REFUSED =
  "That selection cannot be saved: each line must be a folder inside this vault, such as Notes or Projects/2026. Folders whose names start with a dot are hidden and never synced.";

function headerLines(headers: EdgeHeader[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(desc: Row["desc"]): string | undefined {
  return typeof desc === "function" ? desc() : desc;
}

export class ObsyncSettingTab extends PluginSettingTab {
  // Drafts live on the tab, not in closures, so a re-render -- the device
  // list arriving, a save finishing -- keeps what was typed. Every field is
  // prefixed: Obsidian sets `name` and `id` on the tab at runtime, the API
  // declaration lists neither, and a field initializer runs AFTER the base
  // constructor, so a draft called `name` silently erased the tab's title
  // and crashed the settings search (found on a real 1.13.4, not by tsc).
  private draftScope: { selected: boolean; text: string } | null = null;
  private draftToken = "";
  private draftName: string | null = null;
  private deviceList: DeviceRecord[] | null = null;
  private deviceListError: string | null = null;
  private readingDevices = false;
  private draftUrl: string | null = null;
  /** Stops the Connection row following the status, when the tab closes. */
  private unwatch: (() => void) | null = null;
  private draftHeaders: string | null = null;

  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app, plugin);
  }

  /** Called by the app on every draw and once at registration, to index the rows for search. No side effects. */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return this.groups().map((group): SettingDefinitionItem => ({
      type: "group",
      heading: group.heading,
      visible: group.visible,
      items: group.rows.map((row): SettingGroupItem => {
        const base = { name: row.name, desc: text(row.desc), visible: row.visible };
        const render = row.render;
        return render ? { ...base, render: (setting) => { render(setting); } } : base;
      }),
    }));
  }

  override hide(): void {
    // Closing Settings is leaving the field: what was typed is adopted, not lost.
    this.adoptServerUrl();
    this.adoptEdgeHeaders();
    super.hide();
    this.unwatch?.();
    this.unwatch = null;
    this.draftScope = null;
    this.draftToken = "";
    this.draftName = null;
    this.deviceList = null;
    this.deviceListError = null;
  }

  private groups(): Group[] {
    const enrolled = (): boolean => this.plugin.state.data.deviceId !== null;
    return [
      { heading: "Get started", rows: [this.setupGuide()] },
      { heading: "Server", rows: [this.serverUrl(), this.edgeHeaders(), this.connection(), this.updateAvailable()] },
      { heading: "Sync folders on this device", rows: [this.folderSelection(), this.selectedFolders(), this.saveScope(), this.heldDeletions()] },
      { heading: "This device", rows: [this.pairing(), this.setup(), this.deviceName(enrolled), this.perFile(enrolled), this.total(enrolled), this.saveDevice(enrolled), this.leaving(enrolled)] },
      { heading: "Devices", visible: () => this.plugin.state.paired, rows: this.deviceRows() },
      { heading: "Vault key", rows: [this.recoveryPhrase()] },
    ];
  }

  // ---- Get started ---------------------------------------------------------

  /** First on every platform, because a stranger opens this tab before anything else works. */
  private setupGuide(): Row {
    return {
      name: "Setup guide",
      desc: "How to run your own server, choose how your devices reach it, and pair each device, step by step. Opens in your browser; the plugin sends nothing.",
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Open the guide").onClick(() => { this.plugin.openSetupGuide(); }));
      },
    };
  }

  // ---- Server --------------------------------------------------------------

  private serverUrl(): Row {
    return {
      name: "Server URL",
      desc: "Where this device reaches your own server, port included when it is not 443. HTTPS is assumed when you type a host name alone, and required on mobile.",
      render: (setting) => {
        setting.addText((field) => {
          field
            .setPlaceholder("sync.example.org")
            .setValue(this.draftUrl ?? this.plugin.state.data.serverUrl)
            .onChange((value) => { this.draftUrl = value; });
          // Adopted when the field is left (or Settings closes), never per
          // keystroke: every prefix used to be normalised and SAVED, so typing
          // a plain HTTP address one key at a time left a half-typed prefix of
          // it stored once the address itself was refused, a loopback address
          // raised a refusal halfway through, and a paired device's requests
          // went to whatever prefix was current (2026-09-24, verifying #136).
          field.inputEl.addEventListener("change", () => { this.adoptServerUrl(); });
          literal(field.inputEl, "url");
        });
      },
    };
  }

  /** What was typed into Server URL, normalised, refused or adopted once; nothing when nothing was typed. */
  private adoptServerUrl(): void {
    if (this.draftUrl === null) return;
    const url = normalizeServerUrl(this.draftUrl);
    this.draftUrl = null;
    const refusal = serverUrlRefusal(url, this.plugin.isMobile);
    if (refusal !== null) {
      new Notice(refusal);
      return;
    }
    this.plugin.state.data.serverUrl = url;
    // State reports persistence failure and stops sync through its host hook.
    void this.plugin.state.save().catch(() => {});
    // A request waiting to retry goes to the new address now, not after its pause (#186).
    this.plugin.wake("address");
  }

  private edgeHeaders(): Row {
    return {
      name: "Custom request headers",
      desc: "Sent with every request, so an access-controlled proxy or tunnel in front of your server lets this device through. One header per line, as Name: value; a header pasted from a command line is trimmed to that form. Leave empty otherwise.",
      render: (setting) => {
        setting.setClass("obsync-lines").addTextArea((area) => {
          area
            .setValue(this.draftHeaders ?? headerLines(this.plugin.state.data.edgeHeaders))
            .onChange((value) => { this.draftHeaders = value; });
          // Saved when the field is left, as Server URL is, never per
          // keystroke: every prefix with a colon in it used to be stored on
          // the way (issue #183, S69).
          area.inputEl.addEventListener("change", () => {
            if (this.adoptEdgeHeaders()) area.setValue(headerLines(this.plugin.state.data.edgeHeaders));
          });
          literal(area.inputEl);
        });
      },
    };
  }

  /** What was typed into the edge headers, refused out loud or saved once; `true` when saved. */
  private adoptEdgeHeaders(): boolean {
    if (this.draftHeaders === null) return false;
    const parsed = parseEdgeHeaders(this.draftHeaders);
    this.draftHeaders = null;
    if ("refusal" in parsed) {
      this.plugin.log(`edge decision=refused reason=${parsed.reason}`);
      new Notice(`Custom request headers were not saved: ${parsed.refusal}`, 12000);
      return false;
    }
    this.plugin.state.data.edgeHeaders = parsed.headers;
    this.plugin.log(`edge decision=kept headers=${parsed.headers.length} trimmed=${parsed.trimmed.length}`);
    if (parsed.trimmed.length !== 0) new Notice(["Custom request headers saved.", ...parsed.trimmed].join(" "), 8000);
    // State reports persistence failure and stops sync through its host hook.
    void this.plugin.state.save().catch(() => {});
    return true;
  }

  /**
   * The Connection row, and Check (#182).
   *
   * THE ROW SAYS WHAT THE STATUS BAR SAYS, while Settings is open: it follows
   * every status change, where it used to read `idle` for as long as the tab
   * had been open under a bar reading `offline — retrying`.
   *
   * CHECK ANSWERS AT ONCE AND WITHIN SECONDS. It reads "Checking…" as it is
   * pressed, asks with a person's patience -- two attempts inside ten seconds
   * (`Patience`) -- rather than the background's minute and a half, and says
   * the answer in words: against a server that was off it was silent for 103 s
   * and then showed `0 unreachable: network=...`.
   */
  private connection(): Row {
    return {
      name: "Connection",
      desc: () => this.plugin.statusText(),
      render: (setting) => {
        let checking = false;
        const describe = (): void => { if (!checking) setting.setDesc(this.plugin.statusText()); };
        this.unwatch?.();
        this.unwatch = this.plugin.onStatusChange(describe);
        setting
          .addButton((button) => button.setButtonText("Check").onClick(() => {
            if (this.plugin.state.data.serverUrl === "") {
              new Notice("Type your server's address in Server URL first.");
              return;
            }
            checking = true;
            button.setDisabled(true);
            setting.setDesc("Checking…");
            // Before setup there is no device to sign with, and the signed
            // read answered "not paired" without asking the server anything:
            // the one moment a person most needs to know whether the address
            // works (2026-09-24 battery, S08; #137). The plugin manifest is the
            // route that needs no credential.
            const check = this.plugin.state.paired
              ? this.plugin.transport.account({ interactive: true }).then((account) => `Reached "${account.name}", ${account.device_count} device(s).`)
              : this.plugin.transport.pluginManifest({ interactive: true }).then(() => "Reached your obsync server. Next: Setup or recover on your first device, or Pair this device.");
            // Nothing answering is said with the address and what to try: a
            // Check is how a wrong address or a switched-off server is found.
            const url = this.plugin.state.data.serverUrl;
            const unanswered = (error: unknown): string =>
              refusalStatus(error)?.kind === "offline"
                ? `Nothing answered at ${url}. Check the Server URL, port included; if it has worked before, your server may be switched off or out of this network's reach.`
                : refusalText(error);
            void check
              .then((text) => { new Notice(text); }, (error: unknown) => { new Notice(unanswered(error), 8000); })
              .finally(() => {
                checking = false;
                button.setDisabled(false);
                describe();
              });
          }))
          .addButton((button) => button.setButtonText("Open dashboard").onClick(() => { void this.plugin.openDashboard(); }));
      },
    };
  }

  /**
   * Deletions held back from the other devices: a startup pass that could no
   * longer see its notes (issue #123), or many deleted at once (issue #162).
   * The row is absent whenever there are none, so it is only ever seen by a
   * user who has something to decide. Delete everywhere is destructive
   * because it removes those notes from every device; Restore here puts them
   * back on this one, from the server.
   */
  private heldDeletions(): Row {
    return {
      name: "Deletions held back",
      desc: () => this.plugin.heldDeletionLine() ?? "",
      visible: () => this.plugin.heldDeletionLine() !== null,
      render: (setting) => {
        setting.addButton((button) =>
          button.setButtonText("Delete everywhere").setDestructive().onClick(() => {
            this.plugin.confirmHeldDeletions();
            new Notice("obsync: the deletions were published. Your other devices will remove those notes.", 8000);
          }));
        setting.addButton((button) =>
          button.setButtonText("Restore here").onClick(() => {
            void this.plugin.restoreHeldDeletions();
          }));
      },
    };
  }

  /**
   * What to do when the server runs a newer plugin. obsync never installs
   * code the server serves (`docs/architecture.md` 6.3), so this row is the
   * whole update path: it names the plugin and both versions, and its button
   * opens the page that does install -- Obsidian's own Community plugins --
   * because reaching it by hand is several taps deep on a phone.
   */
  private updateAvailable(): Row {
    return {
      name: "Update available",
      desc: () => this.plugin.updateLine() ?? "",
      visible: () => this.plugin.updateLine() !== null,
      render: (setting) => {
        setting.addButton((button) =>
          button.setButtonText("Open Community plugins").setCta().onClick(() => {
            this.plugin.openPluginManager();
          }));
      },
    };
  }

  // ---- Sync folders --------------------------------------------------------

  private scopeDraft(): { selected: boolean; text: string } {
    if (this.draftScope === null) {
      const folders = this.plugin.state.data.syncFolders;
      this.draftScope = { selected: folders !== undefined, text: folders?.join("\n") ?? "" };
    }
    return this.draftScope;
  }

  /**
   * The host's own path normalisation, on what a PERSON typed here: a leading
   * or trailing slash, a doubled separator and a backslash are typos the host
   * canonicalises, not refusals worth discarding the whole selection for.
   * Blank lines are dropped before normalising so nothing empty is ever
   * handed to it. A path that arrives from ANOTHER DEVICE is never
   * normalised -- `vaultPath` refuses those shapes outright -- and whatever
   * comes back here still goes through `parseSyncFolders`, so `/`, `..` and
   * every hidden segment stay refused.
   */
  private scopeValue(): string[] | undefined {
    const draft = this.scopeDraft();
    return draft.selected
      ? draft.text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => normalizePath(line))
      : undefined;
  }

  private scopeChanged(): boolean {
    return JSON.stringify(this.scopeValue()) !== JSON.stringify(this.plugin.state.data.syncFolders);
  }

  /**
   * Save what was typed, checked against this vault first, and return what
   * the person should be told beyond "saved" -- or `null` when they kept a
   * folder the vault does not have out of it (issue #150).
   *
   * THE FOLDER RULE FIRST, so a refused line is never asked about. THEN THE
   * VAULT. A folder Obsidian's index holds under exactly the typed name is
   * saved as typed. One the host finds under another capitalisation -- a
   * volume that folds case, where `notes` IS `Notes` -- is saved the way the
   * vault spells it, and the person is told: saved as typed, the desktop scan
   * reached that folder under the typed name and published every note in it
   * again as a new file with older text (S30a). A volume that keeps the two
   * apart finds nothing, and a folder the vault does not have is asked about,
   * Cancel first: the selection never covers a folder the person did not
   * name without their click.
   */
  private async saveScopeDraft(): Promise<string[] | "withdrawn" | null> {
    const typed = this.scopeValue();
    const told: string[] = [];
    let folders = typed;
    if (typed !== undefined) {
      let selection: string[];
      try {
        selection = parseSyncFolders(typed);
      } catch (error) {
        this.plugin.log(`scope decision=refused reason=${error instanceof VaultPathError ? error.refusal : "invalid_selection"}`);
        throw new Error(SELECTION_REFUSED);
      }
      const shown = await Promise.all(selection.map((folder) => this.vaultFolder(folder)));
      const missing = selection.filter((_, index) => shown[index] === null);
      if (missing.length !== 0) {
        const kept = await confirmFirst(
          this.app,
          `${missing.map((folder) => `"${folder}"`).join(", ")} ${missing.length === 1 ? "is not a folder" : "are not folders"} in this vault. Save anyway?`,
          "Nothing syncs from a selected folder until one with exactly that name exists in this vault. Cancel to correct it.",
          "Save anyway",
        );
        this.plugin.log(`scope decision=${kept ? "confirmed" : "declined"} reason=not_a_folder folders=${missing.length}`);
        if (!kept) return null;
      }
      selection.forEach((folder, index) => {
        const spelled = shown[index];
        if (spelled && spelled !== folder) told.push(`"${folder}" is saved as "${spelled}", the way this vault spells it.`);
      });
      if (told.length !== 0) this.plugin.log(`scope decision=recased reason=vault_spelling folders=${told.length}`);
      folders = parseSyncFolders(selection.map((folder, index) => shown[index] ?? folder));
      if (folders.length === 0) told.push("No folder is selected, so nothing syncs on this device.");
    }
    const outcome = await this.plugin.saveSyncFolders(folders);
    this.draftScope = null;
    return outcome === "withdrawn" ? outcome : told;
  }

  /**
   * The folder as this vault spells it, or `null` when the vault holds no
   * folder by that name. The index answers a name it holds exactly, accents
   * included; only a name it does not hold is asked of the host's own lookup
   * (`main.ts`, `spelling`), and what that finds must be a folder the index
   * holds.
   */
  private async vaultFolder(folder: string): Promise<string | null> {
    const vault = this.app.vault;
    if (vault.getFolderByPath(folder) !== null) return folder;
    const shown = await this.plugin.host.spelling(folder).catch(() => null);
    return shown !== null && vault.getFolderByPath(shown) !== null ? shown : null;
  }

  private folderSelection(): Row {
    return {
      name: "Folder selection",
      desc: () => {
        const folders = this.plugin.state.data.syncFolders;
        const now = folders === undefined ? "the whole vault, except hidden and symlinked paths" : folders.length === 0 ? "nothing" : folders.join(", ");
        return `Syncing now: ${now}. Choose folders before pairing when the vault also holds code or private files; other devices cannot widen this.`;
      },
      render: (setting) => {
        setting.addDropdown((dropdown) => dropdown
          .addOption("whole", "Whole vault")
          .addOption("selected", "Selected folders only")
          .setValue(this.scopeDraft().selected ? "selected" : "whole")
          .onChange((value) => { this.scopeDraft().selected = value === "selected"; }));
      },
    };
  }

  private selectedFolders(): Row {
    return {
      name: "Selected folders",
      desc: "One folder per line, relative to the vault root. Files keep their folder names on every device.",
      render: (setting) => {
        // A full-width box below the name on a phone (`styles.css`, issue #210).
        setting.setClass("obsync-lines").addTextArea((area) => {
          // Folder names match exactly: a capital a phone keyboard adds is another folder.
          literal(area.inputEl);
          area.setPlaceholder("Notes").setValue(this.scopeDraft().text).onChange((value) => { this.scopeDraft().text = value; });
        });
      },
    };
  }

  /**
   * Save, and while the old selection's transfers stop, say which (issue
   * #185): the button names the upload it is cutting at its next chunk, and a
   * Cancel beside it keeps the selection there was. The choice itself is kept
   * the moment Save is pressed (`saveSyncFolders`).
   */
  private saveScope(): Row {
    return {
      name: "Save on this device",
      desc: "Stops any upload at its next chunk, then rescans; a stopped upload resumes where it left off. Adding a folder also brings in what the server already holds under it, which can take a while on a large vault; removed folders keep their local files and their history.",
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Save").onClick(() => {
          button.setDisabled(true).setButtonText(this.plugin.scopeWaitText());
          let cancel: ButtonComponent | undefined;
          setting.addButton((made) => {
            cancel = made;
            made.setButtonText("Cancel").onClick(() => {
              made.setDisabled(true);
              this.plugin.cancelScopeChange();
            });
          });
          void this.saveScopeDraft().then((told) => {
            if (told === null) return;
            new Notice(told === "withdrawn"
              ? "Folder selection unchanged: sync goes on with the folders it had."
              : ["Folder selection saved on this device.", ...told].join(" "));
            this.update();
          }).catch((error: unknown) => {
            new Notice(message(error), 10000);
          }).finally(() => {
            // Obsidian components are thenable. Never return one to a Promise.
            button.setDisabled(false).setButtonText("Save");
            cancel?.buttonEl.remove();
          });
        }));
      },
    };
  }

  // ---- This device ---------------------------------------------------------

  private pairing(): Row {
    return {
      name: "Pairing",
      desc: () => {
        const data = this.plugin.state.data;
        if (this.plugin.forgottenDevice) return FORGOTTEN_DEVICE;
        if (this.plugin.state.copied) return COPIED_VAULT;
        const waiting = this.plugin.waiting;
        if (waiting) {
          return `Pairing: waiting for approval on the other device${waiting.code === null ? "" : `, whose prompt shows the code ${waiting.code}`}.`;
        }
        if (data.deviceId === null) {
          return "Not paired yet. On a device that already syncs this vault, choose Pair a new device, then paste its code here with Pair this device. For a new server, use Setup or recover below.";
        }
        if (this.plugin.state.paired) return `Paired as ${this.plugin.deviceName()} (${this.plugin.platformName()}), device ${data.deviceId}.`;
        return "This device's last pairing did not finish, so it holds no vault key. Pair it again: on a device that already syncs, choose Pair a new device, then paste its code here with Pair this device. Do not repeat server setup.";
      },
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Pair this device").onClick(() => { void this.pairThisDevice(); }));
        if (this.plugin.state.copied) setting.addButton((button) => button.setButtonText("Start fresh").onClick(() => { this.startFresh(); }));
        else {
          setting.addButton((button) => button
            .setButtonText("Pair a new device")
            .setDisabled(!this.plugin.state.paired)
            .onClick(() => { new PairCreateModal(this.app, this.plugin).open(); }));
        }
      },
    };
  }

  /**
   * A copy started over as a vault that never synced (issue #168): it already
   * holds nothing of the original's identity, and the copied server address
   * goes too. The save gives it an installation of its own.
   */
  private startFresh(): void {
    this.plugin.state.data.serverUrl = "";
    this.plugin.log("state decision=started_fresh reason=copied_vault");
    // State reports persistence failure and stops sync through its host hook.
    void this.plugin.state.save().then(() => {
      new Notice("obsync: this vault starts fresh. It is not paired with any server, and your notes are unchanged. Set it up or pair it here when you are ready.");
      this.left();
    }, () => {});
  }

  private setup(): Row {
    return {
      name: "Setup or recover",
      desc: "Paste the setup token your server wrote at first boot. For an empty server, it creates the account. For an existing account with no syncing device, restore this vault’s 24-word recovery phrase first, then use the token to re-enrol. A retained vault key works too. Recovery must have been registered by an updated device before its last credential was lost. Keep both the token and phrase private.",
      visible: () => this.plugin.state.data.deviceId === null || this.plugin.forgottenDevice,
      render: (setting) => {
        secretText(setting, "Setup token", this.draftToken, (value) => { this.draftToken = value.trim(); });
        setting.addButton((button) => button.setButtonText("Set up or recover").setCta().onClick(() => { void this.setUp(); }));
      },
    };
  }

  /** A typed, unsaved folder selection is applied first: the screen is what the device syncs. */
  private async applyScopeDraft(): Promise<boolean> {
    if (!this.scopeChanged()) return true;
    try {
      const told = await this.saveScopeDraft();
      if (told === null || told === "withdrawn") return false;
      if (told.length !== 0) new Notice(told.join(" "));
      return true;
    } catch (error) {
      new Notice(message(error), 10000);
      return false;
    }
  }

  /**
   * The token is used once and then gone from the tab, success or failure
   * (issue #169): a refused token left in plain text reached the screenshots
   * people took to ask for help, and the token is also the dashboard's
   * recovery sign-in. A retry is a fresh paste.
   */
  private async setUp(): Promise<void> {
    if (!(await this.applyScopeDraft())) return;
    const token = this.draftToken;
    this.draftToken = "";
    await this.plugin.setUpAccount(token, ACCOUNT_NAME);
    if (this.plugin.state.data.deviceId !== null) this.left(); // Re-enrollment replaces the identity behind the device list.
    else this.update();
  }

  private async pairThisDevice(): Promise<void> {
    if (!(await this.applyScopeDraft())) return;
    new PairClaimModal(this.app, this.plugin, undefined, () => { this.left(); }).open();
  }

  private deviceName(visible: () => boolean): Row {
    return {
      name: "Name",
      desc: "How this device appears in the dashboard's device list and in another device's conflict copies.",
      visible,
      render: (setting) => {
        setting.addText((field) => field
          .setValue(this.draftName ?? this.plugin.deviceName())
          .onChange((value) => { this.draftName = value; }));
      },
    };
  }

  private perFile(visible: () => boolean): Row {
    const desc = (): string => {
      const policy = this.plugin.state.data.policy;
      return this.plugin.isMobile
        ? `Mobile Obsidian reads and writes whole files in memory, so a ceiling is what keeps a large attachment from ending the app. Files above it stay on the server and appear under "Show remote-only files", to fetch one at a time. Currently ${formatBytes(policy.perFileMaxBytes)}.`
        : `Desktop streams files in 8 MiB windows, so there is no practical ceiling; 0 means unlimited. Currently ${formatBytes(policy.perFileMaxBytes)}.`;
    };
    return {
      name: "Largest file to download",
      desc,
      visible,
      render: (setting) => { this.ceiling(setting, "Largest file to download", "perFileMaxBytes", desc); },
    };
  }

  private total(visible: () => boolean): Row {
    const desc = (): string => {
      const policy = this.plugin.state.data.policy;
      return `The vault may be larger than this device. Above this total, new files stay remote-only; 0 means unlimited. Currently ${formatBytes(policy.totalBudgetBytes)}, holding ${formatBytes(this.plugin.state.localBytes())}.`;
    };
    return {
      name: "Total to keep on this device",
      desc,
      visible,
      render: (setting) => { this.ceiling(setting, "Total to keep on this device", "totalBudgetBytes", desc); },
    };
  }

  /**
   * One ceiling field, decided when the field is LEFT (the input's `change`
   * event) and saved then -- never per keystroke. A value kept per keystroke
   * was kept on its way: `1 MX` passed through `1`, a one-byte ceiling that
   * made every new note remote-only, and nothing was saved until some other
   * write, so a restart read "unlimited" again (issue #150, S31; 2026-09-24
   * verification). A value that does not read as a size is refused OUT LOUD,
   * naming the forms that are read, and the field goes back to what is kept.
   */
  private ceiling(setting: Setting, row: string, key: keyof Policy, describe: () => string): void {
    let typed = formatBytes(this.plugin.state.data.policy[key]);
    setting.addText((field) => {
      field.setValue(typed).onChange((value) => { typed = value; });
      field.inputEl.addEventListener("change", () => {
        const policy = this.plugin.state.data.policy;
        const bytes = parseBytes(typed);
        if (bytes === null) {
          this.plugin.log(`policy decision=refused reason=unreadable_size field=${key}`);
          new Notice(`${row}: "${typed.trim()}" is not a size. Type a number with B, KB, MB, GB, KiB, MiB or GiB, or 0 for unlimited.`);
          typed = formatBytes(policy[key]);
          field.setValue(typed);
          return;
        }
        if (bytes === policy[key]) return;
        policy[key] = bytes;
        this.plugin.log(`policy decision=kept field=${key} bytes=${bytes}`);
        setting.setDesc(describe());
        void this.plugin.state.save().catch((error: unknown) => { new Notice(message(error), 8000); });
      });
    });
  }

  private saveDevice(visible: () => boolean): Row {
    return {
      name: "Save to server",
      desc: "Sends the name and both ceilings together, so the dashboard shows what this device will actually hold.",
      visible,
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Save").setCta().onClick(() => {
          void this.plugin.saveDeviceSettings(this.draftName ?? this.plugin.deviceName()).then(() => {
            new Notice("This device's settings are saved.");
            this.draftName = null;
            this.update();
          }).catch((error: unknown) => {
            new Notice(message(error), 8000);
          });
        }));
      },
    };
  }

  /**
   * The way out of a server, which before this row did not exist: a device
   * that only changed its Server URL met `401 bad_signature` forever and the
   * documented answer was a fresh vault (issue #79). Both buttons open the
   * same dialog; "Switch server" is the same leave followed by pairing, and
   * it redraws this tab afterwards so the rows stop describing a server this
   * device has left.
   */
  private leaving(visible: () => boolean): Row {
    return {
      name: "Leave this server",
      desc: "Revokes THIS device on the server, then forgets the server address and this device's sync identity. Every note stays in this vault. \"Switch server\" does the same and then pairs this device with another server, keeping the same vault.",
      visible,
      render: (setting) => {
        setting
          .addButton((button) => button.setButtonText("Leave").setDestructive().onClick(() => {
            new LeaveServerModal(this.app, this.plugin, "leave", () => { this.left(); }).open();
          }))
          .addButton((button) => button.setButtonText("Switch server").onClick(() => {
            new LeaveServerModal(this.app, this.plugin, "switch", () => { this.left(); }).open();
          }));
      },
    };
  }

  /** The device list and every row's description are about a server this device just left. */
  private left(): void {
    this.deviceList = null;
    this.deviceListError = null;
    this.draftName = null;
    this.update();
  }

  // ---- Devices -------------------------------------------------------------

  /**
   * Every device paired to this vault, with a revoke that asks first.
   * Revocation is immediate and one-way: the server drops the device's
   * wrapped secret and every request it makes from that moment fails
   * (`docs/architecture.md` section 4.3). The list is read when the group is
   * first drawn and again on Refresh; each device is its own row, so the
   * app's renderer, not this file, lays the list out.
   */
  private deviceRows(): Row[] {
    const rows = (this.deviceList ?? []).map((device) => this.deviceRow(device));
    rows.push({
      name: "Device list",
      desc: () => {
        if (this.deviceListError !== null) return this.deviceListError;
        if (this.deviceList === null) return "Reading the device list…";
        return `${this.deviceList.length} device${this.deviceList.length === 1 ? "" : "s"} on this account.`;
      },
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Refresh").onClick(() => {
          this.deviceList = null;
          this.deviceListError = null;
          this.readDevices();
          // Drawn at once: "Reading the device list…" replaces the old error (#182).
          this.update();
        }));
        if (this.deviceList === null && this.deviceListError === null) this.readDevices();
      },
    });
    return rows;
  }

  private readDevices(): void {
    if (this.readingDevices) return;
    this.readingDevices = true;
    const { deviceId, serverUrl } = this.plugin.state.data;
    const current = (): boolean => deviceId === this.plugin.state.data.deviceId && serverUrl === this.plugin.state.data.serverUrl;
    // A person is looking at this list: their patience, not the background's (#182).
    void this.plugin.listDevices({ interactive: true })
      .then((devices) => { if (current()) this.deviceList = devices; }, (error: unknown) => { if (current()) this.deviceListError = `The device list is unavailable: ${refusalText(error)}`; })
      .finally(() => {
        this.readingDevices = false;
        this.update();
      });
  }

  private deviceRow(device: DeviceRecord): Row {
    const self = device.device_id === this.plugin.state.data.deviceId;
    const seen = device.last_seen ? `, last seen ${new Date(device.last_seen).toLocaleString()}` : "";
    const row: Row = {
      name: `${device.name}${self ? " (this device)" : ""}`,
      desc: `${device.platform}, plugin ${device.app_version}${device.revoked ? ", revoked" : ""}${seen}`,
    };
    if (!device.revoked) {
      row.render = (setting) => {
        setting.addButton((button) => button.setButtonText("Revoke").setDestructive().onClick(() => {
          new ConfirmModal(
            this.app,
            `Revoke ${device.name}?`,
            self
              ? "This device will stop syncing immediately. To return, pair from another syncing device, or recover with the setup token and this vault’s key after recovery has been registered. Keep the setup token and 24-word phrase before revoking the last device. The vault key stays in this vault's secret storage."
              : `${device.name} will stop syncing immediately. Files already on it stay readable there; it cannot write, delete or read anything new.`,
            () => { void this.revoke(device); },
          ).open();
        }));
      };
    }
    return row;
  }

  private async revoke(device: DeviceRecord): Promise<void> {
    try {
      await this.plugin.revokeDevice(device.device_id);
      new Notice(`${device.name} is revoked.`);
      this.deviceList = null;
      this.update();
    } catch (error) {
      new Notice(`${device.name} was not revoked: ${message(error)}`, 10000);
    }
  }

  // ---- Vault key -----------------------------------------------------------

  /** Until this device has confirmed the words, the row says so and its button asks for them (issue #170). */
  private recoveryPhrase(): Row {
    const unconfirmed = (): boolean => this.plugin.state.data.vrk !== null && this.plugin.state.data.recoveryPhrase !== "confirmed";
    return {
      name: "Recovery phrase",
      desc: () => this.plugin.state.data.vrk === null
        ? "This device holds no vault key. Pair with a device that has one, or restore the phrase."
        : unconfirmed() ? RECOVERY_UNCONFIRMED
          : "24 words that are the vault key. Anyone holding them can read this vault; without them and without a paired device the vault cannot be recovered.",
      render: (setting) => {
        setting
          .addButton((button) => {
            button
              .setButtonText(unconfirmed() ? "Show and confirm" : "Show")
              .setDisabled(this.plugin.state.data.vrk === null)
              .onClick(() => { new RecoveryPhraseModal(this.app, this.plugin, unconfirmed(), () => { this.update(); }).open(); });
            if (unconfirmed()) button.setCta();
          })
          .addButton((button) => button.setButtonText("Restore or create").onClick(() => { new VaultKeyModal(this.app, this.plugin).open(); }));
      },
    };
  }
}
