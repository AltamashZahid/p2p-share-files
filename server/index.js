import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'p2p-web-share-signaling' });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
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

  socket.on('create-room', (callback) => {
    const roomId = uuidv4().slice(0, 8);
    rooms.set(roomId, { senderId: socket.id });
    activeRoomId = roomId;
    role = 'sender';
    socket.join(roomId);
    ack(callback, { roomId });
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
