/** Owner-approved fixed desktop bridge; public SecretStorage receives ciphertext only. */
import { base64, unbase64 } from "./crypto";
import { SecretStore, StateStorageError } from "./state";

declare const require: (id: string) => unknown;
export const DESKTOP_CUSTODY_PREFIX = "obsync-native-custody-v1:";
// Local credential-envelope budget only; this does not limit note or vault sizes.
const LIMIT = 16 << 20;
const PROTECTED = ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"];
const UNAVAILABLE = "obsync cannot use operating-system encryption for this vault's sync credentials. Sync is stopped before enrollment or credential storage. Reload Obsidian after its operating-system encryption service is available; your local notes are unchanged.";
type Native = {
  isEncryptionAvailable(): unknown;
  encryptString(value: string): unknown;
  decryptString(value: unknown): unknown;
  getSelectedStorageBackend?(): unknown;
};

/** No remote import, IPC, setters or secret enumeration; absent capabilities refuse. */
export function desktopSecretStore(secrets: SecretStore, platform: string): SecretStore {
  if (!secrets || typeof secrets.getSecret !== "function" || typeof secrets.setSecret !== "function") return secrets;
  const admitted = (): Native => {
    try {
      const safe = (secrets as SecretStore & { adapter?: { safeStorage?: Native } }).adapter?.safeStorage;
      if (!["macos", "windows", "linux"].includes(platform) || !safe ||
        typeof safe.isEncryptionAvailable !== "function" || typeof safe.encryptString !== "function" ||
        typeof safe.decryptString !== "function" || safe.isEncryptionAvailable() !== true ||
        (platform === "linux" && (typeof safe.getSelectedStorageBackend !== "function" ||
          !PROTECTED.includes(safe.getSelectedStorageBackend() as string)))) throw new Error();
      return safe;
    } catch { throw new StateStorageError("desktop_custody_unavailable", UNAVAILABLE); }
  };
  const bytes = (stored: string): Uint8Array<ArrayBuffer> => {
    if (!stored.startsWith(DESKTOP_CUSTODY_PREFIX)) throw new StateStorageError("invalid_desktop_envelope");
    const text = stored.slice(DESKTOP_CUSTODY_PREFIX.length);
    if (!text || text.length > LIMIT * 2 || text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text) || text.slice(0, -2).includes("=")) throw new StateStorageError("invalid_desktop_envelope");
    let decoded: Uint8Array<ArrayBuffer>;
    try { decoded = unbase64(text); } catch { throw new StateStorageError("invalid_desktop_envelope"); }
    if (decoded.length > LIMIT || base64(decoded) !== text) throw new StateStorageError("invalid_desktop_envelope");
    return decoded;
  };
  return {
    getSecret(id) { admitted(); return secrets.getSecret(id); },
    setSecret(id, value) {
      admitted();
      if (value !== "") bytes(value);
      secrets.setSecret(id, value);
    },
    desktopCustody: {
      assertAvailable() { admitted(); },
      seal(value) {
        const safe = admitted();
        try {
          if (new TextEncoder().encode(value).length > LIMIT) throw new Error();
          const encrypted = safe.encryptString(value);
          if (!(encrypted instanceof Uint8Array) || encrypted.length === 0 || encrypted.length > LIMIT) throw new Error();
          return DESKTOP_CUSTODY_PREFIX + base64(new Uint8Array(encrypted));
        } catch { throw new StateStorageError("desktop_custody_encrypt_failed"); }
      },
      open(stored) {
        const safe = admitted(), decoded = bytes(stored);
        try {
          const { Buffer } = require("buffer") as { Buffer: { from(value: Uint8Array): unknown } };
          const plain = safe.decryptString(Buffer.from(decoded));
          if (typeof plain !== "string" || new TextEncoder().encode(plain).length > LIMIT) throw new Error();
          return plain;
        } catch { throw new StateStorageError("desktop_custody_decrypt_failed"); }
      },
    },
  };
}
