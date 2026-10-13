/** Recover an explicitly selected old backup directly into a stopped upgrade. */
import { accountRecovery } from "./accountRecovery";
import { hex, randomBytes, unhex } from "./crypto";
import { domainMapKeys } from "./domainmap";
import { parseLegacyRecoveryHistory } from "./recoveryBackup";
import { preflightRotationMap } from "./rotationReseal";
import type { State } from "./state";
import { lostMessage, type DeviceProfile, type Transport } from "./transport";

export async function recoverLegacyUpgrade(input: {
  state: State; transport: Transport; token: string; backup: string; profile: DeviceProfile;
  assertCurrent: () => void;
}): Promise<void> {
  const { state, transport, token, backup, assertCurrent } = input;
  const profile = { ...input.profile };
  assertCurrent(); state.assertAvailable();
  const identity = JSON.stringify([state.data.vrk, state.data.deviceId, state.data.deviceSecret, state.data.serverUrl, state.data.edgeHeaders]);
  const check = (): void => {
    assertCurrent(); state.assertAvailable();
    if (state.custody2() !== null || state.data.deviceId !== null || state.data.deviceSecret !== null ||
        JSON.stringify([state.data.vrk, state.data.deviceId, state.data.deviceSecret, state.data.serverUrl, state.data.edgeHeaders]) !== identity) {
      throw new Error("This device changed or already has an enrollment. Legacy recovery was not adopted.");
    }
  };
  check();
  const oldRoot = await parseLegacyRecoveryHistory(backup); check();
  if (state.data.vrk !== null && state.data.vrk !== hex(oldRoot)) throw new Error("The legacy backup does not match this device's held key.");
  await transport.setupCapabilities2(); check();
  const recovery = await accountRecovery(hex(oldRoot)); check();
  const sent = await transport.recoverLegacyForUpgrade(token, profile, recovery); check();
  if (sent.outcome === "lost") throw new Error(lostMessage("recovering the legacy enrollment", sent));
  const credential = sent.value;
  if (credential === null || typeof credential !== "object" || credential.recovered !== true ||
      typeof credential.account_id !== "string" || !/^[0-9a-f]{32}$/.test(credential.account_id)) throw new Error("Legacy recovery response refused.");
  const scoped = transport.withCredential(credential, check);
  const account = await scoped.account({ interactive: true }); check();
  if (account.account_id !== credential.account_id || Object.hasOwn(account, "seal_suite") || Object.hasOwn(account, "generation")) {
    throw new Error("This account is not an older vault. Use its complete current-format backup.");
  }
  await scoped.rotationCapabilities2(); check();
  const old = await domainMapKeys(oldRoot); check();
  const after = async <T>(work: () => Promise<T>): Promise<T> => { check(); const value = await work(); check(); return value; };
  await preflightRotationMap({
    getFile: id => after(() => scoped.getFile(id, { interactive: true })),
    getVersion: (id, version) => after(() => scoped.getVersion(id, version, { interactive: true })),
    getChunk: id => after(() => scoped.getChunk(id, undefined, { interactive: true })),
    putChunk: async () => { throw new Error("Legacy recovery cannot upload content."); },
  }, { suite: 1, root: oldRoot, generation: old.fileId }); check();
  const newRoot = hex(randomBytes(32)), next = await domainMapKeys(unhex(newRoot)), nextRecovery = await accountRecovery(newRoot); check();
  await state.stageLegacyUpgrade(hex(oldRoot), newRoot, { deviceId: credential.device_id, deviceSecret: credential.device_secret }, {
    lineage: old.fileId, operation: hex(randomBytes(16)), oldGeneration: old.fileId, newGeneration: next.fileId,
    targetDeviceId: null, recoveryVerifier: nextRecovery.verifier,
  });
  assertCurrent(); state.assertAvailable();
}
