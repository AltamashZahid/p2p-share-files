// Tunables shared by the swarm engine.

/** Plaintext bytes per chunk. The encrypted frame (+33 bytes) stays under the
 * 256 KiB SCTP message limit that Chrome advertises. */
export const CHUNK_SIZE = 128 * 1024;

/** Max chunks requested from a single peer at once (pipelining window). */
export const REQUEST_WINDOW = 16;

/** Re-request a chunk from someone else if it hasn't arrived by then. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** Hashes per manifest message (~100 KB of JSON). */
export const MANIFEST_BATCH = 1500;

/** Pause sending while this many bytes are queued in a data channel. */
export const HIGH_WATER_MARK = 4 * 1024 * 1024;
export const LOW_WATER_MARK = 1 * 1024 * 1024;

/** After this many bad chunks from one peer, stop using that peer. */
export const MAX_CORRUPT_CHUNKS = 3;

/** STUN is always on. Set VITE_TURN_URL (+ username/credential) to add a TURN
 * relay for networks where direct connections are blocked. */
export const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ...(import.meta.env.VITE_TURN_URL
      ? [
          {
            urls: import.meta.env.VITE_TURN_URL.split(','),
            username: import.meta.env.VITE_TURN_USERNAME,
            credential: import.meta.env.VITE_TURN_CREDENTIAL,
          },
        ]
      : []),
  ],
};

// In development the frontend and signaling server run on different ports.
// In production (single-service deploy) they share the same origin.
export const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ||
  (import.meta.env.DEV
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : window.location.origin);
