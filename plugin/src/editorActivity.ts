import type { MarkdownView, TFile } from "obsidian";
import type { Timers } from "./sync/engine";
import { pageTimers } from "./clock";

/** Human attribution for rewrite detection; never an incoming-write deadline. */
export const RECENT_INPUT_MS = 10_000;
/** At most one requested save per view per interval, including continuous input. */
export const EDITOR_SAVE_MS = 5;
/** Wait for an already scheduled native save, never for typing to stop. */
export const EDITOR_SAVE_WAIT_MS = 100;
/** Bound extra whole-text reads on mobile. Larger notes retain native autosave. */
export const EDITOR_SAVE_MAX_CHARS = 1 << 20;

/** A replaced, unapplied write is distinct from a failed native reload. */
export type ReloadOutcome = "confirmed" | "superseded" | "unconfirmed";

interface Input {
  file: TFile;
  generation: object;
  at: number;
  composing: boolean;
  saved?: { text: string; generation: object };
}

interface EditorAccess {
  views(path: string): MarkdownView[];
  read(file: TFile): Promise<string>;
  enabled(path: string): boolean;
  saved(path: string): void;
  log(line: string): void;
}

const normalized = (text: string): string => text.replace(/\r\n?/g, "\n");

/**
 * Three independent facts: recent human input, unfinished composition, and a
 * confirmed save of that exact input. A clock cannot prove the last one.
 * Only the public save/read API supplies a receipt; input or rebinding revokes
 * it. The final writer still compares every editor with disk immediately
 * before committing. No content or path is included in diagnostics.
 */
export class EditorActivity {
  private readonly inputs = new WeakMap<MarkdownView, Input>();
  private readonly revisions = new WeakMap<TFile, { generation: object; token: object }>();
  private readonly snapshots = new WeakMap<MarkdownView, { file: TFile; text: string; generation: object }>();
  private readonly timers = new Map<MarkdownView, unknown>();
  private readonly saving = new Set<MarkdownView>();
  private readonly saveWaiters = new Set<() => void>();
  private readonly reloading = new Set<string>();
  private readonly nativeOnly = new WeakMap<MarkdownView, TFile>();
  private generation = {};

  constructor(private readonly access: EditorAccess, private readonly clock: Timers = pageTimers) {}

  record(view: MarkdownView, kind: string): void {
    const file = view.file;
    if (!file) return;
    const before = this.inputs.get(view);
    const composing = before?.file === file && before.composing;
    if (kind === "focusout" && !composing) return;
    if (kind === "beforeinput") this.revisions.set(file, { generation: this.generation, token: {} });
    this.inputs.set(view, {
      file, generation: this.generation, at: Date.now(),
      composing: kind === "compositionstart" || (composing && kind !== "compositionend" && kind !== "focusout"),
    });
    this.schedule(view);
  }

  recent(view: MarkdownView): boolean {
    const input = this.inputs.get(view);
    return input?.file === view.file && (input.composing || Date.now() - input.at < RECENT_INPUT_MS);
  }

  /** Opaque trusted-input identity, independent of saves and remote reloads.
   * It grants no write permission and retains no text, key or timestamp. */
  revision(path: string): object | undefined {
    if (!this.access.enabled(path)) return undefined;
    const file = this.access.views(path)[0]?.file;
    const revision = file && this.revisions.get(file);
    return revision?.generation === this.generation ? revision.token : undefined;
  }

  /** The native refresh bridge must not save unfinished composition or a
   * view whose save ownership has fallen back to the host. */
  canRefresh(view: MarkdownView): boolean {
    const input = this.inputs.get(view);
    return input !== undefined && input.generation === this.generation && input.file === view.file && !input.composing &&
      this.recent(view) && !this.saving.has(view) && this.nativeOnly.get(view) !== input.file &&
      this.access.enabled(input.file.path);
  }

  /** A completed native save stays publishable while later input is unsaved.
   * This proves only a historical complete snapshot, never write readiness. */
  savedSnapshot(path: string, text: string): boolean {
    return this.access.enabled(path) && this.access.views(path).some((view) => {
      const saved = this.snapshots.get(view);
      return saved?.file === view.file && saved?.generation === this.generation &&
        this.nativeOnly.get(view) !== view.file && this.recent(view) && saved.text === normalized(text);
    });
  }

