// observer -- what a network operator in front of obsyncd sees of a real
// session, and a bounded scan for seeded content and content keys.
//
// WHY. obsync's promise (docs/threat-model.md) is that content and names are
// encrypted on the device and the server -- and so anyone in front of it,
// including an employer's TLS-inspecting proxy or a VPN that terminates TLS --
// sees ciphertext, not notes. That promise is only as good as its proof. This
// records the exact application bytes that cross the hop and searches them for
// anything that should never be there.
//
// THE RECORDER is a byte relay for the terminator->server hop, which obsync
// deploys as plain HTTP (docs/threat-model.md residual risk 4): the client
// connects here, every byte in each direction is written to a capture file
// unchanged, and forwarded to obsyncd. The bytes here are the same
// application-layer bytes a TLS-inspecting proxy holds AFTER it decrypts --
// TLS is only the envelope around them -- so a capture that leaks nothing here
// leaks nothing to such a proxy either. The relay decrypts nothing and edits
// nothing; it is a tap, not a man in the middle.
//
// THE SCANNER reassembles the captured streams into HTTP exchanges (bodies
// de-chunked and decompressed, targets percent-decoded, JSON walked and every
// JSON string that itself decodes as base64/base64url/hex decoded again), then
// searches those views for each NEEDLE in the supported encodings. A needle is a sentinel the session wrote or key material read
// off disposable test devices; PASS requires complete evidence and zero unexpected hits. It also lists what IS visible, so the
// threat model can be held to exactly that. Needle values are never printed.
// Individual recovery words of at least seven letters are searched in values,
// including a value that repeats a protocol field name. Structural names are
// excluded only from that per-word scan; the full phrase is searched everywhere.
//
// usage:
//   node observer.mjs record --listen 127.0.0.1:18802 --upstream 127.0.0.1:18801 --out <dir>
//   node observer.mjs scan   --capture <dir> --needles <0600 json> [--json]
// Needles file: {"text":{label:value,...}, "hex":{label:hex,...},
//                "phrase":"24 words", "codes":[code,...]}
import { hkdfSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";

function splitHostPort(value) {
  const at = value.lastIndexOf(":");
  return [value.slice(0, at) || "127.0.0.1", Number(value.slice(at + 1))];
}

// ---- The recorder: a plain-HTTP byte relay that writes both directions.

/**
 * Start the relay. Resolves to `{ port, connections(), close(), pause(),
 * resume() }`. `pause` stops accepting and cuts live connections (a network
 * gone, for a Leave-and-pair-again leg); `resume` listens again on the port.
 */
function writeFully(fd, bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (let at = 0; at < data.length;) {
    const written = fs.writeSync(fd, data, at, data.length - at);
    if (written <= 0) throw new Error("recorder_write");
    at += written;
  }
}

export async function startRecorder({ listen, upstream, out }) {
  const [host, wantPort] = splitHostPort(listen);
  const [upHost, upPort] = splitHostPort(upstream);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(out).isDirectory() || fs.readdirSync(out).length) throw new Error("capture_not_empty");
  const index = fs.openSync(path.join(out, "index.jsonl"), "wx", 0o600);
  const sockets = new Set(), closing = new Set(), errors = new Set();
  let count = 0, listener = null, stopped = false, port = wantPort;
  const onClient = (client) => {
    const n = ++count, sizes = { up: 0, down: 0 }, fds = [];
    let server;
    try {
      fds.push(fs.openSync(path.join(out, `c${n}.up`), "wx", 0o600));
      fds.push(fs.openSync(path.join(out, `c${n}.down`), "wx", 0o600));
      server = net.connect({ host: upHost, port: upPort });
    } catch {
      errors.add("recorder_open");
      for (const fd of fds) fs.closeSync(fd);
      client.destroy();
      return;
    }
    let finished = 0, resolve;
    const done = new Promise((r) => { resolve = r; });
    closing.add(done);
    const finish = () => {
      if (++finished !== 2) return;
      for (const socket of [client, server]) sockets.delete(socket);
      for (const fd of fds) {
        try { fs.fsyncSync(fd); } catch { errors.add("recorder_flush"); }
        try { fs.closeSync(fd); } catch { errors.add("recorder_close"); }
      }
      try { writeFully(index, `${JSON.stringify({ n, ...sizes })}\n`); }
      catch { errors.add("recorder_index"); }
      closing.delete(done);
      resolve();
    };
    const pump = (from, to, fd, dir) => {
      from.on("data", (bytes) => {
        try { writeFully(fd, bytes); sizes[dir] += bytes.length; }
        catch { errors.add("recorder_write"); client.destroy(); server.destroy(); return; }
        if (!to.write(bytes)) from.pause();
      });
      to.on("drain", () => from.resume());
      from.on("end", () => to.end());
    };
    pump(client, server, fds[0], "up");
    pump(server, client, fds[1], "down");
    for (const socket of [client, server]) {
      sockets.add(socket);
      socket.on("close", finish);
      socket.on("error", () => { errors.add("recorder_socket"); client.destroy(); server.destroy(); });
    }
  };
  const listenOn = () => new Promise((resolve, reject) => {
    listener = net.createServer(onClient);
    listener.on("error", reject);
    listener.listen(port, host, () => { port = listener.address().port; resolve(port); });
  });
  const pause = async () => {
    const pending = [...closing];
    for (const socket of sockets) socket.destroy();
    if (listener) {
      const current = listener;
      listener = null;
      await new Promise((resolve) => current.close(resolve));
    }
    await Promise.all(pending);
  };
  try { await listenOn(); } catch (error) { fs.closeSync(index); throw error; }
  return {
    port, connections: () => count, pause,
    resume: () => {
      if (stopped) throw new Error("recorder_stopped");
      return listener ? Promise.resolve(port) : listenOn();
    },
    close: async () => {
      if (stopped) throw new Error("recorder_stopped");
      stopped = true;
      await pause();
      try { fs.fsyncSync(index); } catch { errors.add("recorder_flush"); }
      try { fs.closeSync(index); } catch { errors.add("recorder_close"); }
      fs.writeFileSync(path.join(out, "complete.json"), JSON.stringify({ version: 1, connections: count, errors: [...errors] }), { flag: "wx", mode: 0o600 });
      if (errors.size) throw new Error("recorder_failed");
    },
  };
}

