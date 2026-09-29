// observer -- what a network operator in front of obsyncd sees of a real
// session, and a scan that proves it is metadata and ciphertext only.
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
// searches every one of those views for every NEEDLE in every encoding a leak
// could take. A needle is a sentinel the session wrote or key material read
// off the devices; PASS is zero hits. It also lists what IS visible, so the
// threat model can be held to exactly that. Needle values are never printed.
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
export async function startRecorder({ listen, upstream, out }) {
  const [host, wantPort] = splitHostPort(listen);
  const [upHost, upPort] = splitHostPort(upstream);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const index = fs.openSync(path.join(out, "index.jsonl"), "a");
  const liveSockets = new Set();
  // Continue numbering past whatever the directory already holds, so a
  // restart into the same capture appends rather than clobbering c1, c2, ….
  let count = fs.readdirSync(out)
    .filter((f) => /^c\d+\.(up|down)$/.test(f))
    .reduce((max, f) => Math.max(max, Number(f.slice(1, f.indexOf(".")))), 0);

  const onClient = (client) => {
    const n = ++count;
    const opened = Date.now();
    const up = fs.openSync(path.join(out, `c${n}.up`), "w", 0o600);
    const down = fs.openSync(path.join(out, `c${n}.down`), "w", 0o600);
    const sizes = { up: 0, down: 0 };
    const server = net.connect({ host: upHost, port: upPort });
    liveSockets.add(client);
    liveSockets.add(server);

    const pump = (from, to, fd, dir) => {
      from.on("data", (bytes) => {
        try { fs.writeSync(fd, bytes); } catch { /* closed */ }
        sizes[dir] += bytes.length;
        if (!to.write(bytes)) from.pause();
      });
      to.on("drain", () => from.resume());
      from.on("end", () => to.end());
    };
    pump(client, server, up, "up");
    pump(server, client, down, "down");

    let closed = 0;
    const finish = () => {
      if (++closed < 2) return;
      liveSockets.delete(client);
      liveSockets.delete(server);
      try { fs.closeSync(up); } catch { /* */ }
      try { fs.closeSync(down); } catch { /* */ }
      fs.writeSync(index, `${JSON.stringify({ n, opened, closed: Date.now(), up: sizes.up, down: sizes.down })}\n`);
    };
    for (const s of [client, server]) {
      s.on("close", finish);
      s.on("error", () => { client.destroy(); server.destroy(); });
    }
  };

  let listener = null;
  const listenOn = () => new Promise((resolve, reject) => {
    listener = net.createServer(onClient);
    listener.on("error", reject);
    listener.listen(wantPort, host, () => resolve(listener.address().port));
  });
  const port = await listenOn();

  return {
    port,
    connections: () => count,
    pause: () => new Promise((resolve) => {
      for (const s of liveSockets) s.destroy();
      liveSockets.clear();
      if (listener) listener.close(() => { listener = null; resolve(); });
      else resolve();
    }),
    resume: () => (listener ? Promise.resolve(port) : listenOn()),
    close: () => new Promise((resolve) => {
      for (const s of liveSockets) s.destroy();
      liveSockets.clear();
      const end = () => { try { fs.closeSync(index); } catch { /* */ } resolve(); };
      if (listener) listener.close(end);
      else end();
    }),
  };
}

// ---- Reassembly: captured bytes -> HTTP exchanges.

const CRLF2 = Buffer.from("\r\n\r\n");

/** De-chunk a `Transfer-Encoding: chunked` body; returns the decoded bytes. */
function dechunk(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf("\r\n", at, "latin1");
    if (nl < 0) break;
    const size = parseInt(buf.toString("latin1", at, nl).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = nl + 2;
    out.push(buf.subarray(start, start + size));
    at = start + size + 2;
  }
  return Buffer.concat(out);
}

/** Header block -> lowercase-keyed map, first line kept as `.line`, whole
 * block kept as `.raw` so the search covers every header VALUE, not just the
 * names. */
