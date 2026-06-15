import { formatBytes } from '../utils/transfer.js';

const STATUS_STYLES = {
  idle: 'bg-slate-700 text-slate-200',
  connecting: 'bg-amber-500/20 text-amber-300',
  connected: 'bg-emerald-500/20 text-emerald-300',
  transferring: 'bg-cyan-500/20 text-cyan-300',
  complete: 'bg-emerald-500/20 text-emerald-300',
  error: 'bg-rose-500/20 text-rose-300',
  disconnected: 'bg-rose-500/20 text-rose-300',
};

export default function ConnectionStatus({ status, label, message }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">Connection</p>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
            STATUS_STYLES[status] ?? STATUS_STYLES.idle
          }`}
        >
          {label}
        </span>
      </div>
      {message ? <p className="mt-3 text-sm text-slate-300">{message}</p> : null}
    </div>
  );
}

export function ProgressPanel({
  progress,
  speedLabel,
  transferredBytes,
  totalBytes,
  visible,
}) {
  if (!visible) return null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-slate-400">Transfer progress</span>
        <span className="font-medium text-cyan-300">{progress}%</span>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-400">
        <span>
          {formatBytes(transferredBytes)} / {formatBytes(totalBytes)}
        </span>
        <span>{speedLabel}</span>
      </div>
    </div>
  );
}
