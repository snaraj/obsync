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

import { Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type { App, SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type ObsyncPlugin from "../main";
import { formatBytes, parseBytes } from "../policy";
import type { DeviceRecord } from "../transport";
import { ConfirmModal, LeaveServerModal, PairClaimModal, PairCreateModal, RecoveryPhraseModal, VaultKeyModal } from "./modals";

/** The dashboard's label for the one account a server holds. */
export const ACCOUNT_NAME = "obsync";

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
  private shownRefusal: string | null = null;

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
    super.hide();
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
        setting.addText((field) => field
          .setPlaceholder("sync.example.org")
          .setValue(this.plugin.state.data.serverUrl)
          .onChange((value) => {
            const url = normalizeServerUrl(value);
            const refusal = serverUrlRefusal(url, this.plugin.isMobile);
            // Once per refusal: this runs on every keystroke, and a notice a
            // character is a storm the person has to wait out.
            if (refusal !== null) {
              if (refusal !== this.shownRefusal) new Notice(refusal);
              this.shownRefusal = refusal;
              return;
            }
            this.shownRefusal = null;
            this.plugin.state.data.serverUrl = url;
            // State reports persistence failure and stops sync through its host hook.
            void this.plugin.state.save().catch(() => {});
          }));
      },
    };
  }

  private edgeHeaders(): Row {
    return {
      name: "Edge service-token headers",
      desc: "One header per line, written as name: value, for a deployment with an access-controlled proxy in front of the server. Leave empty otherwise.",
      render: (setting) => {
        setting.addTextArea((area) => area
          .setValue(this.plugin.state.data.edgeHeaders.map((header) => `${header.name}: ${header.value}`).join("\n"))
          .onChange((value) => {
            this.plugin.state.data.edgeHeaders = value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.includes(":"))
              .map((line) => ({
                name: line.slice(0, line.indexOf(":")).trim(),
                value: line.slice(line.indexOf(":") + 1).trim(),
              }));
            void this.plugin.state.save().catch(() => {});
          }));
      },
    };
  }

  private connection(): Row {
    return {
      name: "Connection",
      desc: () => this.plugin.statusText(),
      render: (setting) => {
        setting
          .addButton((button) => button.setButtonText("Check").onClick(() => {
            if (this.plugin.state.data.serverUrl === "") {
              new Notice("Type your server's address in Server URL first.");
              return;
            }
            // Before setup there is no device to sign with, and the signed
            // read answered "not paired" without asking the server anything:
            // the one moment a person most needs to know whether the address
            // works (2026-09-24 battery, S08; #137). The plugin manifest is the
            // route that needs no credential.
            const check = this.plugin.state.paired
              ? this.plugin.transport.account().then((account) => `Reached "${account.name}", ${account.device_count} device(s).`)
              : this.plugin.transport.pluginManifest().then(() => "Reached your obsync server. Next: First-time setup on your first device, or Pair this device.");
            void check
              .then((text) => { new Notice(text); })
              .catch((error: unknown) => { new Notice(message(error), 8000); });
          }))
          .addButton((button) => button.setButtonText("Open dashboard").onClick(() => { void this.plugin.openDashboard(); }));
      },
    };
  }

  /**
   * Deletions one startup pass refused to publish (issue #123). The row is
   * absent whenever there are none, so it is only ever seen by a user who has
   * something to decide, and its button is destructive because confirming
   * removes those notes from every device.
   */
  private heldDeletions(): Row {
    return {
      name: "Deletions held back",
      desc: () => this.plugin.heldDeletionLine() ?? "",
      visible: () => this.plugin.heldDeletionLine() !== null,
      render: (setting) => {
        setting.addButton((button) =>
          button.setButtonText("Confirm deletions").setDestructive().onClick(() => {
            this.plugin.confirmHeldDeletions();
            new Notice("obsync: the deletions were published. Your other devices will remove those notes.", 8000);
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

  private async saveScopeDraft(): Promise<void> {
    await this.plugin.saveSyncFolders(this.scopeValue());
    this.draftScope = null;
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
        setting.addTextArea((area) => area
          .setPlaceholder("Notes")
          .setValue(this.scopeDraft().text)
          .onChange((value) => { this.scopeDraft().text = value; }));
      },
    };
  }

  private saveScope(): Row {
    return {
      name: "Save on this device",
      desc: "Waits for active transfers, then rescans. Adding a folder also brings in what the server already holds under it, which can take a while on a large vault; removed folders keep their local files and their history.",
      render: (setting) => {
        setting.addButton((button) => button.setButtonText("Save").onClick(() => {
          button.setDisabled(true).setButtonText("Waiting for transfers…");
          void this.saveScopeDraft().then(() => {
            new Notice("Folder selection saved on this device.");
            this.update();
          }).catch((error: unknown) => {
            new Notice(message(error), 10000);
          }).finally(() => {
            // Obsidian components are thenable. Never return one to a Promise.
            button.setDisabled(false).setButtonText("Save");
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
        if (data.deviceId === null) return "Not paired yet. Pair from a device that already syncs this vault, or set up a new server below.";
        if (this.plugin.state.paired) return `Paired as ${this.plugin.deviceName()} (${this.plugin.platformName()}), device ${data.deviceId}.`;
        return "Enrolled, but the vault key has not arrived. Finish approval on the existing device, then restore the recovery phrase if needed. A pending dialog does not resume after a restart; do not repeat server setup.";
      },
      render: (setting) => {
        setting
          .addButton((button) => button.setButtonText("Pair this device").onClick(() => { void this.pairThisDevice(); }))
          .addButton((button) => button
            .setButtonText("Pair a new device")
            .setDisabled(!this.plugin.state.paired)
            .onClick(() => { new PairCreateModal(this.app, this.plugin).open(); }));
      },
    };
  }

  private setup(): Row {
    return {
      name: "First-time setup",
      desc: "Paste the setup token your server wrote at first boot. It creates the account and enrolls this device, and it is not spent by that: it remains the dashboard's recovery sign-in, so keep it as carefully as the recovery phrase.",
      visible: () => this.plugin.state.data.deviceId === null,
      render: (setting) => {
        setting
          .addText((field) => field.setPlaceholder("Setup token").setValue(this.draftToken).onChange((value) => { this.draftToken = value.trim(); }))
          .addButton((button) => button.setButtonText("Set up").setCta().onClick(() => { void this.setUp(); }));
      },
    };
  }

  /** A typed, unsaved folder selection is applied first: the screen is what the device syncs. */
  private async applyScopeDraft(): Promise<boolean> {
    if (!this.scopeChanged()) return true;
    try {
      await this.saveScopeDraft();
      return true;
    } catch (error) {
      new Notice(message(error), 10000);
      return false;
    }
  }

  private async setUp(): Promise<void> {
    if (!(await this.applyScopeDraft())) return;
    await this.plugin.setUpAccount(this.draftToken, ACCOUNT_NAME);
    if (this.plugin.state.data.deviceId !== null) this.draftToken = "";
    this.update();
  }

  private async pairThisDevice(): Promise<void> {
    if (!(await this.applyScopeDraft())) return;
    new PairClaimModal(this.app, this.plugin).open();
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
    return {
      name: "Largest file to download",
      desc: () => {
        const policy = this.plugin.state.data.policy;
        return this.plugin.isMobile
          ? `Mobile Obsidian reads and writes whole files in memory, so a ceiling is what keeps a large attachment from ending the app. Files above it stay on the server and appear under "Show remote-only files", to fetch one at a time. Currently ${formatBytes(policy.perFileMaxBytes)}.`
          : `Desktop streams files in 8 MiB windows, so there is no practical ceiling; 0 means unlimited. Currently ${formatBytes(policy.perFileMaxBytes)}.`;
      },
      visible,
      render: (setting) => {
        setting.addText((field) => field
          .setValue(formatBytes(this.plugin.state.data.policy.perFileMaxBytes))
          .onChange((value) => {
            const bytes = parseBytes(value);
            if (bytes !== null) this.plugin.state.data.policy.perFileMaxBytes = bytes;
          }));
      },
    };
  }

  private total(visible: () => boolean): Row {
    return {
      name: "Total to keep on this device",
      desc: () => {
        const policy = this.plugin.state.data.policy;
        return `The vault may be larger than this device. Above this total, new files stay remote-only; 0 means unlimited. Currently ${formatBytes(policy.totalBudgetBytes)}, holding ${formatBytes(this.plugin.state.localBytes())}.`;
      },
      visible,
      render: (setting) => {
        setting.addText((field) => field
          .setValue(formatBytes(this.plugin.state.data.policy.totalBudgetBytes))
          .onChange((value) => {
            const bytes = parseBytes(value);
            if (bytes !== null) this.plugin.state.data.policy.totalBudgetBytes = bytes;
          }));
      },
    };
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
        }));
        if (this.deviceList === null && this.deviceListError === null) this.readDevices();
      },
    });
    return rows;
  }

  private readDevices(): void {
    if (this.readingDevices) return;
    this.readingDevices = true;
    void this.plugin.listDevices()
      .then((devices) => { this.deviceList = devices; }, (error: unknown) => { this.deviceListError = `The device list is unavailable: ${message(error)}`; })
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
              ? "This device will stop syncing immediately and will need a new pairing code to come back. The vault key stays in this vault's plugin data."
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

  private recoveryPhrase(): Row {
    return {
      name: "Recovery phrase",
      desc: () => this.plugin.state.data.vrk === null
        ? "This device holds no vault key. Pair with a device that has one, or restore the phrase."
        : "24 words that are the vault key. Anyone holding them can read this vault; without them and without a paired device the vault cannot be recovered.",
      render: (setting) => {
        setting
          .addButton((button) => button
            .setButtonText("Show")
            .setDisabled(this.plugin.state.data.vrk === null)
            .onClick(() => { new RecoveryPhraseModal(this.app, this.plugin, false).open(); }))
          .addButton((button) => button.setButtonText("Restore or create").onClick(() => { new VaultKeyModal(this.app, this.plugin).open(); }));
      },
    };
  }
}
