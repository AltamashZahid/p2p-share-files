// ---------------------------------------------------------------------------
// Wire format for the swarm data channels. Every frame is encrypted:
//
//   control frame: [0x01][iv + AES-GCM(JSON message)]          aad = "control"
//   chunk frame:   [0x02][index u32][iv + AES-GCM(chunk bytes)] aad = index
//
// Control messages (JSON, `t` = type):
//   hello     { peerId, isHost, fileId, have }  first message on every link
//   meta      { name, size, mimeType, chunkSize, totalChunks, fileId }
//   manifest  { start, hashes[] }       SHA-256 of each plaintext chunk
//   bitfield  { fileId, have }          full list of verified chunks
//   have      { indices[] }             newly verified chunks (batched)
//   request   { indices[] }             "please send me these chunks"
// ---------------------------------------------------------------------------
import { decrypt, encrypt } from './crypto.js';

const FRAME_CONTROL = 1;
const FRAME_CHUNK = 2;
const CONTROL_AAD = new TextEncoder().encode('control');

function concat(header, body) {
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(body), header.length);
  return out.buffer;
}

export async function encodeControl(key, message) {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const body = await encrypt(key, json, CONTROL_AAD);
  return concat(Uint8Array.of(FRAME_CONTROL), body);
}

export async function encodeChunk(key, index, data) {
  const header = new Uint8Array(5);
  header[0] = FRAME_CHUNK;
  new DataView(header.buffer).setUint32(1, index);
  const body = await encrypt(key, data, header.subarray(1));
  return concat(header, body);
}

/**
 * Decrypt a frame. Resolves to { type: 'control', message } or
 * { type: 'chunk', index, data }. Rejects if the key is wrong or the frame
 * was tampered with.
 */
export async function decodeFrame(key, buffer) {
  const bytes = new Uint8Array(buffer);

  if (bytes[0] === FRAME_CONTROL) {
    const plain = await decrypt(key, bytes.subarray(1), CONTROL_AAD);
    return { type: 'control', message: JSON.parse(new TextDecoder().decode(plain)) };
  }

  if (bytes[0] === FRAME_CHUNK) {
    const indexBytes = bytes.subarray(1, 5);
    const index = new DataView(buffer, 1, 4).getUint32(0);
    const data = await decrypt(key, bytes.subarray(5), indexBytes);
    return { type: 'chunk', index, data };
  }

  throw new Error(`Unknown frame type ${bytes[0]}`);
}
