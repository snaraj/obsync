/**
 * The settings tab: the server, this device (its name and its two ceilings,
 * saved to the server together), every paired device with a revoke that asks
 * first, and the vault key.
 *
 * Nothing here can turn a security property off. There is no "encrypt"
 * toggle, no "sign requests" toggle and no "verify" toggle, because those
 * are not settings (AGENTS.md requirement 4); the settings are the server
 * address, the edge headers an access-controlled deployment requires, the
 * device-local folder selection, and the two ceilings, which are device
 * policy and are shown with their consequence.
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

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsyncPlugin from "../main";
import { formatBytes, parseBytes } from "../policy";
import { ConfirmModal, PairClaimModal, PairCreateModal, RecoveryPhraseModal, VaultKeyModal } from "./modals";

export class ObsyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsyncPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.server(containerEl);
    this.version(containerEl);
    this.scope(containerEl);
    this.device(containerEl);
    this.devices(containerEl);
    this.vaultKey(containerEl);
  }

  /**
   * What to do when the server runs a newer plugin. obsync never installs
   * code the server serves (`docs/architecture.md` 6.3), so this line is the
   * whole update path: it names both versions, the Release asset and its URL.
   */
  private version(containerEl: HTMLElement): void {
    const line = this.plugin.updateLine();
    if (line === null) return;
    new Setting(containerEl).setName("Update available").setDesc(line);
  }

  private server(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Server").setHeading();
    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("The address of your obsyncd server, for example https://obsync.example.org. Mobile Obsidian requires HTTPS.")
      .addText((text) =>
        text
          .setPlaceholder("https://obsync.example.org")
          .setValue(this.plugin.state.data.serverUrl)
          .onChange((value) => {
            const url = value.trim().replace(/\/+$/, "");
            if (url !== "" && this.plugin.isMobile && !url.startsWith("https://")) {
              new Notice("obsync: mobile Obsidian only reaches HTTPS servers.");
              return;
            }
            this.plugin.state.data.serverUrl = url;
            void this.plugin.state.save();
          }),
      );
    new Setting(containerEl)
      .setName("Edge service-token headers")
      .setDesc(
        "One header per line as Name: value. Some deployments put an access-controlled edge in front of the server and require a service token on every request; leave this empty if yours does not.",
      )
      .addTextArea((text) =>
        text
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
            void this.plugin.state.save();
          }),
      );
    new Setting(containerEl)
      .setName("Connection")
      .setDesc(this.plugin.statusText())
      .addButton((button) =>
        button.setButtonText("Check").onClick(() => {
          void (async () => {
            try {
              const account = await this.plugin.transport.account();
              new Notice(`obsync: reached "${account.name}", ${account.device_count} device(s).`);
            } catch (error) {
              new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 8000);
            }
          })();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Open dashboard").onClick(() => {
          void this.plugin.openDashboard();
        }),
      );
  }

  private scope(containerEl: HTMLElement): void {
    const folders = this.plugin.state.data.syncFolders;
    let selected = folders !== undefined;
    let text = folders?.join("\n") ?? "";
    new Setting(containerEl).setName("Sync folders on this device").setHeading();
    new Setting(containerEl)
      .setName("Current selection")
      .setDesc(folders === undefined ? "Whole vault, except hidden and symlinked paths." :
        folders.length === 0 ? "No files are synced on this device." : `Only files inside: ${folders.join(", ")}.`);
    new Setting(containerEl)
      .setName("Folder selection")
      .setDesc("This stays on this device. Choose folders before pairing a vault that also contains code or other private files. Other paired devices cannot expand this selection.")
      .addDropdown((dropdown) => dropdown
        .addOption("whole", "Whole vault")
        .addOption("selected", "Selected folders only")
        .setValue(selected ? "selected" : "whole")
        .onChange((value) => { selected = value === "selected"; }));
    new Setting(containerEl)
      .setName("Selected folders")
      .setDesc("One relative folder per line, for example Notes. No leading or trailing slash or whitespace. An empty list with Selected folders only syncs nothing. Files keep these folder names on every device.")
      .addTextArea((area) => area.setPlaceholder("Notes\nAttachments").setValue(text).onChange((value) => { text = value; }));
    new Setting(containerEl)
      .setDesc("Saving waits for active transfers and then rescans. Removed folders and their history are kept. After sync has started, this selection can only be narrowed. To sync more local files in this vault, move them into an already selected folder and run Sync now. A different selection needs a fresh vault configured before pairing. Previously shared content remains readable by paired devices.")
      .addButton((button) => button.setButtonText("Save on this device").onClick(() => {
        button.setDisabled(true).setButtonText("Waiting for transfers…");
        const next = selected ? text.split(/\r?\n/).filter((line) => line !== "") : undefined;
        void this.plugin.saveSyncFolders(next).then(() => {
          new Notice("obsync: folder selection saved on this device.");
          this.display();
        }).catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : String(error), 10000);
        }).finally(() => {
          // Obsidian components are thenable. Never return one to a Promise.
          button.setDisabled(false).setButtonText("Save on this device");
        });
      }));
  }

  private device(containerEl: HTMLElement): void {
    const data = this.plugin.state.data;
    new Setting(containerEl).setName("This device").setHeading();
    new Setting(containerEl)
      .setName("Pairing")
      .setDesc(
        data.deviceId === null
          ? "This device is not paired yet. Pair it from a device that already syncs this vault, or set up a new server below."
          : `Paired as ${this.plugin.deviceName()} (${this.plugin.platformName()}), device ${data.deviceId}.`,
      )
      .addButton((button) =>
        button.setButtonText("Pair this device").onClick(() => {
          new PairClaimModal(this.app, this.plugin).open();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Pair a new device")
          .setDisabled(!this.plugin.state.paired)
          .onClick(() => {
            new PairCreateModal(this.app, this.plugin).open();
          }),
      );

    if (data.deviceId === null) {
      let token = "";
      let accountName = "obsync";
      new Setting(containerEl)
        .setName("First-time setup")
        .setDesc("Paste the setup token your server wrote at first boot. It creates the account and enrolls this device, and it is not spent by doing so: it remains the dashboard's recovery sign-in, so keep it as carefully as the recovery phrase.")
        .addText((text) => text.setPlaceholder("setup token").onChange((value) => (token = value.trim())))
        .addText((text) => text.setPlaceholder("account name").setValue(accountName).onChange((value) => (accountName = value.trim())))
        .addButton((button) =>
          button
            .setButtonText("Set up")
            .setCta()
            .onClick(() => {
              void this.plugin.setUpAccount(token, accountName).then(() => this.display());
            }),
        );
      return;
    }

    let name = this.plugin.deviceName();
    const policy = this.plugin.state.data.policy;
    new Setting(containerEl)
      .setName("Name")
      .setDesc("How this device appears in the dashboard's device list and in another device's conflict copies.")
      .addText((text) =>
        text.setValue(name).onChange((value) => {
          name = value;
        }),
      );
    new Setting(containerEl)
      .setName("Largest file to download")
      .setDesc(
        this.plugin.isMobile
          ? `Mobile Obsidian reads and writes whole files in memory, so a ceiling is what keeps a large attachment from ending the app. Files above it stay in the vault and appear under "Show remote-only files", where you can fetch one on demand. Currently ${formatBytes(policy.perFileMaxBytes)}.`
          : `Desktop streams files in 8 MiB windows through the filesystem, so there is no practical ceiling; 0 means unlimited. Currently ${formatBytes(policy.perFileMaxBytes)}.`,
      )
      .addText((text) =>
        text.setValue(formatBytes(policy.perFileMaxBytes)).onChange((value) => {
          const bytes = parseBytes(value);
          if (bytes === null) return;
          policy.perFileMaxBytes = bytes;
        }),
      );
    new Setting(containerEl)
      .setName("Total to keep on this device")
      .setDesc(
        `The vault may be larger than this device. Above this total, new files stay remote-only. 0 means unlimited. Currently ${formatBytes(policy.totalBudgetBytes)}, holding ${formatBytes(this.plugin.state.localBytes())}.`,
      )
      .addText((text) =>
        text.setValue(formatBytes(policy.totalBudgetBytes)).onChange((value) => {
          const bytes = parseBytes(value);
          if (bytes === null) return;
          policy.totalBudgetBytes = bytes;
        }),
      );
    new Setting(containerEl)
      .setDesc("The name and both ceilings are sent to the server together, so the dashboard shows what this device will actually hold.")
      .addButton((button) =>
        button
          .setButtonText("Save to server")
          .setCta()
          .onClick(() => {
            void (async () => {
              try {
                await this.plugin.saveDeviceSettings(name);
                new Notice("obsync: this device's settings are saved.");
                this.display();
              } catch (error) {
                new Notice(`obsync: ${error instanceof Error ? error.message : String(error)}`, 8000);
              }
            })();
          }),
      );
  }

  /**
   * Every device paired to this vault, with a revoke that asks first.
   * Revocation is immediate and one-way: the server drops the device's
   * wrapped secret and every request it makes from that moment fails
   * (`docs/architecture.md` section 4.3).
   */
  private devices(containerEl: HTMLElement): void {
    if (!this.plugin.state.paired) return;
    new Setting(containerEl).setName("Devices").setHeading();
    const list = containerEl.createDiv();
    const render = (): void => {
      list.empty();
      const loading = list.createEl("p", { text: "Reading the device list…" });
      void this.plugin
        .listDevices()
        .then((devices) => {
          loading.remove();
          for (const device of devices) {
            const self = device.device_id === this.plugin.state.data.deviceId;
            const setting = new Setting(list)
              .setName(`${device.name}${self ? " (this device)" : ""}`)
              .setDesc(
                `${device.platform}, obsync ${device.app_version}` +
                  (device.revoked ? " — revoked" : "") +
                  (device.last_seen ? `, last seen ${new Date(device.last_seen).toLocaleString()}` : ""),
              );
            if (device.revoked) continue;
            setting.addButton((button) =>
              button
                .setButtonText("Revoke")
                .setWarning()
                .onClick(() => {
                  new ConfirmModal(
                    this.app,
                    `Revoke ${device.name}?`,
                    self
                      ? "This device will stop syncing immediately and will need a new pairing code to come back. The vault key stays in this vault's plugin data."
                      : `${device.name} will stop syncing immediately. Files already on it stay readable there; it cannot write, delete or read anything new.`,
                    () => {
                      void (async () => {
                        try {
                          await this.plugin.revokeDevice(device.device_id);
                          new Notice(`obsync: ${device.name} is revoked.`);
                          render();
                        } catch (error) {
                          new Notice(
                            `obsync: ${device.name} was not revoked — ${error instanceof Error ? error.message : String(error)}`,
                            10000,
                          );
                        }
                      })();
                    },
                  ).open();
                }),
            );
          }
        })
        .catch((error: unknown) => {
          loading.setText(
            `The device list is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    };
    render();
    new Setting(containerEl).addButton((button) => button.setButtonText("Refresh").onClick(render));
  }

  private vaultKey(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Vault key").setHeading();
    new Setting(containerEl)
      .setName("Recovery phrase")
      .setDesc(
        this.plugin.state.data.vrk === null
          ? "This device holds no vault key. Pair with a device that has one, or restore the phrase."
          : "24 words that are the vault key. Anyone holding them can read this vault; without them and without a paired device the vault cannot be recovered.",
      )
      .addButton((button) =>
        button
          .setButtonText("Show")
          .setDisabled(this.plugin.state.data.vrk === null)
          .onClick(() => {
            new RecoveryPhraseModal(this.app, this.plugin, false).open();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Restore or create").onClick(() => {
          new VaultKeyModal(this.app, this.plugin).open();
        }),
      );
  }
}
