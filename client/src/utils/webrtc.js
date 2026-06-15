import { io } from 'socket.io-client';
import { ICE_SERVERS } from './transfer.js';

const DEFAULT_SIGNALING_URL =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001';
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL || DEFAULT_SIGNALING_URL;

export function createSignalingSocket() {
  return io(SIGNALING_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    timeout: 10000,
    reconnectionAttempts: 2,
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

export function applyRemoteIceCandidate(pc, candidate) {
  if (candidate) {
    return pc.addIceCandidate(new RTCIceCandidate(candidate));
  }
  return Promise.resolve();
}

export async function createOffer(pc) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return offer;
}

export async function createAnswer(pc, offer) {
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export async function acceptAnswer(pc, answer) {
  await pc.setRemoteDescription(new RTCSessionDescription(answer));
}

export function waitForDataChannel(pc, label = 'file-transfer') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Data channel open timeout')), 30000);

    pc.ondatachannel = (event) => {
      clearTimeout(timeout);
      resolve(event.channel);
    };

    const channel = pc.createDataChannel(label, { ordered: true });
    channel.onopen = () => {
      clearTimeout(timeout);
      resolve(channel);
    };
  });
}

export function openDataChannelAsReceiver(pc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Data channel open timeout')), 30000);

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
