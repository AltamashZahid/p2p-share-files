import { HIGH_WATER_MARK, ICE_CONFIG, LOW_WATER_MARK } from './config.js';

const CONNECT_TIMEOUT_MS = 20_000;
const DISCONNECT_GRACE_MS = 5_000;

/**
 * One WebRTC connection (and one reliable, ordered data channel) to one
 * remote peer. The swarm holds one PeerLink per peer in the room.
 *
 * Exactly one side of each pair is the "initiator": it creates the data
 * channel and the SDP offer. The swarm picks it deterministically (lower peer
 * id), so two peers never send each other offers at the same time.
 */
export class PeerLink {
  constructor({ remoteId, initiator, sendSignal, onOpen, onMessage, onClose }) {
    this.remoteId = remoteId;
    this.initiator = initiator;
    this.sendSignal = sendSignal;
    this.handlers = { onOpen, onMessage, onClose };
    this.pendingCandidates = [];
    this.channel = null;
    this.closed = false;
    // Incoming frames are handled strictly one after another, in order.
    this.inbox = Promise.resolve();

    this.pc = new RTCPeerConnection(ICE_CONFIG);
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal({ kind: 'ice', candidate: candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => this.onConnectionStateChange();

    if (initiator) {
      this.attachChannel(this.pc.createDataChannel('swarm', { ordered: true }));
    } else {
      this.pc.ondatachannel = ({ channel }) => this.attachChannel(channel);
    }

    // A link that never opens (e.g. the other side vanished mid-handshake)
    // counts as failed, so the swarm can retry it.
    this.connectTimer = setTimeout(() => {
      if (!this.isOpen) this.fail('timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  get isOpen() {
    return !this.closed && this.channel?.readyState === 'open';
  }

  /** Initiator only: create and send the SDP offer. */
  async start() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.sendSignal({ kind: 'description', description: this.pc.localDescription.toJSON() });
  }

  /** Apply an SDP description or ICE candidate relayed by the signaling server. */
  async handleSignal(data) {
    if (this.closed) return;

    if (data.kind === 'description') {
      await this.pc.setRemoteDescription(data.description);
      // Candidates that arrived before the description can be applied now.
      for (const candidate of this.pendingCandidates.splice(0)) {
        await this.pc.addIceCandidate(candidate).catch(() => {});
      }
      if (data.description.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.sendSignal({ kind: 'description', description: this.pc.localDescription.toJSON() });
      }
    } else if (data.kind === 'ice') {
      if (this.pc.remoteDescription) {
        await this.pc.addIceCandidate(data.candidate).catch(() => {});
      } else {
        this.pendingCandidates.push(data.candidate);
      }
    }
  }

  attachChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    this.channel = channel;

    channel.onopen = () => {
      clearTimeout(this.connectTimer);
      this.handlers.onOpen(this);
    };
    channel.onmessage = ({ data }) => {
      this.inbox = this.inbox
        .then(() => (this.closed ? undefined : this.handlers.onMessage(this, data)))
        .catch((err) => console.error('Failed to handle frame', err));
    };
    channel.onclose = () => this.fail('channel-closed');
  }

  onConnectionStateChange() {
    const state = this.pc.connectionState;
    if (state === 'failed' || state === 'closed') {
      this.fail(state);
    } else if (state === 'disconnected') {
      // Often transient (Wi-Fi hiccup): give ICE a moment to recover.
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => {
        if (this.pc.connectionState === 'disconnected') this.fail('disconnected');
      }, DISCONNECT_GRACE_MS);
    }
  }

  /** Send a frame, waiting first if too much data is already queued. */
  async send(frame) {
    const channel = this.channel;
    while (channel && channel.readyState === 'open' && channel.bufferedAmount > HIGH_WATER_MARK) {
      await new Promise((resolve) => {
        const done = () => {
          channel.removeEventListener('bufferedamountlow', done);
          channel.removeEventListener('close', done);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', done);
        channel.addEventListener('close', done);
      });
    }
    if (!this.isOpen) throw new Error('Peer connection is closed');
    channel.send(frame);
  }

  /** Close because something went wrong; tells the swarm. */
  fail(reason) {
    if (this.closed) return;
    this.close();
    this.handlers.onClose(this, reason);
  }

  /** Close quietly (we are replacing or tearing down this link). */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