// ---- Reassembly. Every byte is scanned; incomplete or ambiguous evidence refuses PASS.
const CRLF2 = Buffer.from("\r\n\r\n");
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 12;
const refuse = (reason) => { throw new Error(reason); };

function parseHead(text, kind) {
  const lines = text.split("\r\n");
  const line = lines.shift();
  if (!(kind === "request" ? /^[A-Z]+ [^ \r\n]+ HTTP\/1\.[01]$/ : /^HTTP\/1\.[01] [1-5][0-9]{2}(?: [^\r\n]*)?$/).test(line)) refuse("http_start_line");
  const headers = { line, raw: text };
  for (const row of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(row);
    if (!match) refuse("http_header");
    const key = match[1].toLowerCase();
    if (key === "line" || key === "raw" || key === "__proto__") refuse("http_header_reserved");
    if (headers[key] !== undefined && ["content-length", "transfer-encoding", "content-encoding"].includes(key)) refuse("http_duplicate_framing");
    headers[key] = headers[key] === undefined ? match[2].trim() : `${headers[key]}, ${match[2].trim()}`;
  }
  return headers;
}

function dechunk(buf, start) {
  const chunks = [];
  let at = start, total = 0;
  for (;;) {
    const end = buf.indexOf("\r\n", at);
    if (end < 0) refuse("http_chunk_header");
    const line = buf.toString("latin1", at, end);
    if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(line)) refuse("http_chunk_size");
    const size = Number.parseInt(line.split(";")[0], 16);
    if (!Number.isSafeInteger(size) || size > MAX_BYTES - total) refuse("scan_budget");
    at = end + 2;
    if (size === 0) {
      // Trailers are still scanned in the original bytes; require complete framing.
      for (;;) {
        const tail = buf.indexOf("\r\n", at);
        if (tail < 0) refuse("http_chunk_trailer");
        const row = buf.toString("latin1", at, tail);
        at = tail + 2;
        if (!row) return { body: Buffer.concat(chunks), next: at };
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\r\n]*$/.test(row) || /^(content-length|transfer-encoding):/i.test(row)) refuse("http_chunk_trailer");
      }
    }
    if (at + size + 2 > buf.length || buf.toString("latin1", at + size, at + size + 2) !== "\r\n") refuse("http_chunk_truncated");
    chunks.push(buf.subarray(at, at + size));
    total += size;
    at += size + 2;
  }
}

