import { useState } from 'react';
import FileDropZone, { SelectedFileCard } from './components/FileDropZone.jsx';
import ConnectionStatus, { ProgressPanel } from './components/StatusPanels.jsx';
import { useP2PShare } from './hooks/useP2PShare.js';
import { readShareLink } from './lib/crypto.js';

const HOME_URL = window.location.pathname;

function SharePage() {
  const {
    connectionStatus,
    connectionLabel,
    statusMessage,
    shareUrl,
    activeRoomId,
    selectedFile,
    progress,
    speedLabel,
    transferredBytes,
    totalBytes,
    error,
    selectFile,
    createRoom,
  } = useP2PShare({ mode: 'sender' });

  const [copied, setCopied] = useState(false);
  const isBusy = ['connecting', 'connected', 'transferring'].includes(connectionStatus);

  const copyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-[0.2em] text-cyan-400">Sender</p>
        <h1 className="text-3xl font-bold">Share a file directly</h1>
        <p className="text-slate-400">
          Drop a file, create a room, and send the invite link. Files transfer peer-to-peer
          through WebRTC — the signaling server never sees your data.
        </p>
        <p className="text-sm text-emerald-300">
          🔒 End-to-end encrypted with AES-256-GCM. The key lives only in the link&apos;s #fragment.
        </p>
      </header>

      <FileDropZone onFileSelect={selectFile} disabled={isBusy} />
      <SelectedFileCard file={selectedFile} />

      <button
        type="button"
        onClick={createRoom}
        disabled={!selectedFile || isBusy}
        className="rounded-xl bg-cyan-500 px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Create share room
      </button>

      {shareUrl ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <p className="text-sm text-slate-400">Invite link</p>
          <p className="mt-2 break-all font-medium text-cyan-300">{shareUrl}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={copyLink}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-slate-500"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <p className="self-center text-sm text-slate-500">Room ID: {activeRoomId}</p>
          </div>
        </div>
      ) : null}

      <ConnectionStatus
        status={connectionStatus}
        label={connectionLabel}
        message={statusMessage}
      />

      <ProgressPanel
        progress={progress}
        speedLabel={speedLabel}
        transferredBytes={transferredBytes}
        totalBytes={totalBytes}
        visible={connectionStatus === 'transferring' || connectionStatus === 'complete'}
      />

      {error ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function JoinPage({ roomId, keyString }) {
  const {
    connectionStatus,
    connectionLabel,
    statusMessage,
    progress,
    speedLabel,
    transferredBytes,
    totalBytes,
    error,
  } = useP2PShare({ mode: 'receiver', roomId, keyString });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-[0.2em] text-blue-400">Receiver</p>
        <h1 className="text-3xl font-bold">Receiving shared file</h1>
        <p className="text-slate-400">
          Connecting to room <span className="font-mono text-slate-200">{roomId}</span>. The
          download will start automatically once all chunks are verified.
        </p>
      </header>

      <ConnectionStatus
        status={connectionStatus}
        label={connectionLabel}
        message={statusMessage}
      />

      <ProgressPanel
        progress={progress}
        speedLabel={speedLabel}
        transferredBytes={transferredBytes}
        totalBytes={totalBytes}
        visible={connectionStatus === 'transferring' || connectionStatus === 'complete'}
      />

      {error ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">
          {error}
        </div>
      ) : null}

      <a href={HOME_URL} className="text-sm text-cyan-400 hover:text-cyan-300">
        ← Back to sender page
      </a>
    </div>
  );
}

export default function App() {
  // Invite links look like `/?room=<id>#key=<aes-key>`. The fragment is never
  // sent to any server.
  const { roomId, keyString } = readShareLink();

  return (
    <div className="min-h-screen px-4 py-10">
      <div className="mx-auto mb-10 flex max-w-5xl items-center justify-between">
        <div>
          <p className="text-xl font-bold">P2P Web Share</p>
          <p className="text-sm text-slate-500">Browser-to-browser file transfer</p>
        </div>
        <a
          href={HOME_URL}
          className="rounded-lg border border-slate-800 px-4 py-2 text-sm hover:border-slate-600"
        >
          Home
        </a>
      </div>

      {roomId ? <JoinPage roomId={roomId} keyString={keyString} /> : <SharePage />}
    </div>
  );
}
