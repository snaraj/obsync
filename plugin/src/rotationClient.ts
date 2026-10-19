/** One explicit, restartable fresh-root transition; no automatic recovery fallback. */
import { accountRecovery } from "./accountRecovery";
import { bytesEqual, concat, hex, randomBytes, sha256, unhex, utf8 } from "./crypto";
import { domainMapKeys } from "./domainmap";
import { parseRecoveryBackup } from "./recoveryBackup";
import { planRotationReseal, preflightRotationMap } from "./rotationReseal";
import { readManifestSeal2 } from "./sealWire";
import type { Custody2, State } from "./state";
import type { Transport, VersionPost } from "./transport";
import { readRotationIntent, ROTATION_MAX_HEADS, ROTATION_PAGE_HEADS, sourceOrder,
  type CatalogEntry, type RotationStatus, type RotationWireIntent, type SourceHead } from "./rotationWire";

const refuse = (): never => { throw new Error("The encryption transition could not be verified. Sync remains stopped; retain both backups and resume this transition."); };
type Pending = Custody2 & { rotation: NonNullable<Custody2["rotation"]> };

/** Canonical commitments are bounded to 65,536 fixed-width source rows. */
export async function rotationInventoryHash(heads: readonly SourceHead[]): Promise<string> {
  if (heads.length > ROTATION_MAX_HEADS) return refuse();
  for (let i = 0; i < heads.length; i++) {
    const row = heads[i]!;
    if (row.length !== 2 || !/^[0-9a-f]{32}$/.test(row[0]) || !/^[0-9a-f]{64}$/.test(row[1]) ||
        (i > 0 && sourceOrder(heads[i - 1]!, row) >= 0)) return refuse();
  }
  return hex(await sha256(utf8(heads.map(row => `${JSON.stringify(row)}\n`).join(""))));
}

function wire(pending: Pending): RotationWireIntent {
  const intent = pending.rotation.intent;
  return readRotationIntent({ operation: intent.operation, previous_map: intent.oldGeneration,
    current_map: intent.newGeneration, target: intent.targetDeviceId,
    recovery_verifier: intent.recoveryVerifier, seal_suite: 2 });
}

/** Construct once after State.open. The captured operation proves a local reload. */
export class RotationClient {
  private busy = false;
  private readonly loadedOperation: string | null;
  constructor(private readonly state: State, private readonly transport: Transport,
    private readonly assertCurrent: () => void, private readonly stopSync: () => Promise<void>) {
    const loaded = state.custody2();
    this.loadedOperation = loaded?.phase === "commit_unknown" ? loaded.rotation?.intent.operation ?? null : null;
  }

  private pending(): Pending {
    this.assertCurrent(); this.state.assertAvailable();
    const custody = this.state.custody2();
    if (!custody?.rotation || !this.state.paired) return refuse();
    return custody as Pending;
  }

  private check(operation: string): void {
    if (this.pending().rotation.intent.operation !== operation) refuse();
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("An encryption transition action is already running.");
    this.busy = true;
    try { this.assertCurrent(); await this.stopSync(); this.assertCurrent(); return await work(); }
    finally { this.busy = false; }
  }

  private io(operation?: string) {
    const check = (): void => { this.assertCurrent(); this.state.assertAvailable(); if (operation !== undefined) this.check(operation); };
    const after = async <T>(call: () => Promise<T>): Promise<T> => { check(); const result = await call(); check(); return result; };
    return {
      getFile: (id: string) => after(() => this.transport.getFile(id, { interactive: true })),
      getVersion: (id: string, version: string) => after(() => this.transport.getVersion(id, version, { interactive: true })),
      getChunk: (id: string) => after(() => this.transport.getChunk(id, undefined, { interactive: true })),
      putChunk: (id: string, bytes: Uint8Array<ArrayBuffer>) => after(() => this.transport.putChunk(id, bytes, { interactive: true })),
    };
  }