function decompress(bytes, encoding) {
  for (const part of encoding.split(",").map((s) => s.trim().toLowerCase()).reverse()) {
    if (!part || part === "identity") continue;
    const decode = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync }[part];
    if (!decode) refuse("http_content_encoding");
    try { bytes = decode(bytes, { maxOutputLength: MAX_BYTES }); }
    catch { refuse("http_decompression"); }
  }
  return bytes;
}

function splitMessages(buf, kind, requests = []) {
  const messages = [];
  let at = 0, responseIndex = 0;
  while (at < buf.length) {
    const headEnd = buf.indexOf(CRLF2, at);
    if (headEnd < 0) refuse("http_header_truncated");
    const head = parseHead(buf.toString("latin1", at, headEnd), kind);
    const start = headEnd + 4, cl = head["content-length"], te = head["transfer-encoding"];
    if (cl !== undefined && te !== undefined) refuse("http_ambiguous_length");
    const status = kind === "response" ? Number(head.line.split(" ")[1]) : 0;
    const noBody = status && (status < 200 || status === 204 || status === 304 || requests[responseIndex]?.head.line.startsWith("HEAD "));
    let body, next;
    if (noBody) { body = Buffer.alloc(0); next = start; }
    else if (te !== undefined) {
      if (te.toLowerCase() !== "chunked") refuse("http_transfer_encoding");
      ({ body, next } = dechunk(buf, start));
    } else if (cl !== undefined) {
      if (!/^[0-9]+$/.test(cl)) refuse("http_content_length");
      const size = Number(cl);
      if (!Number.isSafeInteger(size) || size > MAX_BYTES || start + size > buf.length) refuse("http_body_truncated");
      body = buf.subarray(start, start + size); next = start + size;
    } else if (kind === "response") {
      body = buf.subarray(start); next = buf.length;
    } else { body = Buffer.alloc(0); next = start; }
    body = decompress(body, head["content-encoding"] || "");
    messages.push({ head, body, informational: status > 0 && status < 200 });
    if (status >= 200) responseIndex++;
    at = next;
  }
  return messages;
}

