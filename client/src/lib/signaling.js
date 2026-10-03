import { io } from 'socket.io-client';
import { SIGNALING_URL } from './config.js';

/** Socket.io connection to the signaling server. Reconnects automatically. */
export function connectSignaling() {
  return io(SIGNALING_URL, {
    transports: ['websocket', 'polling'],
    timeout: 10_000,
    reconnectionDelayMax: 5_000,
  });
}

/** `socket.emit` with an acknowledgement, as a promise with a timeout. */
export function request(socket, event, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (err, response) => {
      if (err) reject(new Error('Signaling server did not respond.'));
      else resolve(response);
    });
  });
}

/** Random URL-safe id (hex). 4 bytes for rooms, 8 for peers. */
export function randomId(bytes = 4) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
