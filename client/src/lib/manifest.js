import { CHUNK_SIZE } from './config.js';
import { sha256Hex } from './crypto.js';

const READ_BLOCK_CHUNKS = 64; // hash 8 MB of the file per disk read

/**
 * Hash every chunk of `file` up front. Peers verify every chunk against this
 * list, no matter which peer sent it, so a relaying peer can't corrupt the file.
 * `fileId` is the hash of all chunk hashes, so it also authenticates the list.
 */
export async function buildManifest(file, onProgress) {
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const hashes = new Array(totalChunks);

  for (let first = 0; first < totalChunks; first += READ_BLOCK_CHUNKS) {
    const start = first * CHUNK_SIZE;
    const block = new Uint8Array(
      await file.slice(start, start + READ_BLOCK_CHUNKS * CHUNK_SIZE).arrayBuffer(),
    );
    const last = Math.min(first + READ_BLOCK_CHUNKS, totalChunks);
    for (let i = first; i < last; i += 1) {
      const offset = (i - first) * CHUNK_SIZE;
      hashes[i] = await sha256Hex(block.subarray(offset, offset + CHUNK_SIZE));
    }
    onProgress?.(last / totalChunks);
  }

  return {
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    chunkSize: CHUNK_SIZE,
    totalChunks,
    fileId: await computeFileId(hashes),
    hashes,
  };
}

export async function computeFileId(hashes) {
  const digest = await sha256Hex(new TextEncoder().encode(hashes.join('')));
  return digest.slice(0, 32);
}

/** Byte length of chunk `index` (the last chunk is usually shorter). */
export function chunkLength(meta, index) {
  return Math.min(meta.chunkSize, meta.size - index * meta.chunkSize);
}