export function readCapture(dir) {
  const conns = [];
  conns.errors = [];
  const bad = (reason) => conns.errors.push(reason);
  let ns, receipt, rows;
  try {
    const names = fs.readdirSync(dir);
    if (names.some((name) => !/^(c[1-9][0-9]*\.(up|down)|index\.jsonl|complete\.json)$/.test(name))) bad("capture_inventory");
    if (names.some((name) => !fs.lstatSync(path.join(dir, name)).isFile())) refuse("capture_inventory");
    ns = [...new Set(names.filter((f) => /^c[1-9][0-9]*\.(up|down)$/.test(f)).map((f) => Number(f.slice(1, f.indexOf(".")))))].sort((a, b) => a - b);
    receipt = JSON.parse(fs.readFileSync(path.join(dir, "complete.json"), "utf8"));
    rows = fs.readFileSync(path.join(dir, "index.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (receipt.version !== 1 || receipt.connections !== ns.length || !Array.isArray(receipt.errors) || receipt.errors.length || rows.length !== ns.length || new Set(rows.map((row) => row.n)).size !== ns.length) bad("capture_receipt");
  } catch { bad("capture_incomplete"); }
  if (!ns?.length) bad("capture_empty");
  for (const n of ns || []) {
    const conn = { n, requests: [], responses: [], raw: {} };
    conns.push(conn);
    for (const [suffix, kind] of [["up", "request"], ["down", "response"]]) {
      try {
        const file = path.join(dir, `c${n}.${suffix}`);
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) refuse("capture_inventory");
        if (stat.size > MAX_BYTES) refuse("scan_budget");
        const bytes = fs.readFileSync(file);
        conn.raw[kind] = bytes;
        if (rows?.find((row) => row.n === n)?.[suffix] !== bytes.length) bad("capture_byte_count");
        conn[kind === "request" ? "requests" : "responses"] = splitMessages(bytes, kind, conn.requests);
      } catch (error) {
        bad(["scan_budget", "http_"].some((r) => error.message.startsWith(r)) ? error.message : "capture_read");
      }
    }
    if (!conn.requests.length || conn.responses.filter((r) => !r.informational).length !== conn.requests.length) bad("capture_exchange_count");
  }
  return conns;
}

// ---- Needles: the exact bytes that must never appear, in every encoding.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Every encoding a value could leak in, as lowercase-comparable strings and
 * as byte buffers. A hit in any is a leak.
 *
 * For a text value: its UTF-8 (NFC and NFD), UTF-16LE and BE, the JSON \u
 * escaping of it, its bytes as hex (both cases) and percent-encoding, and its
 * UTF-8 bytes as base64/base64url/base32. For raw key bytes (hex in): the
 * bytes themselves and those same base encodings, plus the hex text in both
 * cases. Short values (< 4 bytes) are skipped: they match noise, not a leak.
 */
function encodingsOf(value, kind) {
  const forms = new Set();
  const raws = [];
  // Case-sensitive: lowercasing binary would fold distinct bytes together and
  // manufacture a false hit that fails the gate. Both hex cases are added
  // explicitly where a value can appear in either.
  const add = (s) => { if (s && s.length >= 5) forms.add(s); };
  const addRaw = (b) => { if (b.length >= 4) raws.push(b); };
  const baseForms = (b) => {
    add(b.toString("base64"));
    add(b.toString("base64url"));
    // Only characters entirely inside the needle: arbitrary prefix bytes
    // change the boundary sextets when the needle is encoded at offsets 1/2.
    for (let offset = 0; offset < 3; offset++) {
      const encoded = Buffer.concat([Buffer.alloc(offset), b]).toString("base64");
      const inside = encoded.slice(Math.ceil(offset * 8 / 6), Math.floor((offset + b.length) * 8 / 6));
      add(inside); add(inside.replaceAll("+", "-").replaceAll("/", "_"));
    }
    add(base32(b));
    add(b.toString("hex"));
    add(b.toString("hex").toUpperCase());
  };
  if (kind === "hex") {
    const raw = Buffer.from(value, "hex");
    addRaw(raw);              // the key bytes as they sit in a body
    add(value);              // the hex text, lower
    add(value.toUpperCase()); // and upper
    baseForms(raw);
  } else {
    const nfc = value.normalize("NFC");
    const nfd = value.normalize("NFD");
    for (const s of new Set([nfc, nfd])) {
      const u8 = Buffer.from(s, "utf8");
      const le = Buffer.from(s, "utf16le");
      const be = Buffer.from(le);
      for (let i = 0; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
      addRaw(u8);   // the text as UTF-8 bytes on the wire
      addRaw(le);   // as UTF-16LE bytes
      addRaw(be);   // as UTF-16BE bytes
      add(s);       // the text verbatim
      add(encodeURIComponent(s));
      add(s.split("").map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
      baseForms(u8);
      add(le.toString("hex"));
      add(be.toString("hex"));
    }
  }
  return { forms: [...forms], raws };
}

/**
 * Build the needle set: the sentinels and key material given, plus keys
 * obsync derives from the vault key that must equally never cross. A label is
 * kept for the report; the value never is.
 */
export function buildNeedles(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || Object.keys(spec).some((key) => !["text", "hex", "phrase", "codes", "domainId"].includes(key))) refuse("needles_invalid");
  for (const kind of ["text", "hex"]) {
    if (spec[kind] !== undefined && (!spec[kind] || typeof spec[kind] !== "object" || Array.isArray(spec[kind]))) refuse("needles_invalid");
    for (const [label, value] of Object.entries(spec[kind] || {})) {
      if (!label || typeof value !== "string" || value.length < 4 || value.length > MAX_BYTES || (kind === "hex" && !/^(?:[0-9a-fA-F]{2}){4,}$/.test(value))) refuse("needles_invalid");
    }
  }
  if (spec.phrase !== undefined && (typeof spec.phrase !== "string" || spec.phrase.trim().length < 4)) refuse("needles_invalid");
  if (spec.codes !== undefined && (!Array.isArray(spec.codes) || spec.codes.some((v) => typeof v !== "string" || v.length < 4))) refuse("needles_invalid");
  if (spec.domainId !== undefined && !/^[0-9a-f]{32}$/.test(spec.domainId)) refuse("needles_invalid");
  const needles = [];
  const push = (label, value, kind, extra = {}) => {
    if (!value) return;
    const { forms, raws } = encodingsOf(value, kind);
    if (forms.length || raws.length) {
      needles.push({ label, kind, forms, raws: raws.map((b) => b.toString("latin1")), ...extra });
    }
  };
  for (const [label, value] of Object.entries(spec.text || {})) push(`text:${label}`, value, "text");
  for (const [label, value] of Object.entries(spec.hex || {})) if (label !== "domain_id") push(`key:${label}`, value, "hex");
  if (spec.phrase) {
    push("recovery:phrase", spec.phrase.trim(), "text");
    for (const [index, word] of spec.phrase.trim().split(/\s+/).entries()) {
      // A single common word is not a needle, but a run of them is the phrase,
      // covered above; individual rare words are still worth flagging.
      if (word.length >= 7) push(`recovery:word:${index}`, word, "text", { word: word.toLowerCase() });
    }
  }
  for (const [i, code] of (spec.codes || []).entries()) push(`pairing:code:${i}`, code, "text");
  // Derived from the vault key with no other input: the domain-map key. Chunk
  // and manifest keys need the (server-visible) domain id; pass it as
  // spec.domainId to add them. None may ever appear in a capture.
  const vrk = spec.hex && spec.hex.vrk;
  if (vrk && /^[0-9a-f]{64}$/.test(vrk)) {
    const key = Buffer.from(vrk, "hex");
    const mapKey = Buffer.from(hkdfSync("sha256", key, Buffer.from("obsync/v1/domainmap"), Buffer.alloc(0), 32));
    push("key:derived:domain-map", mapKey.toString("hex"), "hex");
    const domainId = spec.domainId ?? spec.hex.domain_id;
    if (domainId && /^[0-9a-f]{32}$/.test(domainId)) {
      const domainKey = Buffer.from(hkdfSync("sha256", key, Buffer.from("obsync/v1/domain"), Buffer.from(domainId), 32));
      push("key:derived:domain", domainKey.toString("hex"), "hex");
      const manifestKey = Buffer.from(hkdfSync("sha256", domainKey, Buffer.from("obsync/v1/manifest"), Buffer.from(domainId), 32));
      push("key:derived:manifest", manifestKey.toString("hex"), "hex");
    }
  }
  if (!needles.length) refuse("needles_empty");
  return needles;
}

// ---- Views: every readable form of one message.

const LOOKS_B64 = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
const LOOKS_HEX = /^(?:[0-9a-f]{2}){8,}$/i;

/** Decode a JSON string one more level if it is base64/base64url or hex. */
function decodeDeeper(s) {
  const bufs = [];
  if (LOOKS_HEX.test(s)) { try { bufs.push(Buffer.from(s, "hex")); } catch { /* */ } }
  if (LOOKS_B64.test(s)) {
    for (const enc of ["base64", "base64url"]) { try { const b = Buffer.from(s, enc); if (b.length) bufs.push(b); } catch { /* */ } }
  }
  return bufs;
}

/** Walk parsed JSON, collecting every string, recursing into decodable ones. */
function walkJson(value, out, depth, valuesOnly = false, budget = { nodes: 0 }) {
  if (depth > MAX_DEPTH || ++budget.nodes > 50000) refuse("scan_decode_budget");
  if (typeof value === "string") {
    out.push(value);
    for (const b of decodeDeeper(value)) {
      out.push(b.toString("latin1"));
      let inner;
      try { inner = JSON.parse(b.toString("utf8")); } catch { continue; }
      walkJson(inner, out, depth + 1, valuesOnly, budget);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) walkJson(v, out, depth + 1, valuesOnly, budget);
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) { if (!valuesOnly) out.push(k); walkJson(value[k], out, depth + 1, valuesOnly, budget); }
  }
}

/**
 * Every searchable string of one message: the wire bytes verbatim (as
 * latin1, so any byte sequence -- UTF-8, UTF-16, raw key bytes -- is found by
 * substring), the percent-decoded request target, and every JSON string in
 * the body with each decodable one taken a level deeper.
 */
function viewsOf(message, isRequest, valuesOnly = false) {
  const views = [];
  // The whole header block (every name AND value) plus the body, as latin1 so
  // any byte sequence in transit is found by substring.
  const wire = Buffer.concat([Buffer.from(message.head.raw + "\r\n\r\n", "latin1"), message.body]);
  if (!valuesOnly) views.push(wire.toString("latin1"));
  else for (const [name, value] of Object.entries(message.head)) if (!["line", "raw"].includes(name)) views.push(value);
  if (isRequest) {
    const target = message.head.line.split(" ")[1] || "";
    try {
      if (valuesOnly) {
        const parsed = new URL(target, "http://obsync.invalid");
        views.push(decodeURIComponent(parsed.pathname), ...parsed.searchParams.values());
      } else views.push(decodeURIComponent(target));
    } catch { refuse("http_target_encoding"); }
  }
  const text = message.body.toString("utf8");
  let value;
  try { value = JSON.parse(text); }
  catch {
    if (/(?:application\/json|\+json)(?:;|$)/i.test(message.head["content-type"] || "")) refuse("http_json");
    if (valuesOnly) views.push(text);
    return views;
  }
  const collected = [];
  walkJson(value, collected, 0, valuesOnly);
  views.push(...collected);
  return views;
}

// ---- The scan.

/** Every JSON object key in a parsed body, at any depth. */
function keysOf(value, out, depth) {
  if (depth > 6) return;
  if (Array.isArray(value)) for (const v of value) keysOf(v, out, depth + 1);
  else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) { out.add(k.toLowerCase()); keysOf(value[k], out, depth + 1); }
  }
}

