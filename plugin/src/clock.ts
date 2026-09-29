/**
 * TIMERS A HIDDEN WINDOW DOES NOT SLOW (issue #221).
 *
 * Chromium, which Obsidian's desktop app runs on, throttles timers in a
 * hidden page: after a few minutes, a timer set from another timer fires at
 * most once a minute. The upload path is such a chain -- the watcher's
 * debounce, the growing-file recheck, the retries -- so a change made while
 * the window was minimized, behind another window or on another desktop
 * waited minutes for its upload. Measured on macOS, Obsidian 1.13.4, ten
 * chained 100 ms timers: 384 s on the hidden page, 1.9 s through a dedicated
 * worker, whose timers are not throttled and whose messages to the page are
 * not either.
 *
 * So every timer is armed twice, on the page's own clock and in the worker,
 * and whichever is due first runs it; the other finds nothing under its id.
 * The worker can only make a timer EARLIER: one that cannot be made, fails,
 * or is stopped leaves the page's clock to fire everything, as it always
 * did, and the first two say so in one line.
 *
 * Desktop only (`main.ts`): a phone suspends a backgrounded app whole, and a
 * foreground one is not throttled this way.
 */

import type { Timers } from "./sync/engine";

/** The page's own clock: `window`'s, for the reason `defaultTimers` in sync/engine gives. */
export const pageTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

/** Arms one timer per message and posts its id back when due; a message without `ms` disarms it. */
export const WORKER_SOURCE = `"use strict";
const armed = new Map();
self.onmessage = ({ data: { id, ms } }) => {
  if (ms === undefined) { self.clearTimeout(armed.get(id)); armed.delete(id); return; }
  armed.set(id, self.setTimeout(() => { armed.delete(id); self.postMessage(id); }, ms));
};
`;

/** What the clock uses of a dedicated `Worker`; a test hands in a fake. */
export type WorkerPort = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/**
 * A worker running `WORKER_SOURCE`, from a Blob URL revoked once the worker
 * holds it. `window`'s own constructors: in Electron the bare `URL` and `Blob`
 * may be Node's, whose object URLs a renderer's worker cannot load.
 */
export function spawnWorker(): WorkerPort {
  const url = window.URL.createObjectURL(new window.Blob([WORKER_SOURCE], { type: "text/javascript" }));
  try {
    return new window.Worker(url);
  } finally {
    window.URL.revokeObjectURL(url);
  }
}

export interface Clock extends Timers {
  /** End the worker. What is armed still fires, on the page's clock. */
  stop(): void;
}

/** Timers armed on `page` and in the worker `spawn` makes, each run by whichever is due first. */
export function workerClock(page: Timers, log: (line: string) => void, spawn: () => WorkerPort = spawnWorker): Clock {
  const armed = new Map<number, { fn: () => void; handle: unknown }>();
  let next = 0;
  let worker: WorkerPort | null = null;
  /** Forget `id` and disarm it on the page: its callback, or `undefined` once it ran or was cleared. */
  const take = (id: number): (() => void) | undefined => {
    const timer = armed.get(id);
    armed.delete(id);
    if (timer !== undefined) page.clear(timer.handle);
    return timer?.fn;
  };
  const stop = (): void => {
    worker?.terminate();
    worker = null;
  };
  try {
    worker = spawn();
    worker.onmessage = (event) => take(event.data as number)?.();
    worker.onerror = () => {
      stop();
      log(`timers decision=fallback reason=worker_error pending=${armed.size}`);
    };
  } catch (error) {
    log(`timers decision=fallback reason=${error instanceof Error ? error.name : "unknown"}`);
  }
  return {
    set(fn, ms) {
      const id = ++next;
      armed.set(id, { fn, handle: page.set(() => take(id)?.(), ms) });
      worker?.postMessage({ id, ms });
      return id;
    },
    clear(handle) {
      if (take(handle as number) !== undefined) worker?.postMessage({ id: handle });
    },
    stop,
  };
}
