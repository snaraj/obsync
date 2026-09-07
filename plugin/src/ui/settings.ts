/**
 * The settings tab: server, this device, vault key, and the two device
 * ceilings with the platform facts that explain them.
 *
 * Nothing here can turn a security property off. There is no "encrypt"
 * toggle, no "sign requests" toggle and no "verify" toggle, because those
 * are not settings (AGENTS.md requirement 4); the only knobs are the server
 * address, the edge headers an access-controlled deployment requires, and
 * the two ceilings, which are device policy and are shown with their
 * consequence.
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
import { PairClaimModal, PairCreateModal, RecoveryPhraseModal, VaultKeyModal } from "./modals";

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
    this.device(containerEl);
    this.vaultKey(containerEl);
    this.ceilings(containerEl);
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
        .setDesc("Paste the one-time setup token your server printed at first boot. This creates the account and enrolls this device.")
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
    }
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

  private ceilings(containerEl: HTMLElement): void {
    const policy = this.plugin.state.data.policy;
    new Setting(containerEl).setName("This device's limits").setHeading();
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
          void this.plugin.state.save();
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
          void this.plugin.state.save();
        }),
      );
  }
}
