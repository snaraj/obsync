import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import { verifyNativeRedirects } from "./obsidian-redirect.mjs";

function fakePage(mode = "secure") {
  const seen = [], addresses = new Set();
  const request = async (input) => {
    seen.push(input); addresses.add(new URL(input.url).origin);
    assert.deepEqual(Object.keys(input.headers).sort(), ["Authorization", "X-Test-Edge"]);
    assert.equal(input.headers.Authorization, "SYNTHETIC-REDIRECT-AUTH");
    assert.equal(input.headers["X-Test-Edge"], "SYNTHETIC-REDIRECT-EDGE");
    const redirect = new URL(input.url).pathname === "/redirect";
    if (redirect && mode === "skip-source") throw new TypeError("synthetic refusal without a request");
    if (mode === "false-direct" && input.url.endsWith("/direct")) return { status: 200, text: "{}", arrayBuffer: new ArrayBuffer(0) };
    const headers = { ...input.headers };
    if (mode === "lost-input" || redirect && mode === "lost-redirect-input") delete headers.Authorization;
    const response = await fetch(input.url, { method: input.method, headers, body: input.body,
      credentials: "omit", redirect: redirect && ["accept-redirect", "leak-preflight"].includes(mode) ? "manual" : redirect && mode === "leak-destination" ? "follow" : "error" });
    if (redirect && mode === "leak-preflight") {
      const preflight = await fetch(response.headers.get("location"), { method: "OPTIONS", headers: {
        "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,x-test-edge" } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
      assert.equal(preflight.headers.get("access-control-allow-headers"), "authorization,x-test-edge");
      throw new TypeError("synthetic refusal after preflight exposure");
    }
    if (redirect && mode === "leak-destination") throw new TypeError("synthetic refusal after exposure");
    const arrayBuffer = await response.arrayBuffer();
    if (mode === "wrong-binary" && new URL(input.url).pathname === "/binary") new Uint8Array(arrayBuffer)[0] = 9;
    const wrongStatus = mode === "wrong-json-status" && input.url.endsWith("/json") ||
      mode === "wrong-binary-status" && input.url.endsWith("/binary") || mode === "wrong-direct-status" && input.url.endsWith("/direct");
    return { status: wrongStatus ? 500 : response.status, text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
  };
  const plugin = Object.freeze({ transport: Object.freeze({ options: Object.freeze({ request }) }),
    get state() { throw new Error("plugin state must not be read"); }, loadData() { throw new Error("credentials must not be read"); } });
  const app = Object.freeze({ plugins: Object.freeze({ plugins: Object.freeze({ "obsync-private-sync": plugin }) }),
    get secretStorage() { throw new Error("credentials must not be read"); } });
  return { seen, addresses, run: async (fn, ...args) => {
    if (mode === "page-failure" && fn.toString().includes('redirect: "follow"')) throw new Error("synthetic page failure");
    const browserFetch = async (url, options) => {
      assert.equal(options.credentials, "omit");
      if (mode === "false-follow-control") return { status: 200 };
      const response = await fetch(url, options);
      return mode === "wrong-follow-status" ? { status: 500 } : response;
    };
    const result = await vm.runInNewContext(`(${fn})(...args)`, { app, args, fetch: browserFetch, Uint8Array, AbortSignal });
    return JSON.parse(JSON.stringify(result)); // Page.run returns CDP JSON, not VM-realm objects.
  } };
}

async function assertClosed(page) {
  for (const address of page.addresses) await assert.rejects(fetch(`${address}/after-cleanup`), TypeError);
}

test("real loopback fixture proves ten redirect refusals and JSON/binary/reachable-follow positives with synthetic inputs only", async () => {
  const page = fakePage();
  const facts = await verifyNativeRedirects(page);
  assert.equal(facts.redirects.length, 10);
  assert.deepEqual(facts.redirects.map(({ status, method }) => [status, method]), [301, 302, 303, 307, 308].flatMap((status) => [[status, "GET"], [status, "POST"]]));
  assert.ok(facts.redirects.every((row) => row.refused && row.sourceRequests === 1 && row.destinationRequests === 0));
  assert.equal(facts.followPositive && facts.directPositive && facts.jsonPositive && facts.binaryPositive, true);
  assert.equal(JSON.stringify(facts).includes("SYNTHETIC"), false);
  assert.equal(page.seen.length, 13);
  await assertClosed(page);
});

for (const [mode, reason] of [
  ["accept-redirect", "native adapter must refuse redirect"],
  ["skip-source", "redirect actual source request must arrive"],
  ["leak-destination", "redirect destination must receive zero requests including preflight"],
  ["leak-preflight", "redirect destination must receive zero requests including preflight"],
  ["false-follow-control", "redirect explicit follow positive destination request"],
  ["wrong-follow-status", "redirect explicit follow positive status"],
  ["false-direct", "redirect destination direct positive request"],
  ["wrong-direct-status", "redirect destination direct positive status"],
  ["wrong-json-status", "native adapter JSON positive status"],
  ["wrong-binary-status", "native adapter binary positive status"],
  ["lost-input", "native adapter synthetic headers arrive"],
  ["lost-redirect-input", "redirect synthetic source inputs must arrive"],
  ["wrong-binary", "native adapter binary positive bytes"],
]) test(`fixture refuses ${mode} and closes sockets`, async () => {
  const page = fakePage(mode);
  await assert.rejects(verifyNativeRedirects(page), (error) => error instanceof assert.AssertionError && error.message.includes(reason));
  await assertClosed(page);
});

test("page failure closes the host fixture too", async () => {
  const page = fakePage("page-failure");
  await assert.rejects(verifyNativeRedirects(page), /synthetic page failure/);
  await assertClosed(page);
});

test("desktop driver runs the native redirect fixture after plugin load and before enrollment", () => {
  const driver = fs.readFileSync(new URL("./obsidian-drive.mjs", import.meta.url), "utf8");
  const call = driver.indexOf("await verifyNativeRedirects(await a.main());");
  assert.ok(call > driver.indexOf("prove(`two instances:"), "redirect fixture must run after plugin load");
  assert.ok(call < driver.indexOf("await setServer(a, url);"), "redirect fixture must run before enrollment");
  assert.ok(driver.includes('import { verifyNativeRedirects } from "./obsidian-redirect.mjs";'), "redirect fixture import must be present");
});
