#!/usr/bin/env node
// Two people typing into one open note on two paired desktop Obsidian instances,
// optionally beside a third paired instance that types nothing (issue #227).
//
// usage: node scripts/validation/cotype-live.mjs <portX> <titleX> <portY> <titleY> <durationMs> <intervalMs> <idleMs> [traceDir]
//   <port*>   an instance's --remote-debugging-port; <title*> text in its vault window's title, such as
//             "rig-B - Obsidian". Obsidian's separate Settings window ("Settings - ...") is never picked.
//   PASSIVE="<port>|<title>"  a third paired instance that types nothing; PASSIVE_OPEN=1 shows the note there
//
// Standard run (docs/validation-runs/2026-09-29-cotyping-three-devices.md): six CPU burners beside it,
// `60000 200 60000` -- a minute of typing at 200 ms a keystroke on each side, then a minute of nobody typing.
//
// X types "A001 A002 ..." on the note's last line; Y types " B001 B002 ..." at the end of line 1.
// Each keystroke sets that person's cursor, then sends DevTools Input.insertText: a trusted beforeinput,
// the input obsync counts as typing. Then every side idles, and the note is judged.
//
// PASS only when all of these hold: every disk holds EXACTLY the expected text (every typed token, in
// order, on its line, and the two fixed lines intact); each open editor shows its disk; no conflict copy
// of this run's note exists anywhere. The note is new each run, so any copy is this run's. The notices
// each instance showed are counted and printed. With a traceDir, every obsync log line and every save of
// the note is written there per side. The instances must already be paired; this reads and prints no
// secret, and the fixture text is sentinel-only.
//
// PLACE=same (#339): both carets are placed ONCE after the "0" that starts line 3 and never moved again,
// so the editor maps each caret through the other side's text as a person would see it. Key i is one code
// point past key i-1 (X counts up from U+4E00, Y from U+AC00), so no two keys share a character, and every
// seventh is a mistyped key deleted next with a trusted Backspace. PASS then needs, on every disk and
// editor: line 3 holding exactly X's kept keys and Y's kept keys, each in typed order; no mistyped key
// left; the other lines intact; no conflict copy; and no state the editor ever showed or the vault ever
// saved, on either side, holding one person's keys other than strictly rising (`transient`: a key twice
// or two keys swapped). Each page checks every state itself and keeps only the ones that break the rule;
// `checked` counts the states it saw, so a zero `transient` is never a check that did not run.
//
// A window another covers is hidden, and Chromium throttles a hidden page's timers and work: a covered
// instance saved typing a minute late and made no request for four minutes (2026-09-29). Each side's
// hidden time is printed (`hidden_ms`); a run with any is the host's, not the sync's. Instances launched
// with --disable-backgrounding-occluded-windows --disable-renderer-backgrounding are never hidden so.
const [, , px, tx, py, ty, durArg, ivArg, idleArg, traceDir] = process.argv;
const DURATION = Number(durArg), INTERVAL = Number(ivArg), IDLE = Number(idleArg);
if (!px || !tx || !py || !ty || !(DURATION > 0) || !(INTERVAL > 0) || !(IDLE >= 0)) {
  console.error("usage: node cotype-live.mjs <portX> <titleX> <portY> <titleY> <durationMs> <intervalMs> <idleMs> [traceDir]");
  process.exit(2);
}
const SAME = process.env.PLACE === "same";
const NOTE = `Both-${Date.now().toString(36)}.md`;
const STEM = NOTE.slice(0, -3);
const START = SAME ? "# Both\nthe line nobody edits\n0\n" : "# Both\nthe line nobody edits\nthe last fixed line\n";

async function pick(port, sel) {
  const all = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
  const hits = all.filter((t) => t.title.includes(sel) && !t.title.startsWith("Settings - "));
  if (hits.length !== 1) throw new Error(`${hits.length} targets match ${sel} on port ${port}`);
  return hits[0];
}

