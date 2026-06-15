import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const CLIENT_ORIGINS = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : true;

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'p2p-web-share-signaling' });
});

// ---------------------------------------------------------------------------
// Serve the frontend production build when it exists (e.g. on Render).
// In development the frontend is served by Vite, so this is a no-op.
// ---------------------------------------------------------------------------
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
const indexHtmlPath = path.join(clientDistPath, 'index.html');

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  // SPA fallback: serve index.html for any path that did not match a static
  // file or an API route. This keeps client-side routing working.
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

/** @type {Map<string, { senderId: string, receiverId?: string }>} */
const rooms = new Map();

function getPeerSocket(roomId, excludeSocketId) {
  const room = rooms.get(roomId);
  if (!room) return null;

  const targetId =
    room.senderId === excludeSocketId ? room.receiverId : room.senderId;

  return targetId ? io.sockets.sockets.get(targetId) ?? null : null;
}

function notifyPeerDisconnect(roomId, disconnectedSocketId, reason) {
  const peer = getPeerSocket(roomId, disconnectedSocketId);
  if (peer) {
    peer.emit('peer-disconnected', { roomId, reason });
  }
}

function cleanupRoom(roomId) {
  rooms.delete(roomId);
}

io.on('connection', (socket) => {
  let activeRoomId = null;
  let role = null;

  const ack = (callback, payload) => {
    if (typeof callback === 'function') {
      callback(payload);
    }
  };

  socket.on('create-room', (payload, callback) => {
    const hasPayload = typeof payload === 'object' && payload !== null;
    const ackCallback = hasPayload ? callback : payload;
    const requestedRoomId = hasPayload ? payload.roomId : null;
    const roomId =
      typeof requestedRoomId === 'string' && requestedRoomId.trim()
        ? requestedRoomId.trim()
        : uuidv4().slice(0, 8);

    if (rooms.has(roomId)) {
      ack(ackCallback, { ok: false, error: 'Room already exists.' });
      return;
    }

    rooms.set(roomId, { senderId: socket.id });
    activeRoomId = roomId;
    role = 'sender';
    socket.join(roomId);
    ack(ackCallback, { ok: true, roomId });
  });

  socket.on('join-room', (payload, callback) => {
    const roomId = typeof payload === 'string' ? payload : payload?.roomId;
    const room = rooms.get(roomId);

    if (!room) {
      ack(callback, { ok: false, error: 'Room not found or expired.' });
      return;
    }

    if (room.receiverId) {
      ack(callback, { ok: false, error: 'Room already has a receiver.' });
      return;
    }

    room.receiverId = socket.id;
    activeRoomId = roomId;
    role = 'receiver';
    socket.join(roomId);

    const senderSocket = io.sockets.sockets.get(room.senderId);
    if (senderSocket) {
      senderSocket.emit('receiver-joined', { roomId, receiverId: socket.id });
    }

    ack(callback, { ok: true, roomId });
  });

  socket.on('webrtc-offer', ({ roomId, offer }) => {
    const peer = getPeerSocket(roomId, socket.id);
    if (peer) peer.emit('webrtc-offer', { offer, from: socket.id });
  });

  socket.on('webrtc-answer', ({ roomId, answer }) => {
    const peer = getPeerSocket(roomId, socket.id);
    if (peer) peer.emit('webrtc-answer', { answer, from: socket.id });
  });

  socket.on('webrtc-ice-candidate', ({ roomId, candidate }) => {
    const peer = getPeerSocket(roomId, socket.id);
    if (peer) peer.emit('webrtc-ice-candidate', { candidate, from: socket.id });
  });

  socket.on('disconnect', () => {
    if (!activeRoomId) return;

    const room = rooms.get(activeRoomId);
    if (!room) return;

    notifyPeerDisconnect(activeRoomId, socket.id, 'peer_disconnected');

    if (role === 'sender') {
      cleanupRoom(activeRoomId);
    } else if (role === 'receiver') {
      room.receiverId = undefined;
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT}`);
});
