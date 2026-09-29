/**
 * The status indicator (issues #156, #209): what obsync is doing, at a glance.
 *
 * ONE ICON, ONE WIDTH, NO WORDS. The status bar item used to be text --
 * `obsync: idle`, `obsync: syncing 1` -- whose width changed with every state,
 * so typing in a note, which pushes a version per pause, shifted the WHOLE
 * status bar left and right. It is now one icon of a fixed width
 * (`styles.css`, `.obsync-status`): a check when this device is up to date, a
 * slowly turning wheel while it syncs, a cloud struck through while the server
 * does not answer, an alert when something needs the person, a pause for a
 * paused note. The words -- always starting "obsync:" -- are its tooltip and
 * accessible name, and Show sync status, which a click opens, says them in
 * full with the next step.
 *
 * NO FLICKER. A push that ends in less than `SYNCING_AFTER_MS` never shows
 * the wheel, and a wheel once shown stays `SYNCING_HOLD_MS`, so a burst of
 * saves reads as the check it ends in and a long transfer as the wheel. Every
 * other change is shown at once: absence and a refusal are never delayed.
 *
 * PLATFORM. Desktop shows it in the status bar. Obsidian's mobile app hides
 * the status bar, so a phone or tablet shows the same indicator as an action
 * in the header of the view in front (`main.ts`, `placeIndicator`). Under
 * reduced motion the wheel does not turn; its shape alone tells it apart.
 */

import { getIcon, setIcon, setTooltip } from "obsidian";
import type { EngineStatus } from "../sync/engine";

export type Indicated = "synced" | "syncing" | "offline" | "attention" | "paused" | "quiet";

/**
 * Each state's icon, by Lucide name. Obsidian ships Lucide and has renamed
 * some of its icons between releases, so a state lists the names it answers
 * to and takes the first this app knows.
 */
const ICONS: Record<Indicated, string[]> = {
  synced: ["check"],
  syncing: ["refresh-cw"],
  offline: ["cloud-off"],
  attention: ["circle-alert", "alert-circle"],
  paused: ["circle-pause", "pause-circle", "pause"],
  quiet: ["cloud"],
};

export const SYNCING_AFTER_MS = 500;
export const SYNCING_HOLD_MS = 800;

/** What a status shows as; `quiet` is an idle device that syncs nothing. */
export function indicated(status: EngineStatus, quiet: boolean): Indicated {
  switch (status.kind) {
    case "idle":
      return quiet ? "quiet" : "synced";
    case "syncing":
      return "syncing";
    case "offline":
      return "offline";
    case "error":
      return "attention";
    case "paused":
      return "paused";
  }
}

const calm = (state: Indicated | null): boolean => state === "synced" || state === "quiet";

export class Indicator {
  private readonly elements = new Set<HTMLElement>();
  private readonly icons = new Map<Indicated, string>();
  private shown: Indicated | null = null;
  private label = "obsync";
  /** When `shown` began, for the hold. */
  private since = 0;
  /** When the truth last turned from calm to syncing, for the delay. */
  private busySince: number | null = null;
  /** The latest truth, which a pending re-check shows if it still holds. */
  private latest: { state: Indicated; label: string } | null = null;
  private timer: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Draw on `el` too, from now on; it gets the fixed width and the click cursor. */
  attach(el: HTMLElement): void {
    el.addClass("obsync-status", "mod-clickable");
    this.elements.add(el);
    this.draw(el);
  }

  detach(el: HTMLElement): void {
    this.elements.delete(el);
  }

  /** The truth changed: show it now, or when the delay or the hold says. */
  update(state: Indicated, label: string): void {
    const now = this.now();
    this.latest = { state, label };
    if (state === "syncing") this.busySince ??= now;
    else this.busySince = null;
    const wait = state === "syncing" && calm(this.shown)
      ? SYNCING_AFTER_MS - (now - (this.busySince ?? now))
      : this.shown === "syncing" && calm(state) ? SYNCING_HOLD_MS - (now - this.since) : 0;
    if (wait > 0) {
      this.timer ??= window.setTimeout(() => {
        this.timer = null;
        if (this.latest !== null) this.update(this.latest.state, this.latest.label);
      }, wait);
      return;
    }
    if (state !== this.shown) {
      this.shown = state;
      this.since = now;
    }
    this.label = label;
    for (const el of this.elements) this.draw(el);
  }

  stop(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.elements.clear();
  }

  private draw(el: HTMLElement): void {
    const state = this.shown;
    if (state === null) return;
    // The icon only when the state changed: a page counted down note by note
    // redraws the words, not the picture.
    if (el.getAttribute("data-state") !== state) {
      setIcon(el, this.icon(state));
      el.setAttr("data-state", state);
    }
    setTooltip(el, this.label, { placement: "top" });
  }

  private icon(state: Indicated): string {
    let name = this.icons.get(state);
    if (name === undefined) {
      const names = ICONS[state];
      name = names.find((candidate) => getIcon(candidate) !== null) ?? (names[0] as string);
      this.icons.set(state, name);
    }
    return name;
  }
}
