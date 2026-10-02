import { read, fstat, close } from 'node:fs';
import { isatty } from 'node:tty';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { Socket } from 'node:net';
import { CliError, refuse } from './errors.mjs';

const require = createRequire(import.meta.url);
const readFd = promisify(read), statFd = promisify(fstat), closeFd = promisify(close);

async function phrase(fd) {
  refuse(/^[0-9]{1,3}$/.test(fd) && Number(fd) >= 3, 'invalid_input',
    'Supply a protected inherited phrase descriptor from 3 to 999; never put recovery words in arguments.');
  fd = Number(fd);
  const buffer = Buffer.alloc(1025);
  let timer, channel;
  try {
    refuse(!isatty(fd), 'phrase_channel', 'The recovery phrase must use a protected inherited pipe or private file.', 4);
    const stat = await statFd(fd);
    const file = stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= 1024;
    refuse(file || stat.isFIFO() || stat.isSocket(), 'phrase_channel', 'The phrase descriptor is not a protected inherited pipe or owned 0600 file.', 4);
    if (!file) {
      channel = new Socket({ fd, readable: true, writable: false });
      return await new Promise((resolve, reject) => {
        let length = 0;
        channel.on('data', bytes => {
          if (length + bytes.length > 1024) {
            reject(new CliError('invalid_phrase', 'The recovery phrase has an invalid length.'));
            channel.destroy();
          } else { bytes.copy(buffer, length); length += bytes.length; }
        });
        channel.once('end', () => {
          try {
            refuse(length > 0, 'invalid_phrase', 'The recovery phrase has an invalid length.');
            resolve(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
          } catch (error) { reject(error); }
        });
        channel.once('error', () => reject(new CliError('phrase_channel', 'The recovery phrase channel failed.', 4)));
        timer = setTimeout(() => {
          reject(new CliError('phrase_deadline', 'The phrase channel did not close within five seconds.', 7));
          channel.destroy();
        }, 5000);
      });
    }
    return await (async () => {
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await readFd(fd, buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      refuse(length > 0 && length <= 1024, 'invalid_phrase', 'The recovery phrase has an invalid length.');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    })();
  } finally {
    clearTimeout(timer);
    if (channel) channel.destroy();
    else await closeFd(fd).catch(() => {});
    buffer.fill(0);
  }
}

export async function openExport(options) {
  refuse(['darwin', 'linux'].includes(process.platform), 'unsupported_platform',
    'Private offline export writes are currently unavailable on this platform.', 6);
  for (const field of ['archive', 'destination', 'vault-root']) {
    refuse(typeof options[field] === 'string' && isAbsolute(options[field]) && options[field].length <= 4096,
      'invalid_input', `Supply --${field} as an explicit absolute path.`);
  }
  refuse(options.plaintext === true, 'plaintext_acknowledgment',
    'Opening an export creates plaintext; add --plaintext only for the explicit private destination.', 4);
  let modules;
  try {
    modules = { ...require('./shared/exportDesktop.js'), ...require('./shared/export.js'), ...require('./shared/pairing.js') };
  } catch {
    throw new CliError('missing_component', 'The shared export component is absent; use the complete verified CLI package.', 6);
  }
  let key;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  process.once('SIGINT', cancel);
  const started = Date.now();
  let progress = started;
  try {
    try { key = await modules.entropyFromPhrase(modules.normalisePhrase(await phrase(options['phrase-fd']))); }
    catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('invalid_phrase', 'The recovery phrase is invalid; no output was published.');
    }
    const check = modules.exportBudget(() => {
      if (cancelled) throw new CliError('cancelled', 'Offline export was cancelled; inspect its explicit destination before retrying.', 7);
      if (Date.now() - progress >= 5000) {
        progress = Date.now();
        process.stderr.write(`${JSON.stringify({ event: 'export_progress', decision: 'running', duration_ms: progress - started, budget_ms: modules.EXPORT_WORK_MS })}\n`);
      }
    });
    const result = await new modules.DesktopExports(options['vault-root']).open(
      options.archive, options.destination, key, options['allow-server-origin'] === true, check);
    return { files: result.files, bytes: String(result.bytes), plaintext: true,
      server_origin_acknowledged: options['allow-server-origin'] === true };
  } catch (error) {
    if (error instanceof CliError) throw error;
    const reason = error instanceof modules.ExportError && /^[a-z0-9_]+$/.test(error.reason) ? error.reason : 'local_io';
    throw new CliError('export_refused', `Offline export refused (${reason}); no completed output is claimed.`, 8);
  } finally {
    process.removeListener('SIGINT', cancel);
    key?.fill(0);
  }
}
