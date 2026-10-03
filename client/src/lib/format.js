export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Bytes per second over a sliding time window. */
export class RateMeter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.total = 0;
  }

  add(bytes) {
    this.samples.push([Date.now(), bytes]);
    this.total += bytes;
  }

  rate() {
    const cutoff = Date.now() - this.windowMs;
    while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift();
    const bytes = this.samples.reduce((sum, [, n]) => sum + n, 0);
    return bytes / (this.windowMs / 1000);
  }
}
