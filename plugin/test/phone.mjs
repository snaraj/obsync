/**
 * Obsidian on a PHONE, in memory: its index, its adapter and the storage
 * below them, for the real `ObsidianHost` to run on (issue #219).
 *
 * `folds: true` is Android, as measured on an Android 15 emulator with
 * Obsidian 1.13.8. Its shared storage folds capitals the way a Mac does, and
 * everything above it answers for the folded name:
 *
 *  - `adapter.exists("X/probe.md", true)` is true while only `X/Probe.md`
 *    exists -- the case-sensitive flag answers nothing there;
 *  - `adapter.list` gives the real names;
 *  - the adapter's rename AND the vault's refuse a destination that exists
 *    folded, the source's own other spelling included, with "Destination
 *    file already exists!";
 *  - two vault renames through a hidden name re-case a file or a folder, the
 *    hidden name staying in the index while it exists, and report exactly two
 *    `rename` events and nothing else;
 *  - the same two steps through the ADAPTER re-case the disk and leave the
 *    old spelling in the index beside the new one: a rename into a hidden
 *    name keeps its source indexed, and one out of a hidden name the index
 *    never held indexes its destination.
 *
 * `folds: false` is an iPhone or an iPad, whose "On My iPhone" storage keeps
 * `Probe` and `probe` as two entries. Obsidian indexes no hidden name when it
 * starts (`restart`).
 *
 * Hand-written, stdlib only, and in memory: the same answers on every CI host,
 * whatever its own filesystem folds.
 */

const enc = (text) => new TextEncoder().encode(text);
const parentOf = (path) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const hidden = (path) => path.split("/").some((part) => part.startsWith("."));

