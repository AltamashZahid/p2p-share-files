import { fromBase64Url, toBase64Url } from './crypto.js';

/**
 * Compact record of which chunks a peer holds (1 bit per chunk), like
 * BitTorrent's bitfield. A 1 GB file (8192 chunks) needs only 1 KB.
 */
export class Bitfield {
  constructor(size, bytes) {
    this.size = size;
    this.bytes = bytes ?? new Uint8Array(Math.ceil(size / 8));
    this.count = 0;
    for (let i = 0; i < size; i += 1) if (this.has(i)) this.count += 1;
  }

  static full(size) {
    const field = new Bitfield(size);
    for (let i = 0; i < size; i += 1) field.set(i);
    return field;
  }

  static fromBase64(size, text) {
    const bytes = fromBase64Url(text);
    if (bytes.length !== Math.ceil(size / 8)) throw new Error('Bitfield size mismatch');
    return new Bitfield(size, bytes);
  }

  has(index) {
    return (this.bytes[index >> 3] & (1 << (index & 7))) !== 0;
  }

  /** Returns true if the bit was newly set. */
  set(index) {
    if (index < 0 || index >= this.size || this.has(index)) return false;
    this.bytes[index >> 3] |= 1 << (index & 7);
    this.count += 1;
    return true;
  }

  get complete() {
    return this.count === this.size;
  }

  toBase64() {
    return toBase64Url(this.bytes);
  }
}
