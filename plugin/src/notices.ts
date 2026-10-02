/**
 * The one channel every obsync notice goes through, and the Recent list
 * (`docs/architecture.md` 6.4, "Notices", which holds the wording rules and
 * the command line's documented output).
 *
 * A notice says what it is (`kind`), which notes it is about (`paths`,
 * shown by title) and which device (`device`, shown by name), in one plain
 * sentence. This module decides whether it becomes a toast: it keeps a
 * repeat of the same event inside the toast already on screen instead of
 * stacking another, it folds a flood beyond three toasts into one "N more"
 * toast, and it records every notice -- shown or kept quiet -- in a bounded
 * Recent list that Show sync status and the CLI read.
 *
 * SETTINGS NEVER SILENCE A CONTROL (AGENTS.md requirement 4). A `question`
 * waits for an answer and a `security` notice protects the vault, so neither
 * is ever kept quiet, folded, or merged into another, under any setting, on
 * any platform. `error`, `conflict` and `confirm` are shown under every
 * level too. There is no platform branch in this file: a phone and a desktop
 * decide identically (the silenced-mobile failure a sync plugin's mute had).
 *
 * Nothing here imports Obsidian; `main.ts` draws the toasts (`NoticeScreen`).
 */

import type { NoticeAction } from "./sync/engine";

/**
 * What a notice is, which decides how long it stays and whether a setting
 * may keep it quiet (`STAYS_MS`, `toasts`).
 */
export type NoticeKind = "question" | "security" | "error" | "conflict" | "combined" | "info" | "confirm";

export interface SyncNotice {
  readonly kind: NoticeKind;
  /**
   * One plain sentence, without the "obsync: " every toast begins with.
   * `{notes}` stands for the notes' titles, `{it}` for "it" or "them" as
   * they number, and `{device}` for the device's name, so one sentence reads
   * right for one note or a burst of them. `{code}` is `code`.
   */
  readonly text: string;
  /** The notes it is about, as vault paths: shown by title, opened from Recent. */
  readonly paths?: readonly string[];
  /**
   * The device it is about, by NAME, as `SyncContext.deviceNameFor` gives it
   * ("another device" when the name is unknown): never an id, so no id can
   * reach a toast, the Recent list or the CLI.
   */
  readonly device?: string;
  /**
   * Notices with one key are one event: a second one while the first's toast
   * is on screen joins that toast, unless either has buttons. By default the
   * kind, sentence and device. A question with the key of one on screen
   * replaces it.
   */
  readonly key?: string;
  readonly actions?: readonly NoticeAction[];
  /** What a click on the toast opens. */
  readonly open?: () => void;
  /**
   * A one-time code the person must compare, such as a pairing's match
   * code: the toast shows it in `{code}`, and nothing that outlives the toast
   * does -- Recent, the command line and every log line read `MASK`.
   */
  readonly code?: string;
}

export type NoticeLevel = "everything" | "needs-me";
export type CombinedNotices = "once" | "every" | "off";

/** The two notice settings (`ObsyncData.notices`): Settings, the palette and the CLI set them. */
export interface NoticeSettings {
  level: NoticeLevel;
  merges: CombinedNotices;
}

export const NOTICE_DEFAULTS: Readonly<NoticeSettings> = { level: "everything", merges: "once" };

/** Every value, with the words Settings shows for it, in the order it lists them. */
export const LEVELS: readonly [NoticeLevel, string][] = [["everything", "Everything useful"], ["needs-me", "Only what needs me"]];
export const MERGES: readonly [CombinedNotices, string][] = [["once", "Once per note"], ["every", "Every time"], ["off", "Recent only"]];

/** The kinds no setting may keep off the screen (AGENTS.md requirement 4). */
export const NON_MUTABLE: ReadonlySet<NoticeKind> = new Set<NoticeKind>(["question", "security"]);

/** How long each kind stays: 0 is until answered or dismissed. */
export const STAYS_MS: Readonly<Record<NoticeKind, number>> = {
  question: 0, security: 0, error: 0, conflict: 8000, combined: 8000, info: 8000, confirm: 4000,
};

/**
 * Long enough to read: a toast that goes by itself stays at least a second
 * plus a quarter second a word, up to twenty seconds (`stays`).
 */
