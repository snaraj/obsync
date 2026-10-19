/** Explicit setup/recovery: stage locally, prove the enrollment, then adopt. */
import { accountRecovery } from "./accountRecovery";
import { unhex } from "./crypto";
import { domainMapKeys, DomainMapError, loadDomainMap } from "./domainmap";
import type { State } from "./state";
import { lostMessage, type DeviceProfile, type Enrollment2, type Transport } from "./transport";

export async function enroll2(state: State, transport: Transport, token: string, accountName: string,
  device: DeviceProfile, assertCurrent: () => void, action: "enroll" | "recover-first-setup" = "enroll"): Promise<Enrollment2> {
  const staged = state.stagedEnrollment2();
  if (staged === null || staged.purpose === "pair") throw new Error("Stage a new vault or its complete recovery backup before setup.");
  if (!["enroll", "recover-first-setup"].includes(action) || (action === "recover-first-setup" && staged.purpose !== "new")) {
    throw new Error("Only this device's staged new vault can recover an interrupted first setup.");
  }
  const identity = JSON.stringify([state.data.vrk, state.data.deviceId, state.data.deviceSecret, state.data.serverUrl, state.data.edgeHeaders]);
  const assertStaged = (): void => {
    assertCurrent(); state.assertAvailable();
    const current = state.stagedEnrollment2();
    if (current?.root !== staged.root || current.purpose !== staged.purpose || current.generation !== staged.generation ||
        JSON.stringify([state.data.vrk, state.data.deviceId, state.data.deviceSecret, state.data.serverUrl, state.data.edgeHeaders]) !== identity) {
      throw new Error("The staged vault changed; this enrollment was not adopted.");
    }
  };
  assertStaged();
  await transport.setupCapabilities2();
  assertStaged();
  const recovery = await accountRecovery(staged.root);
  assertStaged();
  const sent = await transport.setup2(token, accountName, device, { ...recovery,
    generation: staged.generation, recoverOnly: staged.purpose === "recover" || action === "recover-first-setup" });
  assertStaged();
  if (sent.outcome === "lost") throw new Error(lostMessage("enrolling this device", sent));
  const result = sent.value;
  if (result === null || typeof result !== "object" || typeof result.account_id !== "string" ||
      !/^[0-9a-f]{32}$/.test(result.account_id)) throw new Error("Enrollment response refused.");
  const scoped = transport.withCredential(result, assertStaged);
  const account = await scoped.account({ interactive: true });
  assertStaged();
  if (account.account_id !== result.account_id || account.seal_suite !== 2 || account.generation !== staged.generation) {
    throw new Error("The server did not confirm this vault's enrollment.");
  }
  if (staged.purpose === "recover") {
    const keys = await domainMapKeys(unhex(staged.root));
    assertStaged();
    if (keys.fileId !== staged.generation || await loadDomainMap(scoped, keys) === null) throw new DomainMapError("missing_map");
    assertStaged();
  }
  // The local pre-request new intent grants initialization. No response field
  // or restored backup may create that authority, even on an empty server.
  await state.adoptSuite2({ root: staged.root, generation: staged.generation,
    deviceId: result.device_id, deviceSecret: result.device_secret, purpose: staged.purpose });
  assertCurrent();
  return result;
}