async function session(port, sel) {
  const target = await pick(port, sel);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.addEventListener("open", ok, { once: true }); ws.addEventListener("error", bad, { once: true }); });
  let next = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { ok, bad } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) bad(new Error(msg.error.message)); else ok(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((ok, bad) => { const id = next++; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params })); });
  const answer = (r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const js = async (expression) => answer(await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }));
  // A function run in the page with its values passed as arguments, never written into its code.
  const call = async (functionDeclaration, ...values) => {
    const { result } = await send("Runtime.evaluate", { expression: "globalThis" });
    return answer(await send("Runtime.callFunctionOn", {
      objectId: result.objectId, functionDeclaration, arguments: values.map((value) => ({ value })),
      awaitPromise: true, returnByValue: true, userGesture: true,
    }));
  };
  return { send, js, call, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// PLACE=same: the first code point of each person's keys, and how many keys each block holds.
const X_KEYS = 0x4e00, Y_KEYS = 0xac00, KEYS = 11172;
// True when each person's keys in the text rise strictly: no key twice, none out of typed order.
const RISING = `(text) => {
  let x = 0, y = 0;
  for (const c of text) {
    const p = c.codePointAt(0);
    if (p >= ${X_KEYS} && p < ${X_KEYS + KEYS}) { if (p <= x) return false; x = p; }
    else if (p >= ${Y_KEYS} && p < ${Y_KEYS + KEYS}) { if (p <= y) return false; y = p; }
  }
  return true;
}`;
// The trace: obsync's own log lines, and the note's text at each save the vault reports.
const HOOK = `function (note) {
  window.__cotype = { note, lines: [], notices: [], hiddenMs: 0, hiddenAt: document.hidden ? Date.now() : null,
    checked: 0, broken: [], rising: ${RISING} };
  if (!window.__cotypeVisibility) {
    document.addEventListener("visibilitychange", () => {
      const c = window.__cotype;
      if (!c) return;
      if (document.hidden) c.hiddenAt ??= Date.now();
      else if (c.hiddenAt !== null) { c.hiddenMs += Date.now() - c.hiddenAt; c.hiddenAt = null; }
    });
    window.__cotypeVisibility = true;
  }
  if (!window.__cotypeNotices) {
    // Every notice Obsidian shows in this window, with its words, as it appears.
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.classList.contains("notice") && window.__cotype) {
          window.__cotype.notices.push({ at: Date.now(), node: n });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    window.__cotypeNotices = true;
  }
  if (!window.__cotypeHooked) {
    for (const k of ["debug", "warn"]) {
      const f = console[k];
      console[k] = (...a) => { const s = a.join(" "); if (window.__cotype && /^obsync /.test(s) && !/path_class=folder/.test(s)) window.__cotype.lines.push(Date.now() + " " + s); f(...a); };
    }
    app.vault.on("modify", async (file) => {
      if (!window.__cotype || file.path !== window.__cotype.note) return;
      const at = Date.now();
      const text = await app.vault.adapter.read(file.path).catch(() => null);
      const c = window.__cotype;
      c.lines.push(at + " vault modify text=" + JSON.stringify(text));
      if (text !== null && (c.checked++, !c.rising(text))) c.broken.push(at + " vault modify text=" + JSON.stringify(text));
    });
    window.__cotypeHooked = true;
  }
  require("electron").remote.getCurrentWindow().showInactive();
  return "hooked";
}`;
const OPEN = `async function (note) {
  const f = app.vault.getAbstractFileByPath(note);
  if (!f) return "missing";
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(f, { state: { mode: "source" } });
  await new Promise((r) => setTimeout(r, 300));
  const v = app.workspace.activeLeaf.view;
  if (!v.editor) return "no editor";
  // Every transaction the editor applies, typed or synced, is checked; a text that breaks the rule is kept.
  const cm = v.editor.cm;
  if (cm && !cm.__cotypeTraced) {
    const dispatch = cm.dispatch.bind(cm);
    cm.dispatch = (...specs) => {
      const result = dispatch(...specs);
      const c = window.__cotype, text = cm.state.doc.toString();
      if (c && (c.checked++, !c.rising(text))) c.broken.push(Date.now() + " editor text=" + JSON.stringify(text));
      return result;
    };
    cm.__cotypeTraced = true;
  }
  v.editor.focus();
  return "open " + v.getMode();
}`;
const CURSOR = {
  end: `(() => { const e = app.workspace.activeLeaf.view.editor; e.focus(); const l = e.lastLine(); e.setCursor({ line: l, ch: e.getLine(l).length }); return true; })()`,
  line1: `(() => { const e = app.workspace.activeLeaf.view.editor; e.focus(); e.setCursor({ line: 0, ch: e.getLine(0).length }); return true; })()`,
  zero: `(() => { const e = app.workspace.activeLeaf.view.editor; e.focus(); e.setCursor({ line: 2, ch: 1 }); return true; })()`,
};
const BACKSPACE = "\b";
const READ = `async function (note, copy) {
  const view = app.workspace.getLeavesOfType("markdown").map((l) => l.view).find((v) => v.file?.path === note);
  const disk = await app.vault.adapter.read(note);
  const copies = app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith(copy));
  const status = document.querySelector(".obsync-status");
  const c = window.__cotype;
  return JSON.stringify({ editor: view?.editor?.getValue() ?? null, disk, copies,
    status: status ? (status.getAttribute("aria-label") || status.textContent) : null,
    hidden_ms: c ? c.hiddenMs + (c.hiddenAt === null ? 0 : Date.now() - c.hiddenAt) : null,
    lines: window.__cotype?.lines ?? [], checked: c?.checked ?? 0, broken: c?.broken ?? [],
    notices: (window.__cotype?.notices ?? []).map(({ at, node }) => ({ at, text: (node.textContent || "").trim() })) });
}`;

function stream(prefix, lead, n) {
  let s = "";
  for (let i = 1; i <= n; i++) s += `${lead(i)}${prefix}${String(i).padStart(3, "0")}`;
  return s;
}

const X = await session(px, tx);
const Y = await session(py, ty);
// An optional third device that types nothing: PASSIVE="<port>|<title>", PASSIVE_OPEN=1 to show the note there.
const [pz, tz] = (process.env.PASSIVE ?? "").split("|");
const Z = pz ? await session(pz, tz) : null;
const sides = [["X", X], ["Y", Y], ...(Z ? [["Z", Z]] : [])];
console.log("note", NOTE, "hook", ...(await Promise.all(sides.map(([, s]) => s.call(HOOK, NOTE)))));
await X.call(`async function (note, text) { await app.vault.create(note, text); return "created"; }`, NOTE, START);
for (const [name, s] of sides.slice(1)) {
  let arrived = false;
  for (let i = 0; i < 120 && !arrived; i++) {
    arrived = await s.call(`async function (note, text) { return (await app.vault.adapter.exists(note)) && (await app.vault.adapter.read(note)) === text; }`, NOTE, START);
    if (!arrived) await sleep(500);
  }
  if (!arrived) throw new Error(`the note never arrived on ${name}`);
}
console.log("open", await X.call(OPEN, NOTE), await Y.call(OPEN, NOTE), Z && process.env.PASSIVE_OPEN === "1" ? await Z.call(OPEN, NOTE) : "");
await sleep(1500);

const n = Math.ceil(DURATION / INTERVAL / 5) + 2;
// Same place: key i is the code point i past the person's first, every seventh mistyped and the next its
// Backspace.
const ticks = Math.ceil(DURATION / INTERVAL) + 2;
if (SAME && ticks > KEYS) throw new Error(`PLACE=same holds ${KEYS} keys a person; ${ticks} asked`);
const keys = (first) => [...Array(ticks)].map((_, i) => i % 8 === 7 ? BACKSPACE : String.fromCodePoint(first + i)).join("");
const aText = SAME ? keys(X_KEYS) : stream("A", (i) => (i === 1 ? "" : " "), n);
const bText = SAME ? keys(Y_KEYS) : stream("B", () => " ", n);
let ai = 0, bi = 0;
const t0 = Date.now();
if (SAME) for (const s of [X, Y]) await s.js(CURSOR.zero);
const typist = async (s, where, text, advance) => {
  while (Date.now() - t0 < DURATION) {
    const tick = Date.now();
    if (!SAME) await s.js(CURSOR[where]);
    const key = text[advance()];
    if (key !== BACKSPACE) await s.send("Input.insertText", { text: key });
    else for (const type of ["rawKeyDown", "keyUp"]) {
      await s.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    }
    const rest = INTERVAL - (Date.now() - tick);
    if (rest > 0) await sleep(rest);
  }
};
await Promise.all([typist(X, "end", aText, () => ai++), typist(Y, "line1", bText, () => bi++)]);
const typedA = aText.slice(0, ai), typedB = bText.slice(0, bi);
const kept = (typed) => typed.replace(/.\x08/gsu, "");
const of = (first) => (text) => [...text].filter((c) => c.codePointAt(0) >= first && c.codePointAt(0) < first + KEYS).join("");
const ofA = of(X_KEYS), ofB = of(Y_KEYS);
const typedMs = Date.now() - t0;
console.log(`typed: X ${ai} chars (${typedA.slice(-9)}), Y ${bi} chars (${typedB.slice(-9)}) in ${typedMs} ms; idle ${IDLE} ms`);
await sleep(IDLE);
const read = {};
for (const [name, s] of sides) read[name] = JSON.parse(await s.call(READ, NOTE, `${STEM} (conflict`));
const all = Object.values(read);
const expected = SAME ? null : `# Both${typedB}\nthe line nobody edits\nthe last fixed line\n${typedA}`;
const third = (r) => r.disk.split("\n")[2] ?? "";
const verdict = {
  exact: SAME ? all.every((r) => r.disk === all[0].disk && third(r).startsWith("0") &&
    ofA(third(r)).length + ofB(third(r)).length === [...third(r)].length - 1 &&
    ofA(third(r)) === kept(typedA) && ofB(third(r)) === kept(typedB))
    : all.every((r) => r.disk === expected),
  same_disk: all.every((r) => r.disk === all[0].disk),
  editor_is_disk: all.every((r) => r.editor === null || r.editor === r.disk),
  all_A: all.every((r) => SAME ? ofA(third(r)) === kept(typedA) : r.disk.includes(typedA)),
  all_B: all.every((r) => SAME ? ofB(third(r)) === kept(typedB) : r.disk.split("\n")[0] === `# Both${typedB}`),
  transient: SAME ? all.reduce((sum, r) => sum + r.broken.length, 0) : 0,
  checked: all.map((r) => r.checked),
  fixed_lines: all.every((r) => r.disk.startsWith(SAME ? "# Both\nthe line nobody edits\n0" : "# Both")
    && (SAME || r.disk.includes("\nthe line nobody edits\nthe last fixed line\n"))),
  copies: new Set(all.flatMap((r) => r.copies)).size,
};
const count = (lines, word) => lines.filter((l) => l.includes(word)).length;
const tally = (r) => ["decision=merged", "reason=unmerged", "role=keep", "role=yield", "decision=editor_refreshed", "reason=merge_storm", "merge_ancestry_limit", "ok=false"]
  .map((w) => `${w.replace(/^(decision|reason)=/, "")}=${count(r.lines, w)}`).join(" ");
const pass = verdict.exact && verdict.editor_is_disk && verdict.copies === 0 && verdict.transient === 0 &&
  (!SAME || (read.X.checked > 0 && read.Y.checked > 0));
console.log("verdict", JSON.stringify(verdict));
// Notices each side showed during the run: how many, and each distinct text with its count.
const notices = (r) => {
  const byText = new Map();
  for (const { text } of r.notices) byText.set(text, (byText.get(text) ?? 0) + 1);
  return `${r.notices.length} ${JSON.stringify([...byText].map(([text, k]) => `${k}x ${text}`))}`;
};
for (const [name] of sides) {
  console.log(name, tally(read[name]), `hidden_ms=${read[name].hidden_ms}`, "status", JSON.stringify(read[name].status));
  console.log(name, "notices", notices(read[name]));
}
if (traceDir) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(traceDir, { recursive: true });
  for (const [name] of sides) writeFileSync(`${traceDir}/${name}.log`, [...read[name].lines, ...read[name].broken.map((b) => "BROKEN " + b)].join("\n") + "\n");
  writeFileSync(`${traceDir}/final.json`, JSON.stringify({ note: NOTE, typedA, typedB, typedMs, expected,
    ...Object.fromEntries(sides.map(([name]) => [name, { ...read[name], lines: undefined }])) }, null, 1));
}
if (!pass) for (const [name] of sides) console.log(name, "disk", JSON.stringify(read[name].disk));
console.log(`RESULT ${pass ? "pass" : "fail"}`);
for (const [, s] of sides) s.close();
