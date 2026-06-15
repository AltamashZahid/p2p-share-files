import { io } from 'socket.io-client';
import { ICE_SERVERS } from './transfer.js';

// In development the frontend and signaling server run on different ports.
// In production (single-service deploy) they share the same origin.
const DEFAULT_SIGNALING_URL = import.meta.env.DEV
  ? `${window.location.protocol}//${window.location.hostname}:3001`
  : window.location.origin;

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL || DEFAULT_SIGNALING_URL;

export function createSignalingSocket() {
  return io(SIGNALING_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    timeout: 10000,
    reconnectionAttempts: 3,
  });
}

export function createPeerConnection() {
  return new RTCPeerConnection(ICE_SERVERS);
}

export function attachIceCandidateRelay(pc, socket, roomId) {
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', {
        roomId,
        candidate: event.candidate,
      });
    }
  };
}

/**
 * Apply a remote ICE candidate. If the remote description has not been set yet,
 * the candidate is buffered and will be flushed automatically once
 * setRemoteDescription completes (via createAnswer / acceptAnswer).
 */
export function applyRemoteIceCandidate(pc, candidate) {
  if (!candidate) return Promise.resolve();

  if (!pc.remoteDescription) {
    if (!pc._bufferedIceCandidates) {
      pc._bufferedIceCandidates = [];
    }
    pc._bufferedIceCandidates.push(candidate);
    return Promise.resolve();
  }

  return pc.addIceCandidate(new RTCIceCandidate(candidate));
}

/**
 * Flush any ICE candidates that arrived before the remote description was set.
 * Called internally after setRemoteDescription in createAnswer / acceptAnswer.
 */
function flushBufferedIceCandidates(pc) {
  const buffered = pc._bufferedIceCandidates;
  if (buffered && buffered.length > 0) {
    pc._bufferedIceCandidates = [];
    for (const candidate of buffered) {
      pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {
        // Best-effort: late candidates may fail harmlessly.
      });
    }
  }
}

export async function createOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return offer;
}

export async function createAnswer(pc, offer) {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  flushBufferedIceCandidates(pc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export async function acceptAnswer(pc, answer) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
  flushBufferedIceCandidates(pc);
}

/**
 * Sender side: create a data channel and resolve when it opens.
 */
export function waitForDataChannel(pc, label = 'file-transfer') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Data channel open timeout')),
      30000,
    );

    const channel = pc.createDataChannel(label, { ordered: true });

    channel.onopen = () => {
      clearTimeout(timeout);
      resolve(channel);
    };

    channel.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Data channel error during setup'));
    };
  });
}

/**
 * Receiver side: wait for the remote peer to open a data channel.
 */
export function openDataChannelAsReceiver(pc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Data channel open timeout')),
      30000,
    );

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.readyState === 'open') {
        clearTimeout(timeout);
        resolve(channel);
        return;
      }
      channel.onopen = () => {
        clearTimeout(timeout);
        resolve(channel);
      };
    };
  });
}
