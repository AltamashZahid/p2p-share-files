import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const CLIENT_ORIGINS = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : true;

// A room is a small full mesh: every peer holds a WebRTC connection to every
// other peer, so the cost grows with n². Eight is plenty for a swarm demo.
const MAX_PEERS_PER_ROOM = 8;
const ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * roomId -> { hostPeerId, peers: Map<peerId, socketId> }
 *
 * The server only ever sees opaque room and peer ids. File names, sizes,
 * encryption keys and file data travel exclusively over encrypted WebRTC
 * data channels between browsers.
 * @type {Map<string, { hostPeerId: string, peers: Map<string, string> }>}
 */
const rooms = new Map();

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'p2p-web-share-signaling', rooms: rooms.size });
});

// ---------------------------------------------------------------------------
// Serve the frontend production build when it exists (e.g. on Render).
// In development the frontend is served by Vite, so this is a no-op.
// ---------------------------------------------------------------------------
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
const indexHtmlPath = path.join(clientDistPath, 'index.html');

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get('*', (_req, res) => {
    res.sendFile(indexHtmlPath);
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGINS,
    methods: ['GET', 'POST'],
  },
});

const isValidId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

io.on('connection', (socket) => {
  /** The room and peer identity this socket registered as. */
  let session = null;

  const ack = (callback, payload) => {
    if (typeof callback === 'function') callback(payload);
  };

  /**
   * Put this socket in the room under `peerId` and tell the other peers.
   * `nonce` identifies the page load, so peers can tell a refresh (new nonce)
   * from a signaling reconnect of the same page (same nonce).
   */
  function attach(roomId, peerId, nonce) {
    const room = rooms.get(roomId);
    const previousSocketId = room.peers.get(peerId);

    // Same peer id coming back on a new socket: drop the stale one.
    if (previousSocketId && previousSocketId !== socket.id) {
      io.sockets.sockets.get(previousSocketId)?.disconnect(true);
    }

    room.peers.set(peerId, socket.id);
    session = { roomId, peerId };
    socket.join(roomId);
    socket.to(roomId).emit('peer-joined', { peerId, nonce });
  }

  socket.on('create-room', (payload, callback) => {
    const { roomId, peerId, nonce } = payload ?? {};
    if (!isValidId(roomId) || !isValidId(peerId) || !isValidId(nonce)) {
      ack(callback, { ok: false, error: 'Invalid room or peer id.' });
      return;
    }
    if (rooms.has(roomId)) {
      ack(callback, { ok: false, error: 'Room already exists.' });
      return;
    }

    rooms.set(roomId, { hostPeerId: peerId, peers: new Map() });
    attach(roomId, peerId, nonce);
    ack(callback, { ok: true, roomId, hostPeerId: peerId, peers: [] });
  });

  socket.on('join-room', (payload, callback) => {
    const { roomId, peerId, nonce } = payload ?? {};
    if (!isValidId(roomId) || !isValidId(peerId) || !isValidId(nonce)) {
      ack(callback, { ok: false, error: 'Invalid room or peer id.' });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      ack(callback, { ok: false, error: 'Room not found or expired.' });
      return;
    }
    if (!room.peers.has(peerId) && room.peers.size >= MAX_PEERS_PER_ROOM) {
      ack(callback, { ok: false, error: `Room is full (max ${MAX_PEERS_PER_ROOM} peers).` });
      return;
    }

    const existingPeers = [...room.peers.keys()].filter((id) => id !== peerId);
    attach(roomId, peerId, nonce);
    ack(callback, { ok: true, roomId, hostPeerId: room.hostPeerId, peers: existingPeers });
  });

  // Relay an opaque WebRTC signal (SDP offer/answer or ICE candidate) to one
  // specific peer in the same room.
  socket.on('signal', (payload) => {
    if (!session) return;
    const { to, data } = payload ?? {};
    const targetSocketId = rooms.get(session.roomId)?.peers.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('signal', { from: session.peerId, data });
    }
  });

  socket.on('disconnect', () => {
    if (!session) return;
    const { roomId, peerId } = session;
    const room = rooms.get(roomId);
    if (!room) return;

    // Only remove the peer if a reconnect hasn't already replaced this socket.
    if (room.peers.get(peerId) === socket.id) {
      room.peers.delete(peerId);
      socket.to(roomId).emit('peer-left', { peerId });
    }
    if (room.peers.size === 0) rooms.delete(roomId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT}`);
});