/**
 * The protocol's own words in this capture: header names, JSON keys at any
 * depth, and the literal words of every request target (path segments and
 * query names). A single recovery word inside one of these is protocol, not
 * a leak.
 */
function vocabularyOf(conns) {
  const words = new Set();
  const body = (m) => { try { keysOf(JSON.parse(m.body.toString("utf8")), words, 0); } catch { /* not json */ } };
  for (const conn of conns) {
    for (const req of conn.requests) {
      for (const k of Object.keys(req.head)) if (k !== "line" && k !== "raw") words.add(k.toLowerCase());
      for (const w of (req.head.line.split(" ")[1] || "").split(/[/?&=]/)) if (/^[a-z_-]+$/i.test(w)) words.add(w.toLowerCase());
      body(req);
    }
    for (const res of conn.responses) {
      for (const k of Object.keys(res.head)) if (k !== "line" && k !== "raw") words.add(k.toLowerCase());
      body(res);
    }
  }
  return [...words];
}

/** Route class for one request line, so the report says WHAT crossed. */
function routeClass(line) {
  const target = (line.split(" ")[1] || "").split("?")[0];
  return target
    .replace(/\/[0-9a-f]{24,64}(?=\/|$)/g, "/{id}")
    .replace(/\/[0-9a-f]{16}(?=\/|$)/g, "/{id}");
}

