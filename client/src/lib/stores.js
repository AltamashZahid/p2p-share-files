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

export async function createChunkStore(meta) {
  return new MemoryChunkStore(meta);
}
