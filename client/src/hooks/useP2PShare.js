import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  buildShareUrl,
  formatSpeed,
  generateRoomId,
  hashBuffer,
  readFileChunk,
  triggerDownload,
} from '../utils/transfer.js';
import {
  acceptAnswer,
  applyRemoteIceCandidate,
  attachIceCandidateRelay,
  createAnswer,
  createOffer,
  createPeerConnection,
  createSignalingSocket,
  openDataChannelAsReceiver,
  waitForDataChannel,
} from '../utils/webrtc.js';

const CONNECTION_LABELS = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  transferring: 'Transferring',
  complete: 'Complete',
  error: 'Error',
  disconnected: 'Disconnected',
};

export function useP2PShare({ mode, roomId }) {
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [activeRoomId, setActiveRoomId] = useState(roomId ?? '');
  const [selectedFile, setSelectedFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [transferredBytes, setTransferredBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [error, setError] = useState('');

  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const channelRef = useRef(null);
  const fileRef = useRef(null);
  const ackWaitersRef = useRef(new Map());
  const receivedChunksRef = useRef(new Map());
  const metaRef = useRef(null);
  const speedTrackerRef = useRef({ lastBytes: 0, lastTime: Date.now() });

  // Keep a ref that always reflects the latest connectionStatus.
  // This lets callbacks read the current value without depending on the state
  // variable, which would otherwise recreate the callbacks on every change
  // and trigger the useEffect → cleanup → joinRoom loop.
  const connectionStatusRef = useRef(connectionStatus);
  connectionStatusRef.current = connectionStatus;

  const resetTransferState = useCallback(() => {
    setProgress(0);
    setSpeed(0);
    setTransferredBytes(0);
    setTotalBytes(0);
    ackWaitersRef.current.clear();
    receivedChunksRef.current.clear();
    metaRef.current = null;
    speedTrackerRef.current = { lastBytes: 0, lastTime: Date.now() };
  }, []);

  const cleanup = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    socketRef.current?.disconnect();
    socketRef.current = null;
    fileRef.current = null;
    resetTransferState();
  }, [resetTransferState]);

  const updateSpeed = useCallback((bytes) => {
    const now = Date.now();
    const { lastBytes, lastTime } = speedTrackerRef.current;
    const elapsed = (now - lastTime) / 1000;
    if (elapsed >= 0.5) {
      const delta = bytes - lastBytes;
      setSpeed(delta / elapsed);
      speedTrackerRef.current = { lastBytes: bytes, lastTime: now };
    }
  }, []);

  const handleDisconnect = useCallback((reason) => {
    setConnectionStatus('disconnected');
    setStatusMessage(
      reason === 'peer_disconnected'
        ? 'The other peer disconnected.'
        : 'Connection lost.',
    );
    channelRef.current?.close();
    channelRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
  }, []);

  const waitForChunkAck = useCallback((index) => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ackWaitersRef.current.delete(index);
        reject(new Error(`Chunk ${index} acknowledgment timed out`));
      }, 15000);

      ackWaitersRef.current.set(index, () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }, []);

  const sendFileOverChannel = useCallback(
    async (channel, file) => {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      metaRef.current = {
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks,
      };

      channel.send(
        JSON.stringify({ type: 'file-meta', payload: metaRef.current }),
      );

      setConnectionStatus('transferring');
      setStatusMessage('Sending file…');
      setTotalBytes(file.size);

      for (let index = 0; index < totalChunks; index += 1) {
        const buffer = await readFileChunk(file, index);
        const hash = await hashBuffer(buffer);

        // Wait for the data channel buffer to drain before sending the next chunk.
        // This prevents overwhelming the channel when the network is slower
        // than the file read speed.
        while (channel.bufferedAmount > CHUNK_SIZE * 8) {
          await new Promise((r) => setTimeout(r, 50));
        }

        channel.send(
          JSON.stringify({ type: 'chunk-header', index, hash, size: buffer.byteLength }),
        );
        channel.send(buffer);
        await waitForChunkAck(index);

        const sentBytes = Math.min((index + 1) * CHUNK_SIZE, file.size);
        setTransferredBytes(sentBytes);
        setProgress(Math.round((sentBytes / file.size) * 100));
        updateSpeed(sentBytes);
      }

      channel.send(JSON.stringify({ type: 'transfer-complete' }));
      setConnectionStatus('complete');
      setStatusMessage('Transfer complete.');
      setProgress(100);
    },
    [updateSpeed, waitForChunkAck],
  );

  const finalizeDownload = useCallback(async () => {
    const meta = metaRef.current;
    if (!meta) return;

    const orderedChunks = [];
    for (let i = 0; i < meta.totalChunks; i += 1) {
      const chunk = receivedChunksRef.current.get(i);
      if (!chunk) {
        setError(`Missing chunk ${i} during reassembly.`);
        setConnectionStatus('error');
        return;
      }
      orderedChunks.push(chunk);
    }

    const blob = new Blob(orderedChunks, { type: meta.mimeType });
    triggerDownload(blob, meta.name);
    setConnectionStatus('complete');
    setStatusMessage('Download started automatically.');
    setProgress(100);
  }, []);

  const handleIncomingMessage = useCallback(
    async (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);

        if (message.type === 'file-meta') {
          metaRef.current = message.payload;
          setTotalBytes(message.payload.size);
          setConnectionStatus('transferring');
          setStatusMessage(`Receiving ${message.payload.name}…`);
          return;
        }

        if (message.type === 'chunk-header') {
          channelRef.current._pendingHeader = message;
          return;
        }

        if (message.type === 'chunk-ack') {
          const resolver = ackWaitersRef.current.get(message.index);
          resolver?.();
          return;
        }

        if (message.type === 'transfer-complete') {
          setStatusMessage('All chunks verified.');
        }
        return;
      }

      // Binary data — this is a file chunk following its header.
      const header = channelRef.current?._pendingHeader;
      if (!header) return;

      const buffer = event.data;
      const actualHash = await hashBuffer(buffer);

      if (actualHash !== header.hash) {
        channelRef.current.send(
          JSON.stringify({
            type: 'chunk-nack',
            index: header.index,
            reason: 'hash_mismatch',
          }),
        );
        setError(`Chunk ${header.index} failed verification.`);
        setConnectionStatus('error');
        return;
      }

      receivedChunksRef.current.set(header.index, buffer);
      channelRef.current.send(
        JSON.stringify({ type: 'chunk-ack', index: header.index }),
      );

      const receivedCount = receivedChunksRef.current.size;
      const meta = metaRef.current;
      if (meta) {
        const bytes = Math.min(receivedCount * CHUNK_SIZE, meta.size);
        setTransferredBytes(bytes);
        setProgress(Math.round((bytes / meta.size) * 100));
        updateSpeed(bytes);

        if (receivedCount === meta.totalChunks) {
          await finalizeDownload();
        }
      }

      channelRef.current._pendingHeader = null;
    },
    [finalizeDownload, updateSpeed],
  );

  // FIX: Read connectionStatus from a ref instead of closing over the state
  // variable. This removes connectionStatus from the dependency array, which
  // prevents the cascade: setupDataChannelHandlers → startReceiverConnection →
  // joinRoom → useEffect re-run → cleanup → rejoin → infinite loop.
  const setupDataChannelHandlers = useCallback(
    (channel) => {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = handleIncomingMessage;
      channel.onclose = () => {
        if (connectionStatusRef.current !== 'complete') {
          handleDisconnect('channel_closed');
        }
      };
      channel.onerror = () => {
        setError('Data channel error.');
        setConnectionStatus('error');
      };
    },
    [handleDisconnect, handleIncomingMessage],
  );

  const startSenderConnection = useCallback(
    async (socket, room, file) => {
      const pc = createPeerConnection();
      pcRef.current = pc;
      attachIceCandidateRelay(pc, socket, room);

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setConnectionStatus('connected');
          setStatusMessage('Peer connected. Starting transfer…');
        }
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          handleDisconnect('webrtc_failed');
        }
      };

      const channelPromise = waitForDataChannel(pc);
      const offer = await createOffer(pc);
      socket.emit('webrtc-offer', { roomId: room, offer });

      const channel = await channelPromise;
      channelRef.current = channel;
      setupDataChannelHandlers(channel);
      await sendFileOverChannel(channel, file);
    },
    [handleDisconnect, sendFileOverChannel, setupDataChannelHandlers],
  );

  const startReceiverConnection = useCallback(
    (socket, room) => {
      const pc = createPeerConnection();
      pcRef.current = pc;
      attachIceCandidateRelay(pc, socket, room);

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setConnectionStatus('connected');
          setStatusMessage('Connected to sender.');
        }
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          handleDisconnect('webrtc_failed');
        }
      };

      socket.once('webrtc-offer', async ({ offer }) => {
        try {
          const answer = await createAnswer(pc, offer);
          socket.emit('webrtc-answer', { roomId: room, answer });
        } catch (err) {
          setError(err.message || 'Failed to handle WebRTC offer.');
          setConnectionStatus('error');
        }
      });

      openDataChannelAsReceiver(pc)
        .then((channel) => {
          channelRef.current = channel;
          setupDataChannelHandlers(channel);
        })
        .catch((err) => {
          setError(err.message || 'Data channel failed to open.');
          setConnectionStatus('error');
        });
    },
    [handleDisconnect, setupDataChannelHandlers],
  );

  const selectFile = useCallback(
    (file) => {
      setError('');
      if (!file) return;

      if (file.size > MAX_FILE_SIZE) {
        setError('File must be smaller than 50 MB.');
        return;
      }

      setSelectedFile(file);
      fileRef.current = file;
    },
    [],
  );

  const createRoom = useCallback(() => {
    const file = fileRef.current;
    if (!file) {
      setError('Select a file before creating a room.');
      return;
    }

    cleanup();
    fileRef.current = file;
    resetTransferState();
    setError('');
    setConnectionStatus('connecting');
    const newRoomId = generateRoomId();
    setActiveRoomId(newRoomId);
    setShareUrl(buildShareUrl(newRoomId));
    setStatusMessage('Share link ready. Registering room with signaling server…');

    const socket = createSignalingSocket();
    socketRef.current = socket;

    socket.on('receiver-joined', async () => {
      try {
        await startSenderConnection(socket, newRoomId, fileRef.current);
      } catch (err) {
        setError(err.message || 'Sender connection failed.');
        setConnectionStatus('error');
      }
    });

    socket.on('connect', () => {
      socket.timeout(10000).emit('create-room', { roomId: newRoomId }, (err, response) => {
        if (err || !response?.ok) {
          setError('Signaling server did not create a room. Please try again.');
          setConnectionStatus('error');
          setStatusMessage('Share link was generated, but the room is not active.');
          return;
        }

        setStatusMessage('Waiting for receiver to join…');
        setConnectionStatus('connecting');
      });
    });

    socket.on('webrtc-answer', async ({ answer }) => {
      try {
        await acceptAnswer(pcRef.current, answer);
      } catch (err) {
        setError(err.message || 'Failed to accept answer.');
        setConnectionStatus('error');
      }
    });

    socket.on('webrtc-ice-candidate', async ({ candidate }) => {
      try {
        await applyRemoteIceCandidate(pcRef.current, candidate);
      } catch {
        // ICE candidates can arrive before remote description is set.
      }
    });

    socket.on('peer-disconnected', () => handleDisconnect('peer_disconnected'));
    socket.on('connect_error', () => {
      setError('Could not reach signaling server.');
      setConnectionStatus('error');
    });
  }, [
    cleanup,
    handleDisconnect,
    resetTransferState,
    startSenderConnection,
  ]);

  const joinRoom = useCallback(() => {
    if (!roomId) {
      setError('Invalid room link.');
      return;
    }

    cleanup();
    resetTransferState();
    setError('');
    setConnectionStatus('connecting');
    setStatusMessage('Joining room…');

    const socket = createSignalingSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      startReceiverConnection(socket, roomId);

      socket.emit('join-room', { roomId }, (response) => {
        if (!response?.ok) {
          setError(response?.error || 'Unable to join room.');
          setConnectionStatus('error');
          return;
        }

        setActiveRoomId(roomId);
        setStatusMessage('Joined room. Waiting for sender offer…');
      });
    });

    socket.on('webrtc-ice-candidate', async ({ candidate }) => {
      try {
        await applyRemoteIceCandidate(pcRef.current, candidate);
      } catch {
        // Ignore out-of-order ICE candidates.
      }
    });

    socket.on('peer-disconnected', () => handleDisconnect('peer_disconnected'));
    socket.on('connect_error', () => {
      setError('Could not reach signaling server.');
      setConnectionStatus('error');
    });
  }, [
    cleanup,
    handleDisconnect,
    resetTransferState,
    roomId,
    startReceiverConnection,
  ]);

  useEffect(() => {
    if (mode === 'receiver' && roomId) {
      joinRoom();
    }

    return () => cleanup();
  }, [cleanup, joinRoom, mode, roomId]);

  return {
    connectionStatus,
    connectionLabel: CONNECTION_LABELS[connectionStatus] ?? connectionStatus,
    statusMessage,
    shareUrl,
    activeRoomId,
    selectedFile,
    progress,
    speed,
    speedLabel: formatSpeed(speed),
    transferredBytes,
    totalBytes,
    error,
    selectFile,
    createRoom,
    joinRoom,
    cleanup,
  };
}