const READ_MS_PER_WORD = 250;
const READ_MAX_MS = 20_000;
/** What Recent, the command line and the log keep of a notice's `code`. */
export const MASK = "•••";
/** How many obsync toasts may be on screen before the rest become one "N more" toast. */
export const VISIBLE_MAX = 3;
/** How many notices Recent keeps, newest last. */
export const RECENT_MAX = 50;
/**
 * "Once per note": after a combine in a note is announced, more combines in
 * it stay quiet until it has gone this long without one.
 */
export const ONCE_IDLE_MS = 5 * 60_000;
/** The key of the one held-deletions question on screen (`engine.ts`, `HELD_ACTIONS`). */
export const HELD = "held";

/** Read a saved value onto the defaults: anything unreadable is the default, never an error. */
export function noticeSettings(value: unknown): NoticeSettings {
  const saved = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const level = LEVELS.find(([option]) => option === saved["level"]);
  const merges = MERGES.find(([option]) => option === saved["merges"]);
  return { level: level?.[0] ?? NOTICE_DEFAULTS.level, merges: merges?.[0] ?? NOTICE_DEFAULTS.merges };
}

/**
 * Whether a notice of this kind may become a toast under the settings.
 * `question` and `security` answer yes whatever the settings hold. Only
 * `combined` and `info` read them at all, so `settings` is asked, never read
 * ahead: a notice after unload tore the state down reads nothing.
 */
export function toasts(kind: NoticeKind, settings: () => NoticeSettings): boolean {
  if (NON_MUTABLE.has(kind)) return true;
  if (kind === "combined") return settings().level === "everything" && settings().merges !== "off";
  if (kind === "info") return settings().level === "everything";
  return true;
}

/**
 * Each note as a person knows it: its title, the name without `.md`; any
 * other file keeps its extension. Two notes that share a title keep their
 * folder, so the two can be told apart.
 */
export function titles(paths: readonly string[]): string[] {
  const bare = (path: string): string => path.endsWith(".md") ? path.slice(0, -3) : path;
  const names = paths.map((path) => bare(path.slice(path.lastIndexOf("/") + 1)));
  return paths.map((path, index) => names.indexOf(names[index] as string) === names.lastIndexOf(names[index] as string) ? names[index] as string : bare(path));
}

/** One name as a person knows it, quoted: a note by its title, a folder or any other file by its own name. */
export function quoted(path: string): string {
  return `"${titles([path])[0] ?? path}"`;
}

/** "1 note", "3 notes": a count and what it counts. */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** `"Plan"`, `2 notes ("Plan" and "Log")`, `3 notes ("Plan", "Log" and 1 more)`. */
export function named(paths: readonly string[]): string {
  const unique = [...new Set(paths)];
  const shown = titles(unique).map((title) => `"${title}"`);
  if (shown.length <= 1) return shown[0] ?? "a note";
  const noun = unique.every((path) => path.endsWith(".md")) ? "notes" : "files";
  const listed = shown.length === 2 ? `${shown[0]} and ${shown[1]}` : `${shown[0]}, ${shown[1]} and ${shown.length - 2} more`;
  return `${shown.length} ${noun} (${listed})`;
}

/**
 * The sentence for these notes; `times` above one says the same thing
 * happened again. The code is shown only where `shown` says so: the toast.
 */
export function sentence(notice: SyncNotice, paths: readonly string[] = notice.paths ?? [], times = 1, shown = false): string {
  const unique = new Set(paths).size;
  const slots: Record<string, string> = {
    notes: named(paths), it: unique > 1 ? "them" : "it", device: notice.device ?? "another device",
    code: shown ? notice.code ?? MASK : MASK,
  };
  const text = notice.text.replace(/\{(notes|it|device|code)\}/g, (_, slot: string) => slots[slot] as string);
  return times > 1 ? text.replace(/\.?$/, ` (${times} times).`) : text;
}

/** What a toast of this notice says: "obsync: ", or "obsync security warning: ", and the sentence. */
export function toastText(notice: SyncNotice, paths?: readonly string[], times?: number): string {
  return `obsync${notice.kind === "security" ? " security warning" : ""}: ${sentence(notice, paths, times, true)}`;
}

/** How long a toast of this kind and these words stays (`STAYS_MS`, `READ_MS_PER_WORD`); 0 is until dismissed. */
export function stays(kind: NoticeKind, text: string): number {
  if (STAYS_MS[kind] === 0) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(STAYS_MS[kind], Math.min(READ_MAX_MS, 1000 + words * READ_MS_PER_WORD));
}

