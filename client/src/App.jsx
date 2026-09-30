import { useState } from 'react';
import FileDropZone, { SelectedFileCard } from './components/FileDropZone.jsx';
import PeerList from './components/PeerList.jsx';
import ConnectionStatus, { Badges, ProgressPanel } from './components/StatusPanels.jsx';
import { useGuestSession, useHostSession } from './hooks/useSwarm.js';
import { readShareLink } from './lib/crypto.js';
import { formatBytes, formatSpeed } from './lib/format.js';

const HOME_URL = window.location.pathname;

function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">
      {message}
    </div>
  );
}

function SharePage() {
  const { snapshot, preparing, shareUrl, error, resumeRecord, share, stop, discardResume } =
    useHostSession();
  const [file, setFile] = useState(null);
  const [copied, setCopied] = useState(false);
  const sharing = Boolean(shareUrl);
  const busy = preparing !== null || sharing;

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="space-y-3">
        <p className="text-sm uppercase tracking-[0.2em] text-cyan-400">Sender</p>
        <h1 className="text-3xl font-bold">Share a file directly</h1>
        <p className="text-slate-400">
          Drop a file, create a room, and send the invite link. Everyone who opens it joins a
          peer-to-peer swarm: they download from you <em>and</em> from each other. The signaling
          server only introduces peers and never sees your data.
        </p>
        <Badges storage={sharing ? 'source' : null} />
      </header>

      {resumeRecord && !sharing ? (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-200">Resume sharing?</p>
          <p className="mt-1 text-amber-100/80">
            This tab was sharing <span className="font-medium">{resumeRecord.name}</span> (
            {formatBytes(resumeRecord.size)}) in room{' '}
            <span className="font-mono">{resumeRecord.roomId}</span>. Select the same file again
            and peers carry on from the chunks they already verified.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => share(file, { resume: true })}
              disabled={!file || busy}
              className="rounded-lg bg-amber-400 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {file ? `Resume sharing ${file.name}` : 'Resume sharing (select the file first)'}
            </button>
            <button
              type="button"
              onClick={discardResume}
              disabled={busy}
              className="rounded-lg border border-amber-500/40 px-4 py-2 text-amber-200 hover:border-amber-400"
            >
              Start fresh
            </button>
          </div>
        </div>
      ) : null}

      <FileDropZone onFileSelect={setFile} disabled={busy} />
      <SelectedFileCard file={file} />

      {!sharing ? (
        <button
          type="button"
          onClick={() => share(file)}
          disabled={!file || busy}
          className="rounded-xl bg-cyan-500 px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {preparing !== null
            ? `Hashing chunks for verification… ${Math.floor(preparing * 100)}%`
            : 'Create share room'}
        </button>
      ) : null}

      {sharing ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
          <p className="text-sm text-slate-400">Invite link</p>
          <p className="mt-2 break-all font-medium text-cyan-300" data-testid="share-url">
            {shareUrl}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={copyLink}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:border-slate-500"
            >
              {copied ? 'Copied!' : 'Copy link'}
            </button>
            <button
              type="button"
              onClick={() => {
                stop();
                setFile(null);
              }}
              className="rounded-lg border border-rose-500/40 px-4 py-2 text-sm text-rose-300 hover:border-rose-400"
            >
              Stop sharing
            </button>
            <p className="text-sm text-slate-500">Room {snapshot?.roomId}</p>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            The part after <span className="font-mono">#key=</span> is the decryption key. Browsers
            never send it to the server.
          </p>
        </div>
      ) : null}

      {snapshot ? (
        <>
          <ConnectionStatus status={snapshot.status} message={snapshot.message} />
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-sm text-slate-400">
            <span>↑ {formatSpeed(snapshot.uploadRate)}</span>
            <span>{formatBytes(snapshot.uploadedTotal)} uploaded in total</span>
          </div>
          <PeerList peers={snapshot.peers} role="host" />
        </>
      ) : null}

      <ErrorBox message={error || snapshot?.error} />
    </div>
  );
}

function JoinPage({ roomId, keyString }) {
  const { snapshot, download, error } = useGuestSession(roomId, keyString);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="space-y-3">
        <p className="text-sm uppercase tracking-[0.2em] text-blue-400">Receiver</p>
        <h1 className="text-3xl font-bold">Receiving shared file</h1>
        <p className="text-slate-400">
          Room <span className="font-mono text-slate-200">{roomId}</span>. Chunks arrive from every
          peer in the swarm, are decrypted and checked against the sender&apos;s SHA-256 manifest,
          and the download starts automatically once all of them are verified.
        </p>
        <Badges storage={snapshot?.storage} />
      </header>

      {snapshot ? <ConnectionStatus status={snapshot.status} message={snapshot.message} /> : null}
      {snapshot?.resumedChunks ? (
        <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          ↻ Resumed from your last session: {snapshot.resumedChunks} of {snapshot.totalChunks}{' '}
          verified chunks restored from disk.
        </p>
      ) : null}
      <ProgressPanel snapshot={snapshot} />

      {download ? (
        <a
          href={download.url}
          download={download.name}
          className="rounded-xl bg-emerald-500 px-5 py-3 text-center font-semibold text-slate-950 hover:bg-emerald-400"
        >
          Save {download.name} again
        </a>
      ) : null}

      <PeerList peers={snapshot?.peers} role="guest" />
      <ErrorBox message={error || snapshot?.error} />

      <a href={HOME_URL} className="text-sm text-cyan-400 hover:text-cyan-300">
        ← Share your own file
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
          <p className="text-sm text-slate-500">Encrypted browser-to-browser swarm</p>
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
