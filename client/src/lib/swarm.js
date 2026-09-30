// ---------------------------------------------------------------------------
// SwarmSession: the peer-to-peer engine behind both the sender and receiver pages.
//
// Every peer in a room connects to every other peer (full mesh). Transfers are
// pull-based, like BitTorrent:
//   1. The sender publishes a manifest: file metadata plus the SHA-256 hash of
//      each chunk.
//   2. Every peer keeps a bitfield of the chunks it has verified and tells the
//      others about new ones ("have").
//   3. A downloader requests missing chunks from every connected peer that has
//      them, so a third peer downloads different parts from the sender and
//      from the second peer simultaneously.
//   4. Each chunk is decrypted, checked against the manifest hash, stored, and
//      immediately offered to the rest of the swarm.
// ---------------------------------------------------------------------------
import { Bitfield } from './bitfield.js';
import {
  MANIFEST_BATCH,
  MAX_CORRUPT_CHUNKS,
  REQUEST_TIMEOUT_MS,
  REQUEST_WINDOW,
} from './config.js';
import { sha256Hex } from './crypto.js';
import { RateMeter } from './format.js';
import { chunkLength, computeFileId } from './manifest.js';
import { PeerLink } from './peerLink.js';
import { decodeFrame, encodeChunk, encodeControl } from './protocol.js';
import { connectSignaling, randomId, request } from './signaling.js';
import { SourceFileStore, createChunkStore } from './stores.js';

