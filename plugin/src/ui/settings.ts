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
import { ConfirmModal, PairClaimModal, PairCreateModal, RecoveryPhraseModal, VaultKeyModal } from "./modals";

/** The dashboard's label for the one account a server holds. */
export const ACCOUNT_NAME = "obsync";

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

/** `https://` is the default, not a requirement: a bare host is completed, never refused. */
export function normalizeServerUrl(value: string): string {
  const url = value.trim().replace(/\/+$/, "");
  return url === "" || SCHEME.test(url) ? url : "https://" + url;
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
      { heading: "Server", rows: [this.serverUrl(), this.edgeHeaders(), this.connection(), this.updateAvailable()] },
      { heading: "Sync folders on this device", rows: [this.folderSelection(), this.selectedFolders(), this.saveScope()] },
      { heading: "This device", rows: [this.pairing(), this.setup(), this.deviceName(enrolled), this.perFile(enrolled), this.total(enrolled), this.saveDevice(enrolled)] },
      { heading: "Devices", visible: () => this.plugin.state.paired, rows: this.deviceRows() },
      { heading: "Vault key", rows: [this.recoveryPhrase()] },
    ];
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
            if (url !== "" && this.plugin.isMobile && !url.startsWith("https://")) {
              new Notice("Mobile Obsidian only reaches HTTPS servers.");
              return;
            }
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
            void this.plugin.transport.account()
              .then((account) => { new Notice(`Reached "${account.name}", ${account.device_count} device(s).`); })
              .catch((error: unknown) => { new Notice(message(error), 8000); });
          }))
          .addButton((button) => button.setButtonText("Open dashboard").onClick(() => { void this.plugin.openDashboard(); }));
      },
    };
  }

  /**
   * What to do when the server runs a newer plugin. obsync never installs
   * code the server serves (`docs/architecture.md` 6.3), so this line is the
   * whole update path: it names both versions and Obsidian's plugin manager.
   */
  private updateAvailable(): Row {
    return {
      name: "Update available",
      desc: () => this.plugin.updateLine() ?? "",
      visible: () => this.plugin.updateLine() !== null,
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