/**
 * Output that leaves Obsidian (the CLI) never carries a long hex run: an id,
 * a key or a hash is a support detail for the log, never for a terminal.
 */
export function scrub(text: string): string {
  return text.replace(/[0-9a-f]{16,}/gi, "…");
}

/** A toast on screen, as the screen reports it. */
export interface Drawn {
  /** Replace its words. */
  update(text: string): void;
  hide(): void;
  /** Not yet hidden: by its timer, a click, a button, or this channel. */
  shown(): boolean;
}

/** What draws, and what the channel reads: `main.ts` gives it Obsidian's. */
export interface NoticeScreen {
  /** One toast for `ms` (0: until dismissed), a button per action, and `open` on a click. */
  draw(text: string, ms: number, actions: readonly NoticeAction[], open?: () => void): Drawn;
  settings(): NoticeSettings;
  now(): number;
  log(line: string): void;
  /** Show sync status, where Recent is: what the "N more" toast opens. */
  showStatus(): void;
}

export interface RecentEntry {
  readonly at: number;
  readonly kind: NoticeKind;
  /** The sentence as the toast said it, without "obsync: ". */
  readonly text: string;
  readonly paths: readonly string[];
  /** The device's name, as the notice gave it. */
  readonly device?: string;
}

interface Toast {
  drawn: Drawn;
  at: number;
  ms: number;
}

interface Group extends Toast {
  notice: SyncNotice;
  paths: string[];
  times: number;
}

/** A Recent line as kept: the notice, and how many times in a row it happened (`remember`). */
interface Kept {
  entry: RecentEntry;
  notice: SyncNotice;
  times: number;
}

export class NoticeChannel {
  private readonly recentList: Kept[] = [];
  /** The toast of each key on screen now, a notice of that key joins it (`show`). */
  private readonly groups = new Map<string, Group>();
  /** One toast per key that is never merged: questions and security notices. */
  private readonly slots = new Map<string, Toast>();
  private overflow: (Toast & { count: number }) | null = null;
  /** When each note last had its edits combined with another device's (`ONCE_IDLE_MS`). */
  private readonly combinedAt = new Map<string, number>();

  constructor(private readonly screen: NoticeScreen) {}

  /** Every notice so far this session, newest first; one said again in a row is one line that counts it. */
  recent(): readonly RecentEntry[] {
    return this.recentList.map(({ entry, notice, times }) =>
      times > 1 ? { ...entry, text: sentence(notice, entry.paths, times) } : entry).reverse();
  }

  /** Take the toast of this key off the screen, whatever its kind (#308); Recent keeps its line. */
  close(key: string): void {
    this.slots.get(key)?.drawn.hide();
    this.slots.delete(key);
    this.groups.get(key)?.drawn.hide();
    this.groups.delete(key);
  }

  show(notice: SyncNotice): void {
    const now = this.screen.now();
    const { kind } = notice;
    this.remember({ at: now, kind, text: sentence(notice), paths: notice.paths ?? [], ...notice.device === undefined ? {} : { device: notice.device } }, notice);
    const quiet = this.quiet(notice, now);
    if (quiet !== null) {
      this.screen.log(`notice decision=quiet kind=${kind} ${quiet}`);
      return;
    }
    const key = notice.key ?? `${kind}\u0000${notice.text}\u0000${notice.device ?? ""}`;
    const text = toastText(notice);
    const ms = stays(kind, text);
    if (NON_MUTABLE.has(kind)) {
      this.slot(key, text, ms, notice);
      this.screen.log(`notice decision=shown kind=${kind} stays_ms=${ms}`);
      return;
    }
    // A notice with buttons is its own toast: joined, they would act for the first note only.
    const group = notice.actions?.length ? undefined : this.groups.get(key);
    if (group !== undefined && live(group, now)) {
      for (const path of notice.paths ?? []) if (!group.paths.includes(path)) group.paths.push(path);
      group.times++;
      group.drawn.update(toastText(group.notice, group.paths, group.paths.length <= 1 ? group.times : 1));
      this.screen.log(`notice decision=joined kind=${kind} since_ms=${now - group.at} budget_ms=${group.ms} count=${group.times}`);
      return;
    }
    const visible = this.visible(now);
    if (visible >= VISIBLE_MAX) {
      this.fold(kind, now);
      this.screen.log(`notice decision=folded kind=${kind} visible=${visible} budget=${VISIBLE_MAX} count=${this.overflow?.count ?? 0}`);
      return;
    }
    const drawn = this.screen.draw(text, ms, notice.actions ?? [], notice.open);
    this.groups.set(key, { drawn, at: now, ms, notice, paths: [...notice.paths ?? []], times: 1 });
    this.screen.log(`notice decision=shown kind=${kind} stays_ms=${ms}`);
  }

