// ---------------------------------------------------------------------------
// Chunk stores: where a peer reads chunks from and writes verified chunks to.
// Every store has the same interface: read(i), write(i, data), toFile(), close().
// ---------------------------------------------------------------------------
import { chunkLength } from './manifest.js';

/** The sender's original file. Chunks are sliced straight from disk. */
export class SourceFileStore {
  kind = 'source';

  constructor(file, meta) {
    this.file = file;
    this.meta = meta;
  }

  read(index) {
    const start = index * this.meta.chunkSize;
    return this.file.slice(start, start + chunkLength(this.meta, index)).arrayBuffer();
  }

  async write() {
    throw new Error('The source file is read-only');
  }

  async toFile() {
    return this.file;
  }

  async close() {}
}

/** Keeps verified chunks in RAM, which limits it to files that fit in memory. */
export class MemoryChunkStore {
  kind = 'memory';

  constructor(meta) {
    this.meta = meta;
    this.chunks = new Map();
  }

  async read(index) {
    return this.chunks.get(index);
  }

  async write(index, data) {
    this.chunks.set(index, data);
  }

  async toFile() {
    const parts = [];
    for (let i = 0; i < this.meta.totalChunks; i += 1) parts.push(this.chunks.get(i));
    return new File(parts, this.meta.name, { type: this.meta.mimeType });
  }

  async close() {
    this.chunks.clear();
  }
}

// ------------------------------------------------------------------- OPFS

const OPFS_DIRECTORY = 'p2p-share';
/** Without OPFS, refuse files bigger than this rather than exhaust RAM. */
export const MEMORY_LIMIT = 500 * 1024 * 1024;

let worker = null;
let nextRequestId = 1;
const pendingRequests = new Map();

/** Call an operation in the OPFS worker (see opfs.worker.js). */
function callWorker(op, args, transfer = []) {
  if (!worker) {
    worker = new Worker(new URL('./opfs.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, result, error } }) => {
      const request = pendingRequests.get(id);
      pendingRequests.delete(id);
      if (error) request?.reject(new Error(error));
      else request?.resolve(result);
    };
    worker.onerror = (event) => {
      for (const request of pendingRequests.values()) request.reject(new Error(event.message || 'OPFS worker failed'));
      pendingRequests.clear();
    };
  }
  return new Promise((resolve, reject) => {
    const id = nextRequestId;
    nextRequestId += 1;
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

/**
 * Streams verified chunks straight into a file in the Origin Private File
 * System. Memory use stays flat no matter how large the file is; the final
 * download is a disk-backed File, not an in-memory Blob.
 */
export class OpfsChunkStore {
  kind = 'opfs';

  constructor(meta, name) {
    this.meta = meta;
    this.name = name;
    this.file = null; // disk-backed File once complete
  }

  open() {
    return callWorker('open', { name: this.name, size: this.meta.size });
  }

  write(index, data) {
    // `data` is transferred to the worker (no copy); the caller must not reuse it.
    return callWorker('write', { name: this.name, offset: index * this.meta.chunkSize, data }, [data]);
  }

  read(index) {
    const offset = index * this.meta.chunkSize;
    const length = chunkLength(this.meta, index);
    if (this.file) return this.file.slice(offset, offset + length).arrayBuffer();
    return callWorker('read', { name: this.name, offset, length });
  }

  flush() {
    return callWorker('flush', { name: this.name });
  }

  async toFile() {
    // Release the worker's exclusive handle, then read the file back as a
    // disk-backed File. Later reads (seeding other peers) use it too.
    await callWorker('close', { name: this.name });
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIRECTORY);
    const stored = await (await directory.getFileHandle(this.name)).getFile();
    this.file = new File([stored], this.meta.name, { type: this.meta.mimeType });
    return this.file;
  }

  async close() {
    if (!this.file) await callWorker('close', { name: this.name });
  }
}

let cleanedUp = false;

/** Delete partial files left behind by earlier visits (once per page load). */
async function removeOldParts(keepName) {
  if (cleanedUp) return;
  cleanedUp = true;
  const names = await callWorker('list');
  await Promise.all(
    names
      .filter((name) => name.endsWith('.part') && name !== keepName)
      .map((name) => callWorker('remove', { name })),
  );
}

async function freeStorageBytes() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return quota - usage;
  } catch {
    return Infinity;
  }
}

/**
 * Pick where a receiver keeps incoming chunks: OPFS on disk when the browser
 * supports it and there is room, otherwise RAM for files up to 500 MB.
 */
export async function createChunkStore(meta, { roomId }) {
  const free = await freeStorageBytes();

  if (free >= meta.size && navigator.storage?.getDirectory) {
    const store = new OpfsChunkStore(meta, `${roomId}-${meta.fileId}.part`);
    try {
      await removeOldParts(store.name);
      await store.open();
      return store;
    } catch (err) {
      console.warn('OPFS unavailable, falling back to memory:', err);
    }
  }

  if (meta.size <= MEMORY_LIMIT) return new MemoryChunkStore(meta);

  throw new Error(
    free < meta.size
      ? `Not enough free browser storage: this file needs ${Math.ceil(meta.size / 1048576)} MB. ` +
          'Free up disk space or leave private/incognito mode.'
      : "This browser can't stream downloads to disk (no OPFS support), so files over 500 MB " +
          "can't be received here. Try a recent Chrome, Edge, Firefox or Safari.",
  );
}