  /** No server mutation: authenticate the old map, then durably stage a fresh root. */
  start(target: string | null): Promise<void> {
    return this.exclusive(async () => {
      const initial = this.state.custody2();
      const oldRoot = this.state.data.vrk, device = this.state.data.deviceId;
      if (!this.state.paired || oldRoot === null || device === null || initial?.rotation || initial?.enrollment ||
          initial?.initializeMap || initial?.history || target === device || (target !== null && !/^[0-9a-f]{32}$/.test(target))) return refuse();
      await this.transport.rotationCapabilities2(); this.assertCurrent();
      const old = await domainMapKeys(unhex(oldRoot)); this.assertCurrent();
      if (initial !== null && (initial.phase !== "active" || initial.generation !== old.fileId)) return refuse();
      await preflightRotationMap(this.io(), { suite: initial === null ? 1 : 2, root: unhex(oldRoot), generation: old.fileId });
      this.assertCurrent(); this.state.assertAvailable();
      if (this.state.data.vrk !== oldRoot || this.state.data.deviceId !== device ||
          JSON.stringify(this.state.custody2()) !== JSON.stringify(initial)) return refuse();
      const root = hex(randomBytes(32)), next = await domainMapKeys(unhex(root)), recovery = await accountRecovery(root);
      this.assertCurrent();
      await this.state.stageRotation(root, { lineage: old.fileId, operation: hex(randomBytes(16)),
        oldGeneration: old.fileId, newGeneration: next.fileId, targetDeviceId: target, recoveryVerifier: recovery.verifier });
      this.assertCurrent();
    });
  }

  private async confirmBackup(pending: Pending, text: string): Promise<void> {
    const root = await parseRecoveryBackup(text);
    this.check(pending.rotation.intent.operation);
    if (!bytesEqual(root, unhex(pending.rotation.newRoot))) throw new Error("The complete backup does not match this transition's new vault key.");
  }

  /** A draft has never attempted server preparation; later phases cannot cancel. */
  cancelDraft(): Promise<void> {
    return this.exclusive(async () => {
      const pending = this.pending();
      if (pending.phase !== "draft") return refuse();
      await this.state.cancelRotationDraft(); this.assertCurrent();
    });
  }

  private bind(status: RotationStatus, pending: Pending): void {
    const prepared = pending.rotation.prepared, commit = pending.rotation.commit;
    if (prepared !== null && (status.cutoff !== prepared.cutoff || status.inventory_hash !== prepared.inventoryHash ||
        status.inventory_heads !== prepared.inventoryHeads)) refuse();
    if (commit !== null && (status.catalog_pages !== commit.catalogPages || status.catalog_hash !== commit.catalogHash ||
        status.catalog_heads !== status.inventory_heads)) refuse();
    if (status.committed && pending.phase !== "commit_unknown") refuse();
  }

  private async status(pending: Pending): Promise<RotationStatus> {
    const result = await this.transport.rotationStatus(wire(pending), this.state.data.deviceId!);
    this.check(pending.rotation.intent.operation); this.bind(result, pending); return result;
  }

  /** Re-enter the owner token; a lost prepare reads its exact operation only. */
  prepare(token: string, backup: string): Promise<void> {
    return this.exclusive(async () => {
      let pending = this.pending();
      if (pending.phase !== "draft" && pending.phase !== "prepare_unknown") return refuse();
      await this.confirmBackup(pending, backup);
      if (pending.phase === "draft") await this.state.rotationPhase("prepare_unknown");
      pending = this.pending();
      const sent = await this.transport.prepareRotation(wire(pending), this.state.data.deviceId!, token);
      this.check(pending.rotation.intent.operation);
      const result = sent.outcome === "lost" ? await this.status(pending) : sent.value;
      this.bind(result, pending);
      await this.state.markRotationPrepared({ cutoff: result.cutoff, inventoryHash: result.inventory_hash, inventoryHeads: result.inventory_heads });
      this.check(pending.rotation.intent.operation);
    });
  }

  private async inventory(status: RotationStatus): Promise<SourceHead[]> {
    const all: SourceHead[] = [];
    for (let page = 0; page < Math.ceil(status.inventory_heads / ROTATION_PAGE_HEADS); page++) {
      const next = await this.transport.rotationInventory(status, page);
      this.check(status.intent.operation); all.push(...next.heads);
    }
    if (all.length !== status.inventory_heads || await rotationInventoryHash(all) !== status.inventory_hash) return refuse();
    this.check(status.intent.operation); return all;
  }