/**
 * Search one capture for every needle. Returns `{ hits, visible }`: `hits` is
 * empty on PASS; `visible` is the metadata inventory (routes, header names,
 * field names, device names, platforms, versions, agent, credential legs).
 */
export function scan(conns, allNeedles) {
  const hits = [];
  const vocabulary = vocabularyOf(conns);
  const isProtocol = (n) => n.word !== undefined && vocabulary.some((w) => w.includes(n.word));
  const skipped = allNeedles.filter(isProtocol).map((n) => n.label);
  const needles = allNeedles.filter((n) => n.word === undefined);
  const words = allNeedles.filter((n) => n.word !== undefined);
  const errors = Array.isArray(conns.errors) ? [...conns.errors] : ["capture_unverified"];
  if (!allNeedles.length) errors.push("needles_empty");
  if (!conns.length) errors.push("capture_empty");
  const routes = new Map();
  const requestHeaders = new Set();
  const responseHeaders = new Set();
  const jsonFields = new Set();
  const credentialLegs = new Set();
  let agent = null;

  const check = (views, where, selected = needles) => {
    for (const view of views) {
      for (const needle of selected) {
        if (hits.some((h) => h.label === needle.label && h.where === where)) continue;
        const hit = needle.raws.some((r) => view.includes(r)) || needle.forms.some((f) => view.includes(f));
        if (hit) hits.push({ label: needle.label, where });
      }
    }
  };

  const message = (m, request) => {
    try {
      check(viewsOf(m, request), request ? "request" : "response");
      check(viewsOf(m, request, true), request ? "request" : "response", words);
    } catch (error) { errors.push(error.message); }
  };
  for (const conn of conns) {
    for (const [kind, bytes] of Object.entries(conn.raw || {})) check([bytes.toString("latin1")], kind);
    for (const req of conn.requests) {
      const cls = routeClass(req.head.line);
      const method = req.head.line.split(" ")[0];
      routes.set(`${method} ${cls}`, (routes.get(`${method} ${cls}`) || 0) + 1);
      for (const k of Object.keys(req.head)) if (k !== "line" && k !== "raw") requestHeaders.add(k);
      if (req.head["user-agent"]) agent = req.head["user-agent"];
      if (req.head["x-obsync-sig"]) credentialLegs.add("device HMAC signature (X-Obsync-Sig)");
      if (req.head.cookie) credentialLegs.add("dashboard session cookie");
      // Token-bearing bodies: setup and pairing claim carry their credential.
      if (/\/v1\/setup|\/v1\/pairing\/[0-9a-f]+\/claim/.test(req.head.line)) {
        credentialLegs.add("setup/enroll token in a request body");
      }
      try {
        const body = JSON.parse(req.body.toString("utf8"));
        for (const k of Object.keys(body)) jsonFields.add(`req:${k}`);
      } catch { /* */ }
      message(req, true);
    }
    for (const res of conn.responses) {
      for (const k of Object.keys(res.head)) if (k !== "line" && k !== "raw") responseHeaders.add(k);
      try {
        const body = JSON.parse(res.body.toString("utf8"));
        for (const k of Object.keys(body)) jsonFields.add(`res:${k}`);
        if (typeof body.device_secret === "string") credentialLegs.add("device_secret in a response body (setup/claim)");
        if (Array.isArray(body.devices)) {
          for (const d of body.devices) {
            if (d && typeof d === "object") jsonFields.add("res:devices[].{name,platform,app_version,address,country,last_seen}");
          }
        }
      } catch { /* */ }
      message(res, false);
    }
  }
  return {
    decision: hits.length || errors.length ? "fail" : "pass",
    errors: [...new Set(errors)],
    hits,
    skipped,
    // Failed captures may contain a needle in a route, header or field NAME.
    // Never echo those values into a report or CI log on a refused capture.
    visible: hits.length || errors.length ? {} : {
      routes: [...routes.entries()].map(([r, n]) => `${r} ×${n}`).sort(),
      requestHeaders: [...requestHeaders].sort(),
      responseHeaders: [...responseHeaders].sort(),
      jsonFields: [...jsonFields].sort(),
      credentialLegs: [...credentialLegs].sort(),
      agent,
    },
  };
}