function parseHead(text) {
  const lines = text.split("\r\n");
  const headers = { line: lines[0], raw: text };
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** Undo any content-encoding the body declares. */
function decompress(bytes, encoding) {
  try {
    if (/gzip/.test(encoding)) return zlib.gunzipSync(bytes);
    if (/deflate/.test(encoding)) return zlib.inflateSync(bytes);
    if (/\bbr\b/.test(encoding)) return zlib.brotliDecompressSync(bytes);
  } catch { /* leave as-is */ }
  return bytes;
}

/**
 * Split one direction's byte stream into messages. Each message is its head
 * map and its decoded body. Works for requests and responses: the body length
 * is Content-Length, else chunked, else (a response that closes the
 * connection) the remainder.
 */
function splitMessages(buf, kind) {
  const messages = [];
  let at = 0;
  while (at < buf.length) {
    const headEnd = buf.indexOf(CRLF2, at);
    if (headEnd < 0) break;
    const head = parseHead(buf.toString("latin1", at, headEnd));
    const bodyStart = headEnd + 4;
    let body;
    let next;
    const cl = head["content-length"];
    if (head["transfer-encoding"] && /chunked/i.test(head["transfer-encoding"])) {
      const term = buf.indexOf(Buffer.from("0\r\n\r\n"), bodyStart);
      const end = term < 0 ? buf.length : term + 5;
      body = dechunk(buf.subarray(bodyStart, end));
      next = end;
    } else if (cl !== undefined) {
      const len = Number(cl);
      body = buf.subarray(bodyStart, bodyStart + len);
      next = bodyStart + len;
    } else {
      body = Buffer.alloc(0);
      next = bodyStart;
    }
    body = decompress(body, head["content-encoding"] || "");
    messages.push({ head, body });
    if (next <= at) break;
    at = next;
  }
  return messages;
}

/** Read every connection's two files back, in order. */
export function readCapture(dir) {
  const conns = [];
  // Every connection file on disk, whether or not it reached the index: a
  // long-poll connection cut at shutdown never wrote its index line, and its
  // bytes must be scanned too.
  const ns = [...new Set(
    fs.readdirSync(dir)
      .filter((f) => /^c\d+\.(up|down)$/.test(f))
      .map((f) => Number(f.slice(1, f.indexOf(".")))),
  )].sort((a, b) => a - b);
  for (const n of ns) {
    const upPath = path.join(dir, `c${n}.up`);
    const downPath = path.join(dir, `c${n}.down`);
    conns.push({
      n,
      requests: fs.existsSync(upPath) ? splitMessages(fs.readFileSync(upPath), "request") : [],
      responses: fs.existsSync(downPath) ? splitMessages(fs.readFileSync(downPath), "response") : [],
    });
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
      add([...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
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
function buildNeedles(spec) {
  const needles = [];
  const push = (label, value, kind) => {
    if (!value) return;
    const { forms, raws } = encodingsOf(value, kind);
    if (forms.length || raws.length) {
      needles.push({ label, kind, forms, raws: raws.map((b) => b.toString("latin1")) });
    }
  };
  for (const [label, value] of Object.entries(spec.text || {})) push(`text:${label}`, value, "text");
  for (const [label, value] of Object.entries(spec.hex || {})) push(`key:${label}`, value, "hex");
  if (spec.phrase) {
    push("recovery:phrase", spec.phrase.trim(), "text");
    for (const word of spec.phrase.trim().split(/\s+/)) {
      // A single common word is not a needle, but a run of them is the phrase,
      // covered above; individual rare words are still worth flagging.
      if (word.length >= 7) push(`recovery:word:${word.slice(0, 2)}…`, word, "text");
    }
  }
  for (const [i, code] of (spec.codes || []).entries()) push(`pairing:code:${i}`, code, "text");
  // Derived from the vault key with no other input: the domain-map key. Chunk
  // and manifest keys need the (server-visible) domain id; pass it as
  // spec.hex.domain_id to add them. None may ever appear in a capture.
  const vrk = spec.hex && spec.hex.vrk;
  if (vrk && /^[0-9a-f]{64}$/.test(vrk)) {
    const key = Buffer.from(vrk, "hex");
    const mapKey = Buffer.from(hkdfSync("sha256", key, Buffer.from("obsync/v1/domainmap"), Buffer.alloc(0), 32));
    push("key:derived:domain-map", mapKey.toString("hex"), "hex");
    const domainId = spec.hex.domain_id;
    if (domainId && /^[0-9a-f]{32}$/.test(domainId)) {
      const domainKey = Buffer.from(hkdfSync("sha256", key, Buffer.from("obsync/v1/domain"), Buffer.from(domainId), 32));
      push("key:derived:domain", domainKey.toString("hex"), "hex");
      const manifestKey = Buffer.from(hkdfSync("sha256", domainKey, Buffer.from("obsync/v1/manifest"), Buffer.from(domainId), 32));
      push("key:derived:manifest", manifestKey.toString("hex"), "hex");
    }
  }
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
function walkJson(value, out, depth) {
  if (depth > 6) return;
  if (typeof value === "string") {
    out.push(value);
    for (const b of decodeDeeper(value)) {
      out.push(b.toString("latin1"));
      try { walkJson(JSON.parse(b.toString("utf8")), out, depth + 1); } catch { /* not json */ }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) walkJson(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) { out.push(k); walkJson(value[k], out, depth + 1); }
  }
}

/**
 * Every searchable string of one message: the wire bytes verbatim (as
 * latin1, so any byte sequence -- UTF-8, UTF-16, raw key bytes -- is found by
 * substring), the percent-decoded request target, and every JSON string in
 * the body with each decodable one taken a level deeper.
 */
function viewsOf(message, isRequest) {
  const views = [];
  // The whole header block (every name AND value) plus the body, as latin1 so
  // any byte sequence in transit is found by substring.
  const wire = Buffer.concat([Buffer.from(message.head.raw + "\r\n\r\n", "latin1"), message.body]);
  views.push(wire.toString("latin1"));
  if (isRequest) {
    const target = message.head.line.split(" ")[1] || "";
    try { views.push(decodeURIComponent(target)); } catch { /* */ }
  }
  const text = message.body.toString("utf8");
  try { const collected = []; walkJson(JSON.parse(text), collected, 0); views.push(...collected); } catch { /* not json */ }
  return views;
}

// ---- The scan.

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
export function scan(conns, needles) {
  const hits = [];
  const routes = new Map();
  const requestHeaders = new Set();
  const responseHeaders = new Set();
  const jsonFields = new Set();
  const credentialLegs = new Set();
  let agent = null;

  const check = (views, where) => {
    for (const view of views) {
      for (const needle of needles) {
        if (hits.some((h) => h.label === needle.label && h.where === where)) continue;
        const hit = needle.raws.some((r) => view.includes(r)) || needle.forms.some((f) => view.includes(f));
        if (hit) hits.push({ label: needle.label, where });
      }
    }
  };

  for (const conn of conns) {
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
      check(viewsOf(req, true), "request");
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
      check(viewsOf(res, false), "response");
    }
  }
  return {
    hits,
    visible: {
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
    const spec = JSON.parse(fs.readFileSync(args.needles, "utf8"));
    const needles = buildNeedles(spec);
    const conns = readCapture(args.capture);
    const { hits, visible } = scan(conns, needles);
    const requests = conns.reduce((n, c) => n + c.requests.length, 0);
    const responses = conns.reduce((n, c) => n + c.responses.length, 0);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ decision: hits.length === 0 ? "pass" : "fail", needles: needles.length, connections: conns.length, requests, responses, hits, visible }, null, 2)}\n`);
    } else {
      process.stdout.write(`observer scan: ${conns.length} connections, ${requests} requests, ${responses} responses, ${needles.length} needles in ${needles.reduce((n, x) => n + x.forms.length + x.raws.length, 0)} encodings\n`);
      process.stdout.write(`observer scan: DECISION ${hits.length === 0 ? "PASS (zero needle hits)" : `FAIL (${hits.length} hit(s))`}\n`);
      for (const h of hits) process.stdout.write(`observer scan:   HIT ${h.label} in a ${h.where}\n`);
      process.stdout.write("observer scan: VISIBLE to the hop:\n");
      process.stdout.write(`  routes: ${visible.routes.join(", ")}\n`);
      process.stdout.write(`  request headers: ${visible.requestHeaders.join(", ")}\n`);
      process.stdout.write(`  response headers: ${visible.responseHeaders.join(", ")}\n`);
      process.stdout.write(`  json fields: ${visible.jsonFields.join(", ")}\n`);
      process.stdout.write(`  credentials in clear on this hop: ${visible.credentialLegs.join("; ") || "none observed"}\n`);
      process.stdout.write(`  user agent: ${visible.agent || "none"}\n`);
    }
    process.exit(hits.length === 0 ? 0 : 1);
  } else {
    process.stderr.write("usage: observer.mjs record --listen H:P --upstream H:P --out DIR | scan --capture DIR --needles FILE [--json]\n");
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
