import { useCallback, useState } from 'react';
import { formatBytes } from '../lib/format.js';

export default function FileDropZone({ onFileSelect, disabled }) {
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (files) => {
      const file = files?.[0];
      if (file) onFileSelect(file);
    },
    [onFileSelect],
  );

  return (
    <label
      className={`flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 transition ${
        isDragging
          ? 'border-cyan-400 bg-cyan-400/10'
          : 'border-slate-700 bg-slate-900/60 hover:border-slate-500'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setIsDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        type="file"
        className="hidden"
        disabled={disabled}
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="text-lg font-medium">Drop a file here</p>
      <p className="mt-2 text-sm text-slate-400">or click to browse — any size; receivers stream large files straight to disk</p>
    </label>
  );
}

export function SelectedFileCard({ file }) {
  if (!file) return null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
      <p className="text-sm text-slate-400">Selected file</p>
      <p className="mt-1 font-medium break-all">{file.name}</p>
      <p className="mt-1 text-sm text-slate-400">{formatBytes(file.size)}</p>
    </div>
  );
}
