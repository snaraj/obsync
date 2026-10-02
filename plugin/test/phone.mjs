/**
 * Obsidian on a PHONE, in memory: its index, its adapter and the storage
 * below them, for the real `ObsidianHost` to run on (issue #219).
 *
 * `folds: true` is Android, as measured on an Android 15 emulator with
 * Obsidian 1.13.8 and as its mobile adapter's own code reads there. The
 * shared storage folds capitals the way a Mac does, while the adapter
 * believes it does not (`insensitive` is false), so everything above the
 * storage answers for the folded name:
 *
 *  - `adapter.exists("X/probe.md", true)` is true while only `X/Probe.md`
 *    exists -- the case-sensitive flag answers nothing there;
 *  - `adapter.list` gives the real names;
 *  - the adapter's rename AND the vault's refuse a destination that exists
 *    folded, the source's own other spelling included, with "Destination
 *    file already exists!";
 *  - every adapter call that touches the storage runs in ONE queue, in the
 *    order it was made;
 *  - a rename moves the index entry of the name it was given, and reports a
 *    `rename` for that entry and for every entry under it, a folder's
 *    children included;
 *  - the native watcher reports each name a change touched on the storage,
 *    a turn later, and each report is reconciled in that queue: a name the
 *    storage answers for and the index lacks is indexed UNDER THE NAME
 *    REPORTED, with a `create` -- which, for the old spelling of an entry
 *    re-cased since, is a second index entry for one file (the GHOST); a
 *    name it does not answer for leaves the index 100 ms later, and a hidden
 *    name the index holds leaves it the same way;
 *  - a removal of any spelling removes the entry the storage folds it to,
 *    and the index entry of the name asked for; the watcher's report of the
 *    real name removes that one 100 ms later.
 *
 * So two renames made back to back through a hidden name leave the ghost
 * whenever the watcher's reconcile of the old name runs after the second
 * (6 of 20 on the emulator; always here), and none when a turn and the
 * queue ahead are let run between them (0 of 20).
 *
 * `folds: false` is an iPhone or an iPad, whose "On My iPhone" storage keeps
 * `Probe` and `probe` as two entries. Obsidian indexes no hidden name when it
 * starts (`restart`). `watcher: false` is a watcher that reports nothing,
 * `pause` one whose reports come late, as a busy device's can -- after the
 * wait between the two steps -- and `indexApi: false` an adapter without the
 * private `reconcileDeletion`.
 *
 * Hand-written, stdlib only, and in memory: the same answers on every CI host,
 * whatever its own filesystem folds.
 */

const enc = (text) => new TextEncoder().encode(text);
const parentOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const hidden = (path) => path.split("/").some((part) => part.startsWith("."));
/** Where the emulator's Capacitor filesystem keeps the vault (`adapter.getFullPath`). */
const FULL = "/storage/emulated/0/Documents/phone";