  private async publish(operation: string, file: string, post: VersionPost): Promise<void> {
    this.check(operation);
    if (post.accept_existing) return refuse();
    const expected = readManifestSeal2(post);
    // A transport acknowledgement cannot substitute a different position or version.
    await this.transport.postVersion(file, post); this.check(operation);
    const got = await this.transport.getVersion(file, post.version_id, { interactive: true }); this.check(operation);
    const meta = await this.transport.getFile(file, { interactive: true }); this.check(operation);
    if (got.version_id !== post.version_id || !bytesEqual(readManifestSeal2(got), expected) ||
        JSON.stringify(got.parents) !== JSON.stringify(post.parents) || JSON.stringify(got.sids) !== JSON.stringify(post.sids) ||
        got.bytes !== post.bytes || got.deleted !== post.deleted || meta.file_id !== file || meta.domain_id !== post.domain_id ||
        !Array.isArray(meta.heads) || !meta.heads.includes(post.version_id)) return refuse();
  }

  /** Recompute all deterministic pages on resume; never trust a server's skip count. */
  seed(progress: (done: number, total: number) => void = () => undefined): Promise<void> {
    return this.exclusive(async () => {
      let pending = this.pending();
      if (pending.phase !== "prepared" && pending.phase !== "seeding") return refuse();
      const initial = await this.status(pending), inventory = await this.inventory(initial);
      const plan = await planRotationReseal(this.io(initial.intent.operation),
        { suite: pending.rotation.fromSuite, root: unhex(this.state.data.vrk!), generation: initial.intent.previous_map },
        { root: unhex(pending.rotation.newRoot), generation: initial.intent.current_map }, inventory);
      this.check(initial.intent.operation);
      if (pending.phase === "prepared") await this.state.rotationPhase("seeding");
      pending = this.pending();
      const pageHashes: Uint8Array<ArrayBuffer>[] = [];
      let status = initial;
      for (let start = 0; start < inventory.length; start += ROTATION_PAGE_HEADS) {
        const entries: CatalogEntry[] = [];
        for (const source of inventory.slice(start, start + ROTATION_PAGE_HEADS)) {
          const row = await plan.reseal(source); this.check(initial.intent.operation);
          if (row.oldFile !== source[0] || row.oldVersion !== source[1] || row.newVersion !== row.post.version_id ||
              row.newFile !== plan.destination(source[0])) return refuse();
          await this.publish(initial.intent.operation, row.newFile, row.post);
          entries.push([row.oldFile, row.oldVersion, row.newFile, row.newVersion]);
          progress(start + entries.length, inventory.length); this.check(initial.intent.operation);
        }
        pageHashes.push(await sha256(utf8(JSON.stringify(entries)))); this.check(initial.intent.operation);
        const sent = await this.transport.rotationCatalog(initial.intent, initial.coordinator, start / ROTATION_PAGE_HEADS, entries);
        this.check(initial.intent.operation);
        status = sent.outcome === "lost" ? await this.status(pending) : sent.value;
        this.bind(status, pending);
        if (status.catalog_heads < start + entries.length) return refuse();
      }
      const hash = hex(await sha256(concat(...pageHashes))); this.check(initial.intent.operation);
      status = await this.status(pending);
      if (status.catalog_hash !== hash || status.catalog_pages !== pageHashes.length || status.catalog_heads !== inventory.length ||
          JSON.stringify(status.catalog_last) !== JSON.stringify(inventory.at(-1) ?? null)) return refuse();
      // Commit material is acknowledged locally before any commit can be sent.
      await this.state.markRotationCommit({ catalogPages: pageHashes.length, catalogHash: hash });
      this.check(initial.intent.operation);
    });
  }

  /** Requires a new plugin load and a fresh full-backup readback. */
  commit(token: string, backup: string): Promise<void> {
    return this.exclusive(async () => {
      const pending = this.pending();
      if (pending.phase !== "commit_unknown" || this.loadedOperation !== pending.rotation.intent.operation) {
        throw new Error("Restart Obsidian after preparing this transition, then confirm the complete new backup before committing.");
      }
      await this.confirmBackup(pending, backup);
      let result = await this.status(pending);
      if (!result.committed) {
        const sent = await this.transport.commitRotation(result, token); this.check(pending.rotation.intent.operation);
        result = sent.outcome === "lost" ? await this.status(pending) : sent.value;
        this.bind(result, pending);
      }
      if (!result.committed) return refuse();
      await this.state.activateRotation(); this.assertCurrent();
    });
  }
}