  async ready(path: string, unchanged?: () => Promise<boolean>): Promise<boolean> {
    return await this.prepareWrite(path, unchanged) !== null;
  }

  /** Join a save already in progress before probing again. No polling or new
   * save is started here, and completion itself never grants write readiness. */
  async settle(path: string): Promise<boolean> {
    if (await this.ready(path)) return true;
    const generation = this.generation, views = this.access.views(path);
    const files = views.map((view) => view.file);
    const pending = (): boolean => views.some((view) => this.saving.has(view) || this.timers.has(view));
    if (!this.access.enabled(path) || this.reloading.has(path) ||
      views.some((view) => this.inputs.get(view)?.composing) || !pending()) return false;
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.clock.clear(timer);
        this.saveWaiters.delete(wake);
        resolve();
      };
      const wake = (): void => { if (generation !== this.generation || !pending()) done(); };
      const timer = this.clock.set(done, EDITOR_SAVE_WAIT_MS);
      this.saveWaiters.add(wake);
    });
    const current = this.access.views(path);
    const bound = generation === this.generation && this.access.enabled(path) &&
      views.length === current.length && views.every((view, i) => view === current[i] && view.file === files[i]);
    const ready = bound && await this.ready(path);
    this.access.log(`editor decision=${ready ? "ready" : "deferred"} reason=save_completion duration_ms=${Date.now() - started} budget_ms=${EDITOR_SAVE_WAIT_MS}`);
    return ready;
  }

  /** Return the checked disk baseline, never a separately sampled editor value.
   * Every await is followed by identity, input-generation and text checks. */
  async prepareWrite(path: string, unchanged?: () => Promise<boolean>, read = this.access.read): Promise<{ text: string | null } | null> {
    if (this.reloading.has(path)) return null;
    const views = this.access.views(path);
    const file = views[0]?.file;
    if (!file) {
      if (unchanged !== undefined && !await unchanged()) return null;
      return !this.reloading.has(path) && this.access.views(path).length === 0 ? { text: null } : null;
    }
    const inputs = views.map((view) => this.inputs.get(view));
    const files = views.map((view) => view.file);
    // A disk read cannot make an unfinished save, composition or dirty input
    // ready. Refuse those known states before joining the mobile adapter's
    // queue; repeated readiness probes otherwise delay the save they need.
    // The independent read and all post-await checks still prove acceptance.
    if (views.some((view, i) => this.saving.has(view) ||
      (this.recent(view) && (inputs[i]?.saved?.generation !== this.generation ||
        inputs[i]?.saved?.text !== normalized(view.getViewData()))))) return null;
    const disk = normalized(await read(file));
    if (unchanged !== undefined && !await unchanged()) return null;
    const current = this.access.views(path);
    if (this.reloading.has(path) || views.length !== current.length || views.some((view, i) => view !== current[i])) return null;
    const ready = views.every((view, i) => {
      const input = this.inputs.get(view);
      if (this.saving.has(view) || view.file !== files[i] || view.file?.path !== path || input !== inputs[i] || input?.composing) return false;
      const current = normalized(view.getViewData());
      if (current === disk && (!this.recent(view) || (input?.saved?.text === disk && input.saved.generation === this.generation))) return true;
      return false;
    });
    return ready ? { text: disk } : null;
  }

  /** The native reload may advance this receipt only when its buffer matches disk.
   * New input revokes it even while that reload is pending. Never creates a receipt. */
  expectRefresh(view: MarkdownView, before: string, after: string): void {
    const input = this.inputs.get(view);
    if (input?.file === view.file && input.saved?.generation === this.generation &&
      input.saved.text === before) input.saved.text = after;
  }

  /** Never save a pre-reload buffer onto the version being loaded into it. */
  holdReload(path: string): ((outcome: ReloadOutcome) => void) | null {
    if (this.reloading.has(path)) return null;
    this.reloading.add(path);
    const started = Date.now();
    const views = this.access.views(path).map((view) => ({ view, file: view.file })), generation = this.generation;
    let released = false;
    return (outcome) => {
      if (released) return;
      released = true;
      if (generation !== this.generation) return;
      this.reloading.delete(path);
      if (outcome !== "confirmed") this.access.log(`editor decision=reload_released outcome=${outcome} views=${views.length} duration_ms=${Date.now() - started} budget_ms=0`);
      for (const { view, file } of views) {
        if (!file || view.file !== file) continue;
        const input = this.inputs.get(view);
        if (outcome !== "confirmed" && input) delete input.saved;
        if (outcome === "unconfirmed") {
          this.nativeOnly.set(view, file);
        } else {
          // Supersession refused the incoming ancestry. A fresh save/read may
          // publish the native input against the old version; no reload failed.
          // Do not lift a demotion from an earlier, genuinely failed reload.
          if (!input?.saved) this.schedule(view);
        }
      }
    };
  }

  /** Cancel pending saves on pause, leave and unload; invalidate in-flight receipts. */
  stop(): void {
    this.generation = {};
    for (const timer of this.timers.values()) this.clock.clear(timer);
    this.timers.clear();
    this.reloading.clear();
    for (const wake of this.saveWaiters) wake();
  }

  private schedule(view: MarkdownView): void {
    const input = this.inputs.get(view);
    if (!input || input.composing || this.reloading.has(input.file.path) || this.nativeOnly.get(view) === input.file || !this.access.enabled(input.file.path) ||
      this.timers.has(view) || this.saving.has(view)) return;
    const generation = this.generation;
    this.timers.set(view, this.clock.set(() => {
      this.timers.delete(view);
      void this.save(view, generation).finally(() => { for (const wake of this.saveWaiters) wake(); });
    }, EDITOR_SAVE_MS));
  }

  private async save(view: MarkdownView, generation: object): Promise<void> {
    const input = this.inputs.get(view);
    if (!input || input.composing || this.reloading.has(input.file.path) || this.nativeOnly.get(view) === input.file || view.file !== input.file || generation !== this.generation ||
      !this.access.enabled(input.file.path) || !this.access.views(input.file.path).includes(view)) return;
    const started = Date.now();
    if (normalized(view.getViewData()).length > EDITOR_SAVE_MAX_CHARS) {
      this.access.log(`editor decision=deferred reason=save_budget duration_ms=${Date.now() - started} budget_chars=${EDITOR_SAVE_MAX_CHARS}`);
      return;
    }
    this.saving.add(view);
    try {
      // A native reload can already be queued when its buffer becomes visible.
      // Finish the adapter's earlier reads while the editor is still dirty:
      // save() clears that flag before waiting for disk, so starting it first
      // lets a stale native read replace a keystroke without merging it.
      await this.access.read(input.file);
      if (generation !== this.generation || !this.access.enabled(input.file.path) ||
        this.inputs.get(view) !== input || view.file !== input.file ||
        !this.access.views(input.file.path).includes(view)) return;
      const text = normalized(view.getViewData());
      // Disagreeing panes keep native save ownership; this helper cannot pick
      // which buffer wins. Bound the extra whole-text work on phones too.
      if (text.length > EDITOR_SAVE_MAX_CHARS ||
        this.access.views(input.file.path).some((other) => normalized(other.getViewData()) !== text)) return;
      await view.save();
      const disk = normalized(await this.access.read(input.file));
      if (generation === this.generation && this.access.enabled(input.file.path) && view.file === input.file &&
        this.access.views(input.file.path).includes(view) && disk === text) {
        this.snapshots.set(view, { file: input.file, text, generation });
      }
      if (generation !== this.generation || !this.access.enabled(input.file.path) ||
        this.inputs.get(view) !== input || view.file !== input.file ||
        !this.access.views(input.file.path).includes(view) || normalized(view.getViewData()) !== text || disk !== text) return;
      input.saved = { text, generation };
      this.access.log(`editor decision=saved duration_ms=${Date.now() - started} budget_ms=${EDITOR_SAVE_MS}`);
      this.access.saved(input.file.path);
    } catch {
      this.access.log(`editor decision=deferred reason=save_failed duration_ms=${Date.now() - started} budget_ms=${EDITOR_SAVE_MS}`);
    } finally {
      this.saving.delete(view);
      // A new input during an in-flight save needs its own receipt. A failed
      // save without new input does not create an unbounded retry loop.
      if (generation === this.generation && this.inputs.get(view) !== input) this.schedule(view);
    }
  }
}
