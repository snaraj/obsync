/** Explicit grant recovery for one locally retained rotation, never ordinary enrollment. */
import { accountRecovery } from "./accountRecovery";
import { bytesEqual, hex, randomBytes, unhex } from "./crypto";
import { parseRecoveryBackup } from "./recoveryBackup";
import { readRotationIntent, readRotationStatus, type RotationStatus } from "./rotationWire";
import type { Custody2, State } from "./state";
import type { DeviceProfile, Transport } from "./transport";

const refuse = (): never => { throw new Error("This pending encryption transition could not be verified. Sync remains stopped; retain both backups and retry this exact recovery action."); };

function bind(status: RotationStatus, custody: Custody2): void {
  const rotation = custody.rotation;
  if (!rotation || status.committed || status.resume_id !== rotation.resume?.id) return refuse();
  const prepared = rotation.prepared, commit = rotation.commit;
  if (prepared !== null && (prepared.cutoff !== status.cutoff || prepared.inventoryHash !== status.inventory_hash || prepared.inventoryHeads !== status.inventory_heads)) return refuse();
  if (commit !== null && (commit.catalogPages !== status.catalog_pages || commit.catalogHash !== status.catalog_hash || status.catalog_heads !== status.inventory_heads)) return refuse();
}

export async function resumeRotationCredential(input: {
  state: State; transport: Transport; token: string; backup: string; profile: DeviceProfile;
  assertCurrent: () => void; stopSync: () => Promise<void>;
}): Promise<"resumed" | "lost"> {
  const { state, transport, token, backup, assertCurrent, stopSync } = input;
  // Snapshot caller-owned strings before stopping the engine or deriving keys.
  const profile = { ...input.profile };
  assertCurrent(); state.assertAvailable(); await stopSync(); assertCurrent(); state.assertAvailable();
  let frozen = state.custody2();
  if (!frozen?.rotation || frozen.phase === "draft" || frozen.phase === "active" || frozen.phase === "enrollment" || !state.paired) return refuse();
  const identity = { root: state.data.vrk, deviceId: state.data.deviceId, deviceSecret: state.data.deviceSecret,
    serverUrl: state.data.serverUrl, headers: JSON.stringify(state.data.edgeHeaders) };
  const check = (): void => {
    assertCurrent(); state.assertAvailable();
    if (JSON.stringify(state.custody2()) !== JSON.stringify(frozen) || state.data.vrk !== identity.root || state.data.deviceId !== identity.deviceId ||
      state.data.deviceSecret !== identity.deviceSecret || state.data.serverUrl !== identity.serverUrl || JSON.stringify(state.data.edgeHeaders) !== identity.headers) refuse();
  };
  const root = await parseRecoveryBackup(backup); check();
  if (!bytesEqual(root, unhex(frozen.rotation.newRoot))) return refuse();
  const recovery = await accountRecovery(hex(root)); check();
  if (recovery.verifier !== frozen.rotation.intent.recoveryVerifier) return refuse();
  const oldIntent = frozen.rotation.intent;
  const intent = readRotationIntent({ operation: oldIntent.operation, previous_map: oldIntent.oldGeneration, current_map: oldIntent.newGeneration,
    target: oldIntent.targetDeviceId, recovery_verifier: oldIntent.recoveryVerifier, seal_suite: 2 });
  const request = frozen.rotation.resume ?? { id: hex(randomBytes(16)), profile };
  await state.stageRotationResume(request.id, request.profile);
  // Only our exact resume record may have changed during its serialized save.
  const staged = state.custody2();
  if (!staged?.rotation || JSON.stringify({ ...staged, rotation: { ...staged.rotation, resume: frozen.rotation.resume } }) !== JSON.stringify(frozen)) return refuse();
  frozen = staged; check();
  const persisted = staged.rotation.resume;
  if (persisted === null || persisted.id !== request.id) return refuse();
  const sent = await transport.setupRotationResume(token, persisted.profile, { ...recovery, generation: intent.current_map, intent, resumeId: request.id }); check();
  if (sent.outcome === "lost") return "lost";
  const credential = sent.value;
  if (credential === null || typeof credential !== "object" || credential.recovered !== true ||
    typeof credential.account_id !== "string" || !/^[0-9a-f]{32}$/.test(credential.account_id)) return refuse();
  const scoped = transport.withCredential(credential, check);
  const status = readRotationStatus(await scoped.rotationStatus(intent, credential.device_id), intent, credential.device_id); check(); bind(status, frozen);
  if (frozen.phase === "prepare_unknown") {
    await state.markRotationPrepared({ cutoff: status.cutoff, inventoryHash: status.inventory_hash, inventoryHeads: status.inventory_heads });
    const prepared = state.custody2();
    if (!prepared?.rotation || JSON.stringify({ ...prepared, phase: frozen.phase, rotation: { ...prepared.rotation, prepared: null } }) !== JSON.stringify(frozen)) return refuse();
    frozen = prepared; check();
  }
  await state.adoptRotationCredential(intent.operation, request.id, { deviceId: credential.device_id, deviceSecret: credential.device_secret });
  assertCurrent(); state.assertAvailable();
  const adopted = state.custody2();
  if (JSON.stringify(adopted) !== JSON.stringify(frozen) || state.data.vrk !== identity.root || state.data.deviceId !== credential.device_id || state.data.deviceSecret !== credential.device_secret) return refuse();
  return "resumed";
}
