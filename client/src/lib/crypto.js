// ---------------------------------------------------------------------------
// Zero-knowledge encryption helpers (Web Crypto API, AES-256-GCM).
//
// The sender's browser generates the key, and the key only ever travels inside
// the URL fragment (`#key=...`). Browsers never send the fragment to a server,
// so the signaling server cannot decrypt anything even if it wanted to.
// ---------------------------------------------------------------------------

const KEY_ALGORITHM = { name: 'AES-GCM', length: 256 };
const IV_BYTES = 12; // 96-bit IV, the size recommended for AES-GCM

export function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function generateKey() {
  return crypto.subtle.generateKey(KEY_ALGORITHM, true, ['encrypt', 'decrypt']);
}

/** Export a key as a URL-safe string for the `#key=` fragment. */
export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return toBase64Url(new Uint8Array(raw));
}

/** Import the key string taken from the `#key=` fragment. Throws if malformed. */
export async function importKey(keyString) {
  const raw = fromBase64Url(keyString);
  if (raw.length !== 32) throw new Error('Invalid decryption key in link.');
  return crypto.subtle.importKey('raw', raw, KEY_ALGORITHM, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt `data` with a fresh random IV. Output layout: [iv (12 bytes)][ciphertext + tag].
 * `aad` (additional authenticated data) is not encrypted but is authenticated, so a
 * ciphertext cannot be replayed in a different context (e.g. under another chunk index).
 */
export async function encrypt(key, data, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ciphertext = await crypto.subtle.encrypt(params, key, data);
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return out.buffer;
}

/** Reverse of `encrypt`. Rejects if the key is wrong or the data was tampered with. */
export function decrypt(key, payload, aad) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const iv = bytes.subarray(0, IV_BYTES);
  const params = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  return crypto.subtle.decrypt(params, key, bytes.subarray(IV_BYTES));
}

export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read `?room=` from the query string and `#key=` from the fragment. */
export function readShareLink(location = window.location) {
  const roomId = new URLSearchParams(location.search).get('room');
  const keyString = new URLSearchParams(location.hash.slice(1)).get('key');
  return { roomId, keyString };
}

/** Invite link: the room id goes in the query, the key stays in the fragment. */
export function buildShareUrl(roomId, keyString) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?room=${encodeURIComponent(roomId)}#key=${keyString}`;
}