// ---- CLI.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { out[key] = argv[++i]; } else out[key] = true;
    }
  }
  return out;
}

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === "record") {
    const recorder = await startRecorder({ listen: args.listen, upstream: args.upstream, out: args.out });
    process.stdout.write(`observer: recording ${args.listen} -> ${args.upstream} into ${args.out} (port ${recorder.port})\n`);
    const stop = async () => { await recorder.close(); process.exit(0); };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    // Hold the process open.
    await new Promise(() => {});
  } else if (cmd === "scan") {
    let needles = [], conns = [], result;
    try {
      needles = buildNeedles(JSON.parse(fs.readFileSync(args.needles, "utf8")));
      conns = readCapture(args.capture);
      result = scan(conns, needles);
    } catch { result = { decision: "fail", errors: ["needles_invalid"], hits: [], skipped: [], visible: {} }; }
    const { hits, skipped, visible, errors, decision } = result;
    const requests = conns.reduce((n, c) => n + c.requests.length, 0);
    const responses = conns.reduce((n, c) => n + c.responses.length, 0);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ decision, errors, needles: needles.length, connections: conns.length, requests, responses, hits, skipped, visible }, null, 2)}\n`);
    } else {
      process.stdout.write(`observer scan: ${conns.length} connections, ${requests} requests, ${responses} responses, ${needles.length} needles in ${needles.reduce((n, x) => n + x.forms.length + x.raws.length, 0)} encodings\n`);
      process.stdout.write(`observer scan: DECISION ${decision === "pass" ? "PASS (complete capture; zero unexpected hits)" : `FAIL (${hits.length} hit(s); ${errors.join(",")})`}\n`);
      for (const h of hits) process.stdout.write(`observer scan:   HIT ${h.label} in a ${h.where}\n`);
      if (skipped.length) process.stdout.write(`observer scan: ${skipped.length} structural recovery-word exception(s), with all values still searched: ${skipped.join(", ")}\n`);
      process.stdout.write("observer scan: VISIBLE to the hop:\n");
      process.stdout.write(`  routes: ${(visible.routes || []).join(", ")}\n`);
      process.stdout.write(`  request headers: ${(visible.requestHeaders || []).join(", ")}\n`);
      process.stdout.write(`  response headers: ${(visible.responseHeaders || []).join(", ")}\n`);
      process.stdout.write(`  json fields: ${(visible.jsonFields || []).join(", ")}\n`);
      process.stdout.write(`  credentials in clear on this hop: ${(visible.credentialLegs || []).join("; ") || "none observed"}\n`);
      process.stdout.write(`  user agent: ${visible.agent || "none"}\n`);
    }
    process.exit(decision === "pass" ? 0 : 1);
  } else {
    process.stderr.write("usage: observer.mjs record --listen H:P --upstream H:P --out DIR | scan --capture DIR --needles FILE [--json]\n");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