const TICK_MS = 250;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class SwarmSession {
  /**
   * @param {object} options
   * @param {'host'|'guest'} options.role
   * @param {string} options.roomId
   * @param {string} options.peerId      this browser's id in the room
   * @param {CryptoKey} options.key      AES-GCM key from the link fragment
   * @param {File} [options.file]        host only: the file being shared
   * @param {object} [options.manifest]  host only: output of buildManifest()
   * @param {(snapshot: object) => void} options.onUpdate  UI state, ~4x per second
   * @param {(file: File) => void} [options.onComplete]    guest: verified file ready
   */
  constructor(options) {
    this.role = options.role;
    this.roomId = options.roomId;
    this.peerId = options.peerId;
    this.key = options.key;
    this.onUpdate = options.onUpdate;
    this.onComplete = options.onComplete;
    // Distinguishes this page load from a previous one with the same peer id.
    this.nonce = randomId(4);

    this.socket = null;
    this.signaling = 'connecting'; // 'connecting' | 'online' | 'offline'
    this.members = new Set(); // peer ids the signaling server says are in the room
    this.links = new Map(); // peerId -> PeerLink
    this.peers = new Map(); // peerId -> per-peer state (see peerState)
    this.hostPeerId = null;

    this.meta = null; // { name, size, mimeType, chunkSize, totalChunks, fileId }
    this.hashes = null; // SHA-256 (hex) of every chunk
    this.hashesReceived = 0;
    this.store = null;
    this.have = null; // Bitfield of chunks this peer has verified
    this.ready = false; // manifest verified and store open
    this.preparing = false;
    this.completed = false;

    this.inflight = new Map(); // chunk index -> { peerId, at }
    this.cursor = 0; // every chunk below this index is already verified
    this.pendingHaves = [];
    this.downloadMeter = new RateMeter();
    this.uploadMeter = new RateMeter();

    this.fatalError = '';
    this.destroyed = false;

    if (this.role === 'host') {
      const { hashes, ...meta } = options.manifest;
      this.meta = meta;
      this.hashes = hashes;
      this.hostPeerId = this.peerId;
      this.store = new SourceFileStore(options.file, meta);
      this.have = Bitfield.full(meta.totalChunks);
      this.ready = true;
      this.completed = true;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    const socket = connectSignaling();
    this.socket = socket;

    socket.on('connect', () => {
      this.signaling = 'online';
      this.register();
    });
    socket.on('disconnect', () => {
      this.signaling = 'offline';
    });
    socket.on('connect_error', () => {
      this.signaling = 'offline';
    });
    socket.on('peer-joined', ({ peerId, nonce }) => {
      this.members.add(peerId);
      this.onPeerJoined(peerId, nonce);
    });
    socket.on('peer-left', ({ peerId }) => {
      this.members.delete(peerId);
    });
    socket.on('signal', ({ from, data }) => this.onSignal(from, data));

    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.socket?.disconnect();
    this.store?.close().catch(() => {});
  }

  /** Unrecoverable problem: stop networking but keep the UI state. */
  fail(message) {
    this.fatalError = message;
    this.emit();
    this.destroy();
  }

  // ---------------------------------------------------------------- signaling

  async register() {
    const event = this.role === 'host' ? 'create-room' : 'join-room';
    let response;
    try {
      response = await request(this.socket, event, {
        roomId: this.roomId,
        peerId: this.peerId,
        nonce: this.nonce,
      });
    } catch {
      return; // no answer: socket.io will reconnect and we'll register again
    }
    if (this.destroyed) return;
    if (!response?.ok) {
      this.fail(response?.error || 'Could not join the room.');
      return;
    }

    this.hostPeerId = response.hostPeerId;
    this.members = new Set(response.peers);
    for (const peerId of response.peers) this.ensureLink(peerId);
    this.emit();
  }

  onPeerJoined(peerId, nonce) {
    const link = this.links.get(peerId);
    // Same page load re-registering after a signaling blip: our direct link
    // to it is still fine, keep it.
    if (link?.isOpen && link.remoteNonce === nonce) return;
    // Otherwise it's a new page load (e.g. a refresh): drop the old link.
    if (link) this.dropLink(peerId);
    this.ensureLink(peerId);
  }

  /** Make sure we have (or are getting) a direct connection to `remoteId`. */
  ensureLink(remoteId) {
    if (this.destroyed || !this.members.has(remoteId)) return;
    const existing = this.links.get(remoteId);
    if (existing && !existing.closed) return;
    const peer = this.peerState(remoteId);
    if (peer.state === 'banned' || peer.state === 'bad-key') return;

    // The lower peer id makes the offer; the other side waits for it.
    if (this.peerId < remoteId) {
      const link = this.createLink(remoteId, true);
      link.start().catch(() => link.fail('offer-failed'));
    }
  }

  onSignal(from, data) {
    if (this.destroyed || !data) return;
    let link = this.links.get(from);
    // An offer always means the remote side is (re)starting the connection.
    if (data.kind === 'description' && data.description?.type === 'offer') {
      link = this.createLink(from, false);
    }
    if (!link || link.closed) return;
    link.handleSignal(data).catch(() => link.fail('signal-error'));
  }

  createLink(remoteId, initiator) {
    this.dropLink(remoteId);
    const link = new PeerLink({
      remoteId,
      initiator,
      sendSignal: (data) => this.socket?.emit('signal', { to: remoteId, data }),
      onOpen: (l) => this.onLinkOpen(l),
      onMessage: (l, data) => this.onFrame(l, data),
      onClose: (l, reason) => this.onLinkClose(l, reason),
    });
    this.links.set(remoteId, link);

    const peer = this.peerState(remoteId);
    peer.state = 'connecting';
    peer.have = null;
    peer.pendingBitfield = null;
    peer.earlyHaves = [];
    peer.hasMeta = false;
    peer.uploadQueue = [];
    return link;
  }

  /** Quietly close the link to a peer and forget its outstanding requests. */
  dropLink(remoteId) {
    const link = this.links.get(remoteId);
    if (link) {
      this.links.delete(remoteId);
      link.close();
    }
    this.releaseRequests(remoteId);
  }

  // ------------------------------------------------------------- peer links

  peerState(peerId) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = {
        id: peerId,
        isHost: peerId === this.hostPeerId,
        state: 'connecting',
        have: null, // their Bitfield, once we know the file
        pendingBitfield: null, // their bitfield, received before we knew the file
        earlyHaves: [], // their "have"s, received before we knew the file
        hasMeta: false, // do they already know the file?
        inflight: new Set(), // chunks we requested from them
        uploadQueue: [], // chunks they requested from us
        uploading: false,
        downloaded: 0, // bytes we got from them
        uploaded: 0, // bytes we sent to them
        corrupt: 0,
      };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  onLinkOpen(link) {
    const peer = this.peerState(link.remoteId);
    peer.state = 'connected';
    this.sendControl(link, {
      t: 'hello',
      peerId: this.peerId,
      nonce: this.nonce,
      isHost: this.role === 'host',
      fileId: this.ready ? this.meta.fileId : null,
      have: this.ready ? this.have.toBase64() : null,
    });
    this.emit();
  }

  onLinkClose(link) {
    if (this.links.get(link.remoteId) !== link) return; // already replaced
    this.links.delete(link.remoteId);
    const peer = this.peers.get(link.remoteId);
    if (peer && peer.state !== 'banned' && peer.state !== 'bad-key') {
      peer.state = 'disconnected';
    }
    this.releaseRequests(link.remoteId);
    this.schedule();
    this.emit();
  }

  /**
   * Send a control message. Messages to one peer go out strictly in order,
   * because encryption is async and meta must arrive before the manifest.
   */
  sendControl(link, message) {
    link.outbox = (link.outbox ?? Promise.resolve())
      .then(async () => {
        if (!link.isOpen) return;
        await link.send(await encodeControl(this.key, message));
      })
      .catch(() => {});
    return link.outbox;
  }

  async onFrame(link, data) {
    if (this.destroyed || !(data instanceof ArrayBuffer)) return;
    const peer = this.peerState(link.remoteId);

    let frame;
    try {
      frame = await decodeFrame(this.key, data);
    } catch {
      // Wrong key (or tampered data). Ignore this peer; if we have nothing
      // yet, the link's key is the problem.
      peer.state = 'bad-key';
      this.dropLink(link.remoteId);
      if (!this.ready) {
        this.fail('Could not decrypt data from the sender. The link is missing or has a wrong #key.');
      }
      return;
    }

    if (frame.type === 'chunk') await this.onChunk(link, peer, frame.index, frame.data);
    else await this.onControl(link, peer, frame.message);
  }

  async onControl(link, peer, message) {
    switch (message?.t) {
      case 'hello':
        link.remoteNonce = message.nonce;
        peer.isHost = Boolean(message.isHost);
        if (peer.isHost) this.hostPeerId = peer.id;
        peer.hasMeta = Boolean(message.fileId);
        this.acceptBitfield(peer, message.fileId, message.have);
        if (this.ready && !peer.hasMeta) await this.sendMetadata(link, peer);
        this.schedule();
        break;
      case 'meta':
        this.onMeta(message);
        break;
      case 'manifest':
        await this.onManifestPart(message);
        break;
      case 'bitfield':
        peer.hasMeta = true;
        this.acceptBitfield(peer, message.fileId, message.have);
        this.schedule();
        break;
      case 'have':
        for (const index of message.indices ?? []) {
          if (peer.have) peer.have.set(index);
          else peer.earlyHaves.push(index);
        }
        this.schedule();
        break;
      case 'request':
        this.enqueueUploads(peer, message.indices ?? []);
        break;
      default:
        break;
    }
  }

  acceptBitfield(peer, fileId, haveText) {
    if (!this.ready) {
      peer.pendingBitfield = fileId && haveText ? { fileId, have: haveText } : null;
      return;
    }
    if (fileId && haveText && fileId === this.meta.fileId) {
      try {
        peer.have = Bitfield.fromBase64(this.meta.totalChunks, haveText);
        return;
      } catch {
        /* malformed: treat as empty */
      }
    }
    peer.have = new Bitfield(this.meta.totalChunks);
  }

  // ------------------------------------------------------------ file manifest

  async sendMetadata(link, peer) {
    peer.hasMeta = true;
    this.sendControl(link, { t: 'meta', ...this.meta });
    for (let start = 0; start < this.meta.totalChunks; start += MANIFEST_BATCH) {
      this.sendControl(link, {
        t: 'manifest',
        start,
        hashes: this.hashes.slice(start, start + MANIFEST_BATCH),
      });
    }
  }

  onMeta(message) {
    if (this.meta) return; // another peer already told us
    const { name, size, mimeType, chunkSize, totalChunks, fileId } = message;
    const valid =
      typeof name === 'string' &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      Number.isSafeInteger(chunkSize) &&
      chunkSize > 0 &&
      totalChunks === Math.max(1, Math.ceil(size / chunkSize)) &&
      typeof fileId === 'string';
    if (!valid) return;

    this.meta = { name, size, mimeType: mimeType || 'application/octet-stream', chunkSize, totalChunks, fileId };
    this.hashes = new Array(totalChunks);
    this.hashesReceived = 0;
    this.emit();
  }

  async onManifestPart({ start, hashes }) {
    if (!this.meta || this.ready || this.preparing || !Array.isArray(hashes)) return;
    hashes.forEach((hash, offset) => {
      const index = start + offset;
      if (index < this.meta.totalChunks && !this.hashes[index] && HASH_PATTERN.test(hash)) {
        this.hashes[index] = hash;
        this.hashesReceived += 1;
      }
    });
    if (this.hashesReceived < this.meta.totalChunks) return;

    this.preparing = true;
    if ((await computeFileId(this.hashes)) !== this.meta.fileId) {
      this.fail('The file manifest failed verification.');
      return;
    }
    try {
      this.store = await createChunkStore(this.meta, { roomId: this.roomId });
    } catch (err) {
      this.fail(err.message);
      return;
    }
    if (this.destroyed) return;
    this.onReady();
  }

  /** Manifest verified and storage open: start downloading. */
  onReady() {
    this.have = new Bitfield(this.meta.totalChunks);
    this.ready = true;
    this.preparing = false;

    for (const peer of this.peers.values()) {
      const pending = peer.pendingBitfield;
      peer.pendingBitfield = null;
      this.acceptBitfield(peer, pending?.fileId, pending?.have);
      for (const index of peer.earlyHaves) peer.have.set(index);
      peer.earlyHaves = [];
    }

    // Tell everyone what we have, and pass the manifest on to anyone missing it.
    for (const link of this.links.values()) {
      if (!link.isOpen) continue;
      const peer = this.peerState(link.remoteId);
      this.sendControl(link, { t: 'bitfield', fileId: this.meta.fileId, have: this.have.toBase64() });
      if (!peer.hasMeta) this.sendMetadata(link, peer);
    }

    this.schedule();
    this.emit();
  }

  // ---------------------------------------------------------------- download

  /** Ask connected peers for chunks we still need, spreading requests out. */
  schedule() {
    if (!this.ready || this.completed || this.destroyed) return;
    const total = this.meta.totalChunks;
    while (this.cursor < total && this.have.has(this.cursor)) this.cursor += 1;

    for (const peer of this.peers.values()) {
      const link = this.links.get(peer.id);
      if (!link?.isOpen || !peer.have || peer.have.count === 0) continue;

      const room = REQUEST_WINDOW - peer.inflight.size;
      if (room <= 0) continue;

      const picked = [];
      for (let i = this.cursor; i < total && picked.length < room; i += 1) {
        if (!this.have.has(i) && !this.inflight.has(i) && peer.have.has(i)) picked.push(i);
      }
      if (picked.length === 0) continue;

      const now = Date.now();
      for (const index of picked) {
        this.inflight.set(index, { peerId: peer.id, at: now });
        peer.inflight.add(index);
      }
      this.sendControl(link, { t: 'request', indices: picked });
    }
  }

  /** Forget requests sent to a peer so another peer can serve them. */
  releaseRequests(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    for (const index of peer.inflight) {
      if (this.inflight.get(index)?.peerId === peerId) this.inflight.delete(index);
    }
    peer.inflight.clear();
    peer.uploadQueue = [];
  }

  async onChunk(link, peer, index, data) {
    peer.inflight.delete(index);
    if (this.inflight.get(index)?.peerId === peer.id) this.inflight.delete(index);
    if (!this.ready || this.completed || index >= this.meta.totalChunks || this.have.has(index)) return;

    // Integrity: the chunk must match the sender's manifest, whoever relayed it.
    if ((await sha256Hex(data)) !== this.hashes[index]) {
      peer.corrupt += 1;
      if (peer.corrupt >= MAX_CORRUPT_CHUNKS) {
        peer.state = 'banned';
        this.dropLink(peer.id);
      }
      return; // not marked as inflight any more, so it will be requested again
    }

    const length = data.byteLength;
    await this.store.write(index, data);
    if (this.destroyed || !this.have.set(index)) return;

    peer.downloaded += length;
    this.downloadMeter.add(length);
    this.pendingHaves.push(index);

    if (this.have.complete) await this.finish();
    else if (peer.inflight.size <= REQUEST_WINDOW / 2) this.schedule();
  }

  async finish() {
    this.completed = true;
    this.flushHaves();
    const file = await this.store.toFile();
    if (this.destroyed) return;
    this.onComplete?.(file);
    this.emit();
  }

  // ------------------------------------------------------------------ upload

  enqueueUploads(peer, indices) {
    if (!this.ready) return;
    for (const index of indices) {
      if (Number.isInteger(index) && this.have.has(index)) peer.uploadQueue.push(index);
    }
    if (!peer.uploading) this.runUploads(peer);
  }

  async runUploads(peer) {
    peer.uploading = true;
    try {
      while (peer.uploadQueue.length && !this.destroyed) {
        const link = this.links.get(peer.id);
        if (!link?.isOpen) break;
        const index = peer.uploadQueue.shift();
        const data = await this.store.read(index);
        await link.send(await encodeChunk(this.key, index, data));
        peer.uploaded += data.byteLength;
        this.uploadMeter.add(data.byteLength);
      }
    } catch {
      // The link closed mid-upload; the downloader will re-request elsewhere.
    } finally {
      peer.uploading = false;
    }
  }

  // ------------------------------------------------------------ housekeeping

  /** Announce newly verified chunks to every peer, batched. */
  flushHaves() {
    if (this.pendingHaves.length === 0) return;
    const indices = this.pendingHaves.splice(0);
    for (const link of this.links.values()) {
      if (link.isOpen) this.sendControl(link, { t: 'have', indices });
    }
  }

  tick() {
    if (this.destroyed) return;
    if (this.ready && !this.completed) {
      const now = Date.now();
      for (const [index, req] of this.inflight) {
        if (now - req.at > REQUEST_TIMEOUT_MS) {
          this.inflight.delete(index);
          this.peers.get(req.peerId)?.inflight.delete(index);
        }
      }
      this.schedule();
    }
    this.flushHaves();
    this.emit();
  }

  bytesVerified() {
    if (!this.meta || !this.have) return 0;
    const last = this.meta.totalChunks - 1;
    let bytes = this.have.count * this.meta.chunkSize;
    if (this.have.has(last)) bytes -= this.meta.chunkSize - chunkLength(this.meta, last);
    return bytes;
  }

  /** Overall status + a human-readable explanation for the UI. */
  describe(openPeers) {
    if (this.fatalError) return { status: 'error', message: this.fatalError };

    const offline = this.signaling !== 'online';
    const signalNote = offline ? ' (signaling server unreachable, retrying…)' : '';

    if (this.role === 'host') {
      if (openPeers === 0) {
        return {
          status: offline ? 'connecting' : 'waiting',
          message: offline ? 'Connecting to the signaling server…' : 'Waiting for peers to open the link…',
        };
      }
      return {
        status: 'seeding',
        message: `Sharing with ${openPeers} peer${openPeers === 1 ? '' : 's'}${signalNote}`,
      };
    }

    if (this.completed) {
      return {
        status: 'complete',
        message: 'All chunks verified ✓ Your download has started. Keep this tab open to help other peers.',
      };
    }
    if (!this.ready) {
      if (openPeers === 0) {
        return { status: 'connecting', message: `Connecting to peers…${signalNote}` };
      }
      return {
        status: 'connected',
        message: this.meta ? `Receiving file list for ${this.meta.name}…` : 'Connected. Waiting for file info…',
      };
    }

    const canProgress = [...this.peers.values()].some((peer) => {
      if (!this.links.get(peer.id)?.isOpen || !peer.have) return false;
      for (let i = this.cursor; i < this.meta.totalChunks; i += 1) {
        if (!this.have.has(i) && peer.have.has(i)) return true;
      }
      return false;
    });
    if (canProgress) return { status: 'transferring', message: `Downloading ${this.meta.name}${signalNote}` };
    return {
      status: 'stalled',
      message: 'No connected peer has the remaining chunks. Waiting for the sender to come back…',
    };
  }

  snapshot() {
    const total = this.meta?.totalChunks ?? 0;
    const peers = [...this.peers.values()].map((peer) => {
      const open = Boolean(this.links.get(peer.id)?.isOpen);
      let state = peer.state;
      if (!open && state === 'connected') state = 'disconnected';
      if (!open && !this.members.has(peer.id) && state !== 'banned' && state !== 'bad-key') state = 'left';
      return {
        id: peer.id,
        isHost: peer.isHost,
        state,
        progress: peer.have && total ? peer.have.count / total : peer.isHost ? 1 : 0,
        downloaded: peer.downloaded,
        uploaded: peer.uploaded,
      };
    });
    const openPeers = peers.filter((peer) => peer.state === 'connected').length;

    return {
      role: this.role,
      roomId: this.roomId,
      peerId: this.peerId,
      ...this.describe(openPeers),
      file: this.meta
        ? { name: this.meta.name, size: this.meta.size, totalChunks: total, chunkSize: this.meta.chunkSize }
        : null,
      verifiedChunks: this.have?.count ?? 0,
      totalChunks: total,
      progress: total && this.have ? this.have.count / total : 0,
      bytesVerified: this.bytesVerified(),
      downloadRate: this.downloadMeter.rate(),
      uploadRate: this.uploadMeter.rate(),
      uploadedTotal: this.uploadMeter.total,
      storage: this.store?.kind ?? null,
      peers,
    };
  }

  emit() {
    this.onUpdate?.(this.snapshot());
  }
}
