import { formatBytes, formatSpeed } from '../lib/format.js';

const STATUS_STYLES = {
  connecting: { className: 'bg-amber-500/20 text-amber-300', label: 'Connecting' },
  waiting: { className: 'bg-amber-500/20 text-amber-300', label: 'Waiting' },
  connected: { className: 'bg-emerald-500/20 text-emerald-300', label: 'Connected' },
  transferring: { className: 'bg-cyan-500/20 text-cyan-300', label: 'Transferring' },
  seeding: { className: 'bg-cyan-500/20 text-cyan-300', label: 'Seeding' },
  stalled: { className: 'bg-amber-500/20 text-amber-300', label: 'Paused' },
  complete: { className: 'bg-emerald-500/20 text-emerald-300', label: 'Complete' },
  error: { className: 'bg-rose-500/20 text-rose-300', label: 'Error' },
};

export default function ConnectionStatus({ status, message }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.connecting;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">Status</p>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${style.className}`}
        >
          {style.label}
        </span>
      </div>
      {message ? <p className="mt-3 text-sm text-slate-300">{message}</p> : null}
    </div>
  );
}

/** Download progress for the receiver: verified bytes, speed and chunk count. */
export function ProgressPanel({ snapshot }) {
  if (!snapshot?.file) return null;
  const percent = Math.floor(snapshot.progress * 100);

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="mb-2 flex items-center justify-between gap-3 text-sm">
        <span className="truncate font-medium text-slate-200">{snapshot.file.name}</span>
        <span className="font-medium text-cyan-300">{percent}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-400">
        <span>
          {formatBytes(snapshot.bytesVerified)} / {formatBytes(snapshot.file.size)}
        </span>
        <span>↓ {formatSpeed(snapshot.downloadRate)}</span>
        {snapshot.uploadRate > 0 ? <span>↑ {formatSpeed(snapshot.uploadRate)}</span> : null}
        <span>
          {snapshot.verifiedChunks}/{snapshot.totalChunks} chunks verified (SHA-256)
        </span>
      </div>
    </div>
  );
}

/** Small feature badges: encryption and where chunks are stored. */
export function Badges({ storage }) {
  const storageLabel = {
    opfs: '💾 Streaming to disk (OPFS)',
    memory: '🧠 Buffering in memory',
    source: '📁 Reading from your disk',
  }[storage];

  return (
    <div className="flex flex-wrap gap-2 text-xs">
      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-emerald-300">
        🔒 End-to-end encrypted · AES-256-GCM
      </span>
      {storageLabel ? (
        <span className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1 text-slate-300">
          {storageLabel}
        </span>
      ) : null}
    </div>
  );
}