export class PhoneVault {
  constructor(obsidian, { folds = true, delivery = "immediate", watcher = true, indexApi = true } = {}) {
    this.obsidian = obsidian;
    this.folds = folds;
    this.delivery = delivery;
    this.watching = watcher;
    /** The reports held back while paused (`pause`), or `null`. */
    this.paused = null;
    /** The storage: every entry under the name it keeps, `{ bytes, mtime }` for a file and `null` for a folder. */
    this.disk = new Map();
    /** Obsidian's index, by exact path. */
    this.index = new Map();
    this.listeners = new Map();
    /** Every event the vault raised, as `[name, path, oldPath]`. */
    this.events = [];
    /** Every `vault.rename` asked for, as `[from, to]`, refused ones included. */
    this.renames = [];
    /** `(from, to, n) => boolean`: refuse a rename, the adapter's or the vault's (`n` vault renames so far), before it changes anything. */
    this.fault = null;
    /**
     * `(call, path) => Promise | undefined`: what an adapter `list` or `stat`
     * waits on before it answers, as a slow bridge makes it wait (#244). The
     * wait comes before the queue, so the calls made meanwhile still run.
     */
    this.lag = null;
    /**
     * What the index keeps for a file whose bytes landed after Obsidian looked
     * at it (#245): `{ mtime, size }` by path, whatever the storage holds, until
     * a `restart` -- Obsidian mobile watches no filesystem.
     */
    this.cached = new Map();
    /** `(path) => boolean`: this `writeBinary` lands EMPTY, as Android's did (#242). */
    this.dropping = null;
    /** `(path) => void`, the moment an empty write has landed: where a test stops the process (#248). */
    this.onEmpty = null;
    /** Every folder `adapter.fs.readdir` was asked about (#246). */
    this.readdirs = [];
    /** `(folder) => "unreadable" | "shape" | undefined`: that folder's `readdir` throws, or answers entries short of a date (#246). */
    this.readdirFault = null;
    /** The adapter's one queue (`queue`). */
    this.chain = Promise.resolve();
    this.clock = 1757200000000;
    const vault = this;
    this.adapter = {
      // The flag is not an answer on Android; a phone that keeps the
      // spellings apart answers for the exact name whatever it is passed.
      exists: (path) => vault.queue(async () => vault.real(path) !== null),
      stat: (path) => vault.lagged("stat", path, () => vault.queue(async () => {
        const at = vault.real(path);
        if (at === null) return null;
        const file = vault.disk.get(at);
        return file === null ? { type: "folder", ctime: 0, mtime: 0, size: 0 }
          : { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.bytes.length };
      })),
      // Real I/O: the listing answers a turn later.
      list: async (path) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await vault.lag?.("list", path);
        const at = vault.real(path === "/" ? "" : path);
        if (at === null || vault.disk.get(at) !== null && at !== "") throw new Error(`ENOENT: ${path}`);
        const out = { files: [], folders: [] };
        for (const name of vault.names(at)) {
          const child = at === "" ? name : `${at}/${name}`;
          (vault.disk.get(child) === null ? out.folders : out.files).push(child);
        }
        return out;
      },
      // PRIVATE in Obsidian (#246): the full path Capacitor's filesystem takes,
      // "…/" for the vault root as on the emulator, and that filesystem's
      // `readdir`: a folder's entries as the STORAGE has them, each with a
      // name, a type, a size and a date, whatever the index cached.
      getFullPath: (path) => `${FULL}/${path}`,
      fs: {
        readdir: (full) => vault.queue(async () => {
          const folder = full.slice(FULL.length + 1).replace(/\/$/, "");
          vault.readdirs.push(folder);
          const at = vault.real(folder);
          const fault = vault.readdirFault?.(folder);
          if (fault === "unreadable" || at === null || (at !== "" && vault.disk.get(at) !== null)) throw new Error(`ENOENT: ${full}`);
          return vault.names(at).map((name) => {
            const file = vault.disk.get(at === "" ? name : `${at}/${name}`);
            const entry = file === null ? { name, type: "directory", size: 0, mtime: 0, ctime: 0 }
              : { name, type: "file", size: file.bytes.length, mtime: file.mtime, ctime: file.mtime };
            if (fault === "shape") delete entry.mtime;
            return { ...entry, uri: `file://${full}/${name}` };
          });
        }),
      },
      rename: (from, to) => vault.queue(async () => vault.adapterRename(from, to)),
      mkdir: (path) => vault.queue(async () => vault.mkdirs(path, true)),
      readBinary: async (path) => {
        const file = vault.disk.get(vault.real(path) ?? "");
        if (!file) throw new Error(`ENOENT: ${path}`);
        return file.bytes.slice().buffer;
      },
      writeBinary: (path, data, options) => vault.queue(async () => {
        const empty = vault.dropping?.(path) === true;
        vault.write(path, empty ? new Uint8Array() : new Uint8Array(data), options?.mtime ?? vault.clock, true);
        if (empty) vault.onEmpty?.(path);
      }),
      remove: (path) => vault.queue(async () => vault.drop(path)),
      // A name the storage does not answer for, as the emulator did (#234):
      // the system bin declines it and the vault's own `.trash` throws.
      trashLocal: (path) => vault.queue(async () => {
        if (vault.real(path) === null) throw new Error("The source object does not exist");
        vault.drop(path);
      }),
      trashSystem: (path) => vault.queue(async () => {
        if (vault.real(path) === null) return false;
        vault.drop(path);
        return true;
      }),
      rmdir: (path) => vault.queue(async () => vault.drop(path)),
      // PRIVATE in Obsidian: drop a name from the index, touching nothing on the storage.
      ...(indexApi ? { reconcileDeletion: async (_realPath, path, now = true) => { if (now) vault.unindex(path); } } : {}),
    };
    this.fileManager = { trashFile: (file) => vault.adapter.trashLocal(file.path) };
  }

  /** The adapter's queue: every call runs after the ones made before it, failed ones included. */
  queue(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** `answer()`, once whatever `lag` holds this call for is over. */
  lagged(call, path, answer) {
    const wait = this.lag?.(call, path);
    return wait === undefined ? answer() : wait.then(answer);
  }

  /** Let a turn pass and everything queued in it run: what a test waits on before asserting on the index. */
  async settle(ms = 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await this.queue(async () => undefined);
  }

  // --- the storage -------------------------------------------------------

  /** The names directly inside the folder that `parent` really is. */
  names(parent) {
    const out = [];
    for (const path of this.disk.keys()) if (parentOf(path) === parent && path !== "") out.push(path.slice(path.lastIndexOf("/") + 1));
    return out;
  }

  /** The entry a lookup of `path` finds, spelled the way the storage keeps it, or `null`. */
  real(path) {
    if (path === "") return "";
    let at = "";
    for (const segment of path.split("/")) {
      const names = this.names(at);
      const name = names.includes(segment) ? segment
        : this.folds ? names.find((candidate) => candidate.toLowerCase() === segment.toLowerCase()) : undefined;
      if (name === undefined) return null;
      at = at === "" ? name : `${at}/${name}`;
    }
    return at;
  }

  /** Where a new name lands: in the folder its parent really is, under its own last component. */
  landing(path) {
    const parent = parentOf(path);
    const at = parent === "" ? "" : this.real(parent);
    if (at === null) throw new Error(`ENOENT: ${parent}`);
    return at === "" ? path.slice(path.lastIndexOf("/") + 1) : `${at}${path.slice(parent.length)}`;
  }

  mkdirs(path, report) {
    let at = "";
    for (const segment of path.split("/")) {
      const next = at === "" ? segment : `${at}/${segment}`;
      const found = this.real(next);
      if (found !== null) { at = found; continue; }
      this.disk.set(next, null);
      if (report && !hidden(next)) {
        this.index.set(next, this.entry(next, true));
        this.emit("create", this.index.get(next));
      }
      at = next;
    }
  }

  /** A write through any spelling lands IN the entry that is there. */
  write(path, bytes, mtime, report) {
    this.mkdirs(parentOf(path), report);
    const existing = this.real(path);
    const at = existing ?? this.landing(path);
    this.disk.set(at, { bytes, mtime });
    if (!report || hidden(at)) return;
    if (existing === null) {
      this.index.set(at, this.entry(at, false));
      this.emit("create", this.index.get(at));
    } else if (this.index.has(at)) this.emit("modify", this.index.get(at));
  }

  /**
   * A removal by any spelling: the entry the storage folds it to goes, the
   * index entry of the name asked for goes with it, and the watcher reports
   * the real name.
   */
  drop(path) {
    const at = this.real(path);
    if (at === null) return;
    for (const key of [...this.disk.keys()]) if (key === at || key.startsWith(`${at}/`)) this.disk.delete(key);
    this.report(at);
    this.unindex(path);
  }

  /** Move an entry and everything under it on the storage. */
  relocate(at, to) {
    for (const [key, value] of [...this.disk]) {
      if (key !== at && !key.startsWith(`${at}/`)) continue;
      this.disk.delete(key);
      this.disk.set(to + key.slice(at.length), value);
    }
  }

  /**
   * The adapter's rename: refused for a destination the storage answers for,
   * the source's own other spelling included; the storage moves; the index
   * entry of the name given moves, with a `rename` for it and for each entry
   * under it; and the watcher reports both real names.
   */
  adapterRename(from, to) {
    if (this.fault?.(from, to, this.renames.length)) throw new Error("rename interrupted");
    const at = this.real(from);
    if (at === null) throw new Error(`ENOENT: ${from}`);
    if (this.real(to) !== null) throw new Error("Destination file already exists!");
    const landed = this.landing(to);
    this.relocate(at, landed);
    this.report(at);
    this.report(landed);
    if (!this.index.has(from)) return;
    for (const key of [from, ...[...this.index.keys()].filter((key) => key.startsWith(`${from}/`))]) {
      const entry = this.index.get(key);
      this.index.delete(key);
      entry.path = to + key.slice(from.length);
      this.index.set(entry.path, entry);
      this.emit("rename", entry, key);
    }
  }

  // --- the watcher -------------------------------------------------------

  /** The native watcher: one report per real name a change touched, reconciled a turn later, in the queue. */
  report(path) {
    if (this.paused !== null) this.paused.push(path);
    else if (this.watching) setTimeout(() => this.queue(async () => this.reconcile(path, false)), 0);
  }

  /** Hold the watcher's reports until `resume`, which makes them in the order they came. */
  pause() { this.paused = []; }

  resume() {
    const late = this.paused ?? [];
    this.paused = null;
    for (const path of late) this.report(path);
  }

  /**
   * One reported name against the storage, with the adapter's own belief
   * that it does not fold capitals: a lookup that answers is taken as that
   * very name.
   */
  reconcile(path, now) {
    const at = hidden(path) ? null : this.real(path);
    if (at === null) {
      if (!this.index.has(path)) return;
      if (now) this.unindex(path);
      else setTimeout(() => this.queue(async () => this.reconcile(path, true)), 100);
      return;
    }
    if (!this.index.has(path)) this.indexAt(path, at);
  }

  /** Index `path` -- and, for a folder, everything the storage holds under it -- as the entry at `at`. */
  indexAt(path, at) {
    const folder = this.disk.get(at) === null;
    const entry = this.entry(path, folder);
    this.index.set(path, entry);
    this.emit("create", entry);
    if (!folder) return;
    for (const name of this.names(at)) {
      const child = `${path}/${name}`;
      if (!hidden(child) && !this.index.has(child)) this.indexAt(child, `${at}/${name}`);
    }
  }

  /** Drop `path` and everything under it from the index, children first, one `delete` each. */
  unindex(path) {
    const keys = [...this.index.keys()].filter((key) => key.startsWith(`${path}/`));
    if (this.index.has(path)) keys.push(path);
    for (const key of keys) {
      const entry = this.index.get(key);
      this.index.delete(key);
      this.emit("delete", entry);
    }
  }

  // --- Obsidian's index and events ---------------------------------------

  entry(path, folder) {
    const vault = this;
    const entry = folder ? new this.obsidian.TFolder() : new this.obsidian.TFile();
    entry.path = path;
    if (folder) {
      Object.defineProperty(entry, "children", {
        get: () => [...vault.index.values()].filter((child) => child !== entry && parentOf(child.path) === entry.path),
      });
    } else {
      // A stale entry reads the one it folds to, as a ghost does.
      Object.defineProperty(entry, "stat", {
        get: () => {
          const kept = vault.cached.get(entry.path);
          if (kept !== undefined) return { ctime: kept.mtime, ...kept };
          const file = vault.disk.get(vault.real(entry.path) ?? "");
          return file ? { ctime: file.mtime, mtime: file.mtime, size: file.bytes.length } : { ctime: 0, mtime: 0, size: 0 };
        },
      });
    }
    return entry;
  }

  /** Obsidian starting over this storage: every entry indexed under its real name, no hidden name. */
  restart() {
    this.index.clear();
    this.cached.clear();
    for (const [path, value] of this.disk) if (!hidden(path)) this.index.set(path, this.entry(path, value === null));
  }

  on(name, handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
    return { name };
  }

  /**
   * `immediate` is what Obsidian does; `deferred` is a report that arrives a
   * turn later -- naming the path the entry had when it was reported, as
   * `EventVault`'s do, not wherever a later rename has taken it.
   */
  emit(name, entry, oldPath) {
    this.events.push([name, entry.path, oldPath]);
    if (this.delivery === "immediate") {
      for (const handler of this.listeners.get(name) ?? []) handler(entry, oldPath);
      return;
    }
    const reported = Object.assign(Object.create(Object.getPrototypeOf(entry)), { path: entry.path });
    setTimeout(() => { for (const handler of this.listeners.get(name) ?? []) handler(reported, oldPath); }, 0);
  }

  getAbstractFileByPath(path) { return this.index.get(path) ?? null; }
  getFileByPath(path) { const entry = this.index.get(path); return entry instanceof this.obsidian.TFile ? entry : null; }
  getFolderByPath(path) { const entry = this.index.get(path); return entry instanceof this.obsidian.TFolder ? entry : null; }
  getFiles() { return [...this.index.values()].filter((entry) => entry instanceof this.obsidian.TFile); }
  getAllFolders() { return [...this.index.values()].filter((entry) => entry instanceof this.obsidian.TFolder); }
  getConfig() { return undefined; }
  async read(file) { return new TextDecoder().decode(this.disk.get(this.real(file.path) ?? "")?.bytes ?? new Uint8Array()); }

  createBinary(path, data, options) {
    return this.queue(async () => {
      if (this.real(path) !== null) throw new Error("File already exists.");
      this.write(path, new Uint8Array(data), options?.mtime ?? this.clock, true);
      return this.index.get(this.real(path));
    });
  }

  /** `Vault.rename`: the adapter's, for the name the entry has in the index. */
  async rename(entry, to) {
    this.renames.push([entry.path, to]);
    await this.adapter.rename(entry.path, to);
  }

  // --- what the user sees ------------------------------------------------

  /** A note that was there when Obsidian started: on the storage and in the index, no event. */
  seed(path, text, mtime = this.clock) {
    this.write(path, enc(text), mtime, false);
    for (let at = this.real(path); at !== ""; at = parentOf(at)) {
      if (!this.index.has(at)) this.index.set(at, this.entry(at, this.disk.get(at) === null));
    }
  }

  text(path) {
    const file = this.disk.get(this.real(path) ?? "");
    return file ? new TextDecoder().decode(file.bytes) : null;
  }

  /** Every entry on the storage, as it spells it. */
  entries() { return [...this.disk.keys()].sort(); }

  /** Every path in Obsidian's index. */
  indexed() { return [...this.index.keys()].sort(); }
}
