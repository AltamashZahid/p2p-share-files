import { formatBytes } from '../lib/format.js';

const STATE_STYLES = {
  connected: { dot: 'bg-emerald-400', label: 'Connected' },
  connecting: { dot: 'bg-amber-400 animate-pulse', label: 'Connecting…' },
  reconnecting: { dot: 'bg-amber-400 animate-pulse', label: 'Reconnecting…' },
  disconnected: { dot: 'bg-rose-400', label: 'Disconnected' },
  left: { dot: 'bg-slate-600', label: 'Left' },
  banned: { dot: 'bg-rose-600', label: 'Blocked (corrupt data)' },
  'bad-key': { dot: 'bg-rose-600', label: 'Wrong key' },
};

/**
 * The swarm: every peer in the room, how much of the file each one has, and
 * how many bytes flowed to and from it.
 */
export default function PeerList({ peers, role }) {
  if (!peers?.length) return null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-slate-400">Swarm</p>
        <p className="text-xs text-slate-500">
          {peers.filter((p) => p.state === 'connected').length} connected
        </p>
      </div>
      <ul className="space-y-3">
        {peers.map((peer) => {
          const style = STATE_STYLES[peer.state] ?? STATE_STYLES.connecting;
          const percent = Math.round(peer.progress * 100);
          return (
            <li
              key={peer.id}
              className="space-y-1.5"
              data-peer={peer.isHost ? 'host' : 'peer'}
              data-downloaded={peer.downloaded}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${style.dot}`} />
                  <span className="font-medium">
                    {peer.isHost ? 'Sender' : 'Peer'}{' '}
                    <span className="font-mono text-slate-500">{peer.id.slice(0, 6)}</span>
                  </span>
                  <span className="text-xs text-slate-500">{style.label}</span>
                </span>
                <span className="text-xs text-slate-400" title="Received from / sent to this peer">
                  {role === 'guest' ? `↓ ${formatBytes(peer.downloaded)} · ` : ''}↑{' '}
                  {formatBytes(peer.uploaded)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-emerald-500/70 transition-all duration-300"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <span className="w-10 text-right text-xs text-slate-500">{percent}%</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
