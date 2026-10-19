// Synthetic loopback evidence for the request adapter loaded in real Obsidian.
// No Transport authentication/signing, plugin state writes, app launch or files.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// These functions are serialized into the native page by Page.run.
async function adapterRequest(url, method, body) {
  const request = app.plugins.plugins["obsync-private-sync"].transport.options.request;
  try {
    const response = await request({ url, method,
      headers: { Authorization: "SYNTHETIC-REDIRECT-AUTH", "X-Test-Edge": "SYNTHETIC-REDIRECT-EDGE" },
      ...(body === null ? {} : { body: Array.isArray(body) ? new Uint8Array(body).buffer : body }), throw: false });
    return { ok: true, status: response.status, text: response.text, bytes: [...new Uint8Array(response.arrayBuffer)] };
  } catch { return { ok: false }; }
}

async function followControl(url) {
  const response = await fetch(url, { method: "POST", redirect: "follow", credentials: "omit",
    headers: { Authorization: "SYNTHETIC-REDIRECT-AUTH", "X-Test-Edge": "SYNTHETIC-REDIRECT-EDGE" },
    body: "SYNTHETIC-REDIRECT-BODY", signal: AbortSignal.timeout(3000) });
  return response.status;
}

/** Accept an existing native Page, with run(fn, ...JSON arguments). */
export async function verifyNativeRedirects(page) {
  const servers = [], sockets = new Set(), observed = [];
  let destinationRequests = 0;
  const cors = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "OPTIONS") return false;
    res.setHeader("Access-Control-Allow-Methods", "GET, POST");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "");
    res.writeHead(204); res.end(); return true; // No credentialed CORS.
  };
  const listen = async (handler) => {
    const server = http.createServer(handler); servers.push(server);
    server.on("connection", (socket) => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      socket.setTimeout(3000, () => socket.destroy());
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  const run = async (fn, ...args) => {
    let timer;
    try {
      return await Promise.race([page.run(fn, ...args), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("native redirect evaluator exceeded 5000ms")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const destination = await listen((req, res) => {
      destinationRequests++; // Include preflight: any destination request fails a negative leg.
      if (cors(req, res)) return;
      req.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"reachable":true}');
    });
    const source = await listen(async (req, res) => {
      if (cors(req, res)) return;
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks), route = new URL(req.url, "http://fixture");
        const auth = req.headers.authorization === "SYNTHETIC-REDIRECT-AUTH";
        const edge = req.headers["x-test-edge"] === "SYNTHETIC-REDIRECT-EDGE";
        if (route.pathname === "/redirect") {
          observed.push({ method: req.method, status: Number(route.searchParams.get("status")), auth, edge,
            body: body.toString() === (req.method === "POST" ? "SYNTHETIC-REDIRECT-BODY" : "") });
          res.writeHead(Number(route.searchParams.get("status")), { Location: `${destination}/target` }); res.end();
        } else if (route.pathname === "/binary") {
          res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(body);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ auth, edge }));
        }
      } catch { res.destroy(); }
    });
    const json = await run(adapterRequest, `${source}/json`, "GET", null);
    assert.equal(json.status, 200, "native adapter JSON positive status");
    assert.deepEqual(JSON.parse(json.text), { auth: true, edge: true }, "native adapter synthetic headers arrive");
    const binary = await run(adapterRequest, `${source}/binary`, "POST", [0, 255, 128, 1]);
    assert.equal(binary.status, 200, "native adapter binary positive status");
    assert.deepEqual(binary.bytes, [0, 255, 128, 1], "native adapter binary positive bytes");
    const direct = await run(adapterRequest, `${destination}/direct`, "GET", null);
    assert.equal(direct.status, 200, "redirect destination direct positive status");
    assert.ok(destinationRequests > 0, "redirect destination direct positive request");
    const baseline = destinationRequests, facts = [];
    for (const status of [301, 302, 303, 307, 308]) for (const method of ["GET", "POST"]) {
      const before = observed.length;
      const result = await run(adapterRequest, `${source}/redirect?status=${status}`, method,
        method === "POST" ? "SYNTHETIC-REDIRECT-BODY" : null);
      assert.equal(result.ok, false, "native adapter must refuse redirect");
      assert.equal(observed.length, before + 1, "redirect actual source request must arrive");
      assert.deepEqual(observed[before], { method, status, auth: true, edge: true, body: true }, "redirect synthetic source inputs must arrive");
      await delay(30); // Keep the destination open for a bounded late-dispatch observation.
      assert.equal(destinationRequests, baseline, "redirect destination must receive zero requests including preflight");
      facts.push({ status, method, sourceRequests: 1, destinationRequests: 0, refused: true });
    }
    const followed = await run(followControl, `${source}/redirect?status=307`);
    assert.equal(followed, 200, "redirect explicit follow positive status");
    assert.ok(destinationRequests > baseline, "redirect explicit follow positive destination request");
    return { redirects: facts, jsonPositive: true, binaryPositive: true, directPositive: true, followPositive: true };
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}
