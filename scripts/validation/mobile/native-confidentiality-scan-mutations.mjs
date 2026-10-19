import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source = readFileSync(new URL('./native-confidentiality-scan.mjs', import.meta.url), 'utf8');
const test = fileURLToPath(new URL('./native-confidentiality-scan.test.mjs', import.meta.url));
const mutations = [
  ['public-template-failure-code', "'public_template_source', ", ''],
  ['mnemonic-label-redaction', "else if (label === 'recovery:mnemonic') labelClass", 'else if (false) labelClass'],
  ['response-pairing-context', "pairedRequest ? [pairedRequest] : []", '[]'],
  ['message-budget-before-decode', "        if (Date.now() >= deadline) { result.status = 'TIME_BUDGET'; break outer; }\n        if (result.messagesInspected", '        if (result.messagesInspected'],
  ['failure-provenance-shape', "typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value) ? value : null", 'value'],
  ['message-route-never-retained', 'result.rows.push({ connectionIndex, messageIndex, direction:', 'result.rows.push({ route: message.head.line, connectionIndex, messageIndex, direction:'],
  ['failure-evidence-exclusive', "writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });", "writeFileSync(path, bytes, { mode: 0o600, flag: 'w' });"],
  ['traffic-main-guard-required', "  requireNativeTraffic(run, report, { sourceHead: lab.source_head, bundleSha256: lab.artifacts['plugin/main.js'], observerSha256, captureManifestSha256 }, traffic, secrets.needles, observer, started + 60000); budget();", '  budget();'],
  ['traffic-failure-cannot-return', "  throw failure;", '  return;'],
  ['failure-hit-redaction', 'return { labelClass, indexes, direction:', 'return { labelClass: label, indexes, direction:'],
  ['failure-error-redaction', "const errorCode = value => ERROR_CODES.has(value) ? value : 'UNKNOWN';", 'const errorCode = value => value;'],
  ['failure-evidence-required', "writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });", 'void path;'],
  ['failed-write-cannot-return', '  } catch { /* The original scan refusal is never replaced by a diagnostic failure. */ }', '  } catch { return; }'],
  ['failure-result-never-pass', "schema: 1, result: 'FAIL', origin: 'native-confidentiality-failure'", "schema: 1, result: 'PASS', origin: 'native-confidentiality-failure'"],
  ['failure-source-bound', 'sourceHead: hash(binding.sourceHead, 40)', 'sourceHead: null'],
  ['failure-observer-bound', 'observerSha256: hash(binding.observerSha256, 64)', 'observerSha256: null'],
  ['failure-capture-bound', 'captureManifestSha256: hash(binding.captureManifestSha256, 64)', 'captureManifestSha256: null'],
  ['message-row-cap', 'if (result.rows.length >= 32) continue;', 'if (result.rows.length >= 64) continue;'],
  ['message-inspection-cap', 'result.messagesInspected >= 4096', 'result.messagesInspected >= 8192'],
  ['message-body-size', 'bodyBytes: Buffer.isBuffer(message.body) ? message.body.length : null', 'bodyBytes: null'],
  ['message-status', 'status: status ? +status[1] : null', 'status: null'],
  ['message-not-localized', "result.matchingMessages > 0 ? 'MESSAGE_MATCHES' : 'NOT_LOCALIZED'", "'MESSAGE_MATCHES'"],
  ['message-late-return', "        if (Date.now() >= deadline) { result.status = 'TIME_BUDGET'; break outer; }\n        if (!report", '        if (!report'],
  ['cli-failure-exit', 'process.exitCode = 1;', 'process.exitCode = 0;'],
  ['cli-failure-class', 'failureClass: error.failureClass, failureEvidence: error.failureEvidence', 'failureEvidence: error.failureEvidence'],
  ['complete-backup-inventory', "need(Array.isArray(paths) && JSON.stringify(paths) === JSON.stringify(expected), 'complete_backup_inventory');", ''],
  ['sealed-file-hash', 'declared.sha256 === digest(bytes)', 'true'],
  ['nonempty-input', '(allowEmpty || stat.size > 0)', 'true'],
  ['aggregate-budget', '(counter.bytes += stat.size) <= MAX', 'true'],
  ['verified-http-parse', 'need(connections.length > 0', 'need(true || connections.length > 0'],
  ['http-positive-control', "need(report.decision === 'fail'", "need(true || report.decision === 'fail'"],
  ['opaque-positive-control', "need(detected, 'planted_opaque_not_detected');", ''],
  ['metadata-secret-scan', "opaque(bytes, needles, 'android_metadata');", ''],
];
const scratch = mkdtempSync(join(tmpdir(), 'obsync-confidentiality-mutants-'));
try {
  for (const [name, before, after] of mutations) {
    if (source.split(before).length !== 2) throw Error(`mutation target changed: ${name}`);
    const path = join(scratch, name + '.mjs');
    let changed = source.replace(before, after);
    for (const dependency of ['desktop-guard.mjs', 'ciphertext-oracle.mjs']) changed = changed.replace(`'./${dependency}'`, JSON.stringify(new URL('./' + dependency, import.meta.url).href));
    writeFileSync(path, changed);
    const run = spawnSync(process.execPath, ['--test', test], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, OBSYNC_CONFIDENTIALITY_SCANNER_MODULE: pathToFileURL(path).href } });
    if (run.status === 0 || !`${run.stdout}${run.stderr}`.includes('AssertionError')) throw Error(`mutation survived or lacked assertion failure: ${name}`);
    console.log(`${name}: KILLED`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
