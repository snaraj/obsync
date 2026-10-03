export class CliError extends Error {
  constructor(code, message, exit = 2, action = null) {
    super(message);
    this.code = code;
    this.exit = exit;
    this.action = action;
  }
}

export function refuse(condition, code, message, exit = 2) {
  if (!condition) throw new CliError(code, message, exit);
}

export function closed(value, keys, required = keys) {
  refuse(value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_input', 'Expected a JSON object.');
  refuse(Object.keys(value).every(key => keys.includes(key)) &&
    required.every(key => Object.hasOwn(value, key)), 'invalid_input',
  'The object has an unknown or missing field; inspect the operation schema.');
}

export async function readBounded(handle, limit) {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  refuse(length <= limit, 'input_limit', 'The selected file exceeds its byte budget.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
  catch { throw new CliError('invalid_input', 'The selected file is not valid UTF-8.'); }
}