export class PhoneVault {
  constructor(obsidian, { folds = true, delivery = "immediate" } = {}) {
    this.obsidian = obsidian;
    this.folds = folds;
    this.delivery = delivery;
    /** The storage: every entry under the name it keeps, `{ bytes, mtime }` for a file and `null` for a folder. */
    this.disk = new Map();
    /** Obsidian's index, by exact path. */
    this.index = new Map();
    this.listeners = new Map();
    /** Every event the vault raised, as `[name, path, oldPath]`. */
    this.events = [];
    /** Every `vault.rename` asked for, as `[from, to]`, refused ones included. */
    this.renames = [];
    /** `(from, to, n) => boolean`: refuse the n-th `vault.rename` (1-based) with an error, before it changes anything. */
    this.fault = null;
    /** Whether the adapter's own rename updates the index at all (`false`: an adapter that leaves it to a restart). */
    this.adapterIndexes = true;
    this.clock = 1757200000000;
    const vault = this;
    this.adapter = {
      // The flag is not an answer on Android (fact 2); a phone that keeps the
      // spellings apart answers for the exact name whatever it is passed.
      exists: async (path) => vault.real(path) !== null,
      stat: async (path) => {
        const at = vault.real(path);
        if (at === null) return null;
        const file = vault.disk.get(at);
        return file === null ? { type: "folder", ctime: 0, mtime: 0, size: 0 }
          : { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.bytes.length };
      },
      list: async (path) => {
        const at = vault.real(path === "/" ? "" : path);
        if (at === null || vault.disk.get(at) !== null && at !== "") throw new Error(`ENOENT: ${path}`);
        const out = { files: [], folders: [] };
        for (const name of vault.names(at)) {
          const child = at === "" ? name : `${at}/${name}`;
          (vault.disk.get(child) === null ? out.folders : out.files).push(child);
        }
        return out;
      },
      rename: async (from, to) => vault.adapterRename(from, to),
      mkdir: async (path) => vault.mkdirs(path, true),
      readBinary: async (path) => {
        const file = vault.disk.get(vault.real(path) ?? "");
        if (!file) throw new Error(`ENOENT: ${path}`);
        return file.bytes.slice().buffer;
      },
      writeBinary: async (path, data, options) => vault.write(path, new Uint8Array(data), options?.mtime ?? vault.clock, true),
      remove: async (path) => vault.drop(path),
      trashLocal: async (path) => vault.drop(path),
      trashSystem: async (path) => { vault.drop(path); return true; },
      rmdir: async (path) => vault.drop(path),
    };
    this.fileManager = { trashFile: async (file) => vault.drop(file.path) };
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

  drop(path) {
    const at = this.real(path);
    if (at === null) return;
    for (const key of [...this.disk.keys()]) if (key === at || key.startsWith(`${at}/`)) this.disk.delete(key);
    const entry = this.index.get(at);
    for (const key of [...this.index.keys()]) if (key === at || key.startsWith(`${at}/`)) this.index.delete(key);
    if (entry) this.emit("delete", entry);
  }

  /** Move an entry and everything under it; the index is the caller's. */
  relocate(at, to) {
    for (const [key, value] of [...this.disk]) {
      if (key !== at && !key.startsWith(`${at}/`)) continue;
      this.disk.delete(key);
      this.disk.set(to + key.slice(at.length), value);
    }
  }

  /** Re-path an index entry and everything under it. */
  reindex(from, to) {
    for (const [key, entry] of [...this.index]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      this.index.delete(key);
      entry.path = to + key.slice(from.length);
      this.index.set(entry.path, entry);
    }
  }

  adapterRename(from, to) {
    const at = this.real(from);
    if (at === null) throw new Error(`ENOENT: ${from}`);
    if (this.real(to) !== null) throw new Error("Destination file already exists!");
    const landed = this.landing(to);
    const folder = this.disk.get(at) === null;
    this.relocate(at, landed);
    if (!this.adapterIndexes) return;
    const entry = this.index.get(at);
    if (entry !== undefined && !hidden(landed)) {
      this.reindex(at, landed);
      this.emit("rename", entry, at);
    } else if (entry === undefined && !hidden(landed)) {
      for (const key of this.disk.keys()) {
        if (key === landed || key.startsWith(`${landed}/`)) this.index.set(key, this.entry(key, this.disk.get(key) === null));
      }
      this.emit("create", this.index.get(landed));
    }
    // An indexed source renamed INTO a hidden name stays indexed: the ghost.
    return folder;
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
          const file = vault.disk.get(vault.real(entry.path) ?? "");
          return file ? { ctime: file.mtime, mtime: file.mtime, size: file.bytes.length } : { ctime: 0, mtime: 0, size: 0 };
        },
      });
    }
    return entry;
  }

  /** Obsidian starting over this storage: every entry indexed, no hidden name. */
  restart() {
    this.index.clear();
    for (const [path, value] of this.disk) if (!hidden(path)) this.index.set(path, this.entry(path, value === null));
  }

  on(name, handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]);
    return { name };
  }

  /**
   * `immediate` is what the vault's own rename does; `deferred` is a report
   * that arrives a turn later -- naming the path the entry had when it was
   * reported, as `EventVault`'s do, not wherever a later rename has taken it.
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

  async createBinary(path, data, options) {
    if (this.real(path) !== null) throw new Error("File already exists.");
    this.write(path, new Uint8Array(data), options?.mtime ?? this.clock, true);
    return this.index.get(this.real(path));
  }

  /**
   * `Vault.rename`: refused when the destination exists in the index or on
   * the storage -- folded, on Android -- and otherwise the entry, its
   * children and its index entries move, and ONE event says so.
   */
  async rename(entry, to) {
    this.renames.push([entry.path, to]);
    if (this.fault?.(entry.path, to, this.renames.length)) throw new Error("vault rename interrupted");
    const at = this.real(entry.path);
    if (at === null) throw new Error(`ENOENT: ${entry.path}`);
    if (this.index.has(to) || this.real(to) !== null) throw new Error("Destination file already exists!");
    const landed = this.landing(to);
    const from = entry.path;
    this.relocate(at, landed);
    this.reindex(from, landed);
    this.emit("rename", entry, from);
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
