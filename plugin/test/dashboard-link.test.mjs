/**
 * `Open dashboard` resolves the server's link, and refuses to leave the
 * server this device is configured to talk to.
 *
 * The link arrives from the server, and it carries a single-use dashboard
 * token that signs the holder in to every administrative action the dashboard
 * offers, revoking a device among them. So the answer is DATA here, never an
 * instruction: it is resolved against the Server URL the operator typed — the
 * server usually answers with the relative `/login?token=…`, because a private
 * deployment advertises no address of its own — and it is opened only when the
 * resolved origin is the configured one.
 *
 * These drive the REAL `openDashboard`, loaded from `build/main.js` inside the
 * sandbox where `obsidian` resolves to the stub that records notices. Only the
 * transport's one answer and the browser's `window.open` are fakes.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { join } from "node:path";
import { fakeState, sandbox } from "./fake.mjs";

/** What `fakeState` configures this device with, and every origin below. */
const SERVER = "https://sync.example.invalid";

const box = sandbox();
const ObsyncPlugin = box.require(join(box.home, "build", "main.js")).default;
const obsidian = box.require("obsidian");

/** The device: a real plugin object, one canned answer, a recording browser. */
async function device(t, url, { serverUrl } = {}) {
  const { state } = await fakeState(false);
  state.data.serverUrl = serverUrl ?? SERVER;
  const opened = [];
  const logs = [];
  const instance = Object.create(ObsyncPlugin.prototype);
  instance.state = state;
  instance.transport = { dashboardLoginLink: async () => ({ outcome: "ok", value: { url, expires: 1 } }) };
  instance.log = (line) => logs.push(line);
  const previous = globalThis.window;
  globalThis.window = { open: (target, disposition) => opened.push(`${target} ${disposition}`) };
  t.after(() => { globalThis.window = previous; });
  const before = obsidian.notices.length;
  return { instance, opened, logs, said: () => obsidian.notices.slice(before).join(" "), server: state.data.serverUrl };
}

test("a relative link is opened at the configured server", async (t) => {
  const { instance, opened, logs, server } = await device(t, "/login?token=abcdef");

  await instance.openDashboard();

  assert.deepEqual(opened, [`${server}/login?token=abcdef _blank`]);
  assert.deepEqual(logs, ["dashboard decision=opened"]);
});

test("an absolute link to the configured server is opened unchanged", async (t) => {
  const { instance, opened } = await device(t, `${SERVER}/login?token=abcdef`);

  await instance.openDashboard();

  assert.deepEqual(opened, [`${SERVER}/login?token=abcdef _blank`]);
});

test("a link to another origin is refused, and says which one", async (t) => {
  const { instance, opened, logs, said, server } = await device(t, "https://evil.example.invalid/login?token=abcdef");

  await instance.openDashboard();

  assert.deepEqual(opened, [], "the browser is never sent there");
  assert.match(said(), /https:\/\/evil\.example\.invalid/, "the refusal names the origin that answered");
  assert.ok(said().includes(server), "and the origin that was configured");
  assert.deepEqual(logs, ["dashboard decision=refused reason=foreign_origin"]);
});

test("the same host over http is another origin, and is refused", async (t) => {
  // The other downgrade this guard exists for. Host and port match, so a
  // comparison that dropped the SCHEME would open a single-use dashboard
  // sign-in token over cleartext.
  const { instance, opened, logs, said } = await device(t, "http://sync.example.invalid/login?token=abcdef");

  await instance.openDashboard();

  assert.deepEqual(opened, [], "the token never leaves over http");
  assert.match(said(), /http:\/\/sync\.example\.invalid/, "the refusal names the scheme that answered");
  assert.deepEqual(logs, ["dashboard decision=refused reason=foreign_origin"]);
});

test("the same host on another port is another origin, and is refused", async (t) => {
  // The 1.0.1 defect in its quietest form: a deployment published on a
  // non-default HTTPS port, advertising itself on the default one.
  const { instance, opened, logs } = await device(t, "https://sync.example.invalid:8443/login?token=abcdef");

  await instance.openDashboard();

  assert.deepEqual(opened, []);
  assert.deepEqual(logs, ["dashboard decision=refused reason=foreign_origin"]);
});

test("an answer that is not an address at all is refused", async (t) => {
  const { instance, opened, logs, said } = await device(t, "https://");

  await instance.openDashboard();

  assert.deepEqual(opened, []);
  assert.match(said(), /cannot read as an address/);
  assert.deepEqual(logs, ["dashboard decision=refused reason=not_a_link"]);
});

test("an opaque Server URL cannot be matched by an opaque link", async (t) => {
  // `new URL("javascript:…", new URL("foo:bar")).origin` is the string `null`,
  // and so is the base's: origin equality ALONE would open it. The Server URL
  // being http(s) is what makes that comparison mean something.
  const { instance, opened, logs, said } = await device(t, "javascript:alert(1)", { serverUrl: "foo:bar" });

  await instance.openDashboard();

  assert.deepEqual(opened, []);
  assert.match(said(), /not an http or https address/);
  assert.deepEqual(logs, ["dashboard decision=refused reason=server_url"]);
});

test("no refusal writes the link, or its token, to the log", async (t) => {
  const { instance, logs, said } = await device(t, "https://evil.example.invalid/login?token=abcdef");

  await instance.openDashboard();

  assert.ok(!logs.join(" ").includes("abcdef"), "the log records the decision, never the credential");
  assert.ok(!said().includes("abcdef"), "and neither does the notice");
});