  /** Why this notice stays off the screen, as the log line's fields, or `null` to show it. */
  private quiet(notice: SyncNotice, now: number): string | null {
    // Asked, never read ahead: only the kinds that answer to a setting read one (`toasts`).
    const settings = (): NoticeSettings => this.screen.settings();
    let last = -Infinity;
    if (notice.kind === "combined") {
      for (const path of notice.paths ?? []) {
        last = Math.max(last, this.combinedAt.get(path) ?? -Infinity);
        this.combinedAt.set(path, now);
      }
      if (this.combinedAt.size > RECENT_MAX * 4) {
        for (const [path, at] of this.combinedAt) if (now - at >= ONCE_IDLE_MS) this.combinedAt.delete(path);
      }
    }
    if (!toasts(notice.kind, settings)) return `reason=setting level=${settings().level} merges=${settings().merges}`;
    if (notice.kind === "combined" && settings().merges === "once" && now - last < ONCE_IDLE_MS) {
      return `reason=once_per_note since_ms=${now - last} budget_ms=${ONCE_IDLE_MS}`;
    }
    return null;
  }

  /** A question or security notice: its own toast, replacing the one of its key. */
  private slot(key: string, text: string, ms: number, notice: SyncNotice): void {
    this.close(key);
    this.slots.set(key, { drawn: this.screen.draw(text, ms, notice.actions ?? [], notice.open), at: this.screen.now(), ms });
  }

  /**
   * THE SAME THING SAID AGAIN, WITH NOTHING BETWEEN, IS ONE LINE THAT COUNTS
   * IT, as its toast does (1.1.5): twenty presses of Sync now were twenty
   * lines, and fifty would push a security warning out of Recent.
   */
  private remember(entry: RecentEntry, notice: SyncNotice): void {
    const last = this.recentList[this.recentList.length - 1];
    if (last !== undefined && last.entry.kind === entry.kind && last.entry.text === entry.text
      && last.entry.device === entry.device && last.entry.paths.join("\u0000") === entry.paths.join("\u0000")) {
      last.times++;
      last.entry = { ...last.entry, at: entry.at };
      return;
    }
    this.recentList.push({ entry, notice, times: 1 });
    if (this.recentList.length > RECENT_MAX) this.recentList.shift();
  }

  /** obsync toasts on screen now; the ones gone are forgotten. */
  private visible(now: number): number {
    let up = 0;
    for (const [key, group] of this.groups) if (live(group, now)) up++; else this.groups.delete(key);
    for (const [key, slot] of this.slots) if (live(slot, now)) up++; else this.slots.delete(key);
    if (this.overflow !== null && live(this.overflow, now)) up++;
    return up;
  }

  /**
   * One more notice than the screen holds: counted on the one "N more" toast,
   * which opens Show sync status. It stays until dismissed once it counts an
   * error, which is drawn again as a sticky toast to do so.
   */
  private fold(kind: NoticeKind, now: number): void {
    const sticky = STAYS_MS[kind] === 0;
    const current = this.overflow !== null && live(this.overflow, now) ? this.overflow : null;
    const count = (current?.count ?? 0) + 1;
    const words = `obsync: ${count} more — see Recent in Show sync status.`;
    if (current !== null && (current.ms === 0 || !sticky)) {
      current.count = count;
      current.drawn.update(words);
      return;
    }
    current?.drawn.hide();
    const ms = sticky ? 0 : STAYS_MS.info;
    this.overflow = { drawn: this.screen.draw(words, ms, [], () => this.screen.showStatus()), at: now, ms, count };
  }
}

/** A toast still on screen: not hidden, and inside its time. */
function live(toast: Toast, now: number): boolean {
  return toast.drawn.shown() && (toast.ms === 0 || now < toast.at + toast.ms);
}
