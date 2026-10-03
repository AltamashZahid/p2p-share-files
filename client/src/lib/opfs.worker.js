// ---------------------------------------------------------------------------
// OPFS worker: owns the Origin Private File System files that incoming chunks
// are streamed into.
//
// `createSyncAccessHandle()` is only available inside dedicated workers. It
// writes at arbitrary offsets straight to disk, which lets a receiver
// download files far larger than the browser's RAM (>500 MB) without ever
// holding the whole file in memory.
//
// Requests are processed one at a time, in order: { id, op, args } -> { id, result | error }
// ---------------------------------------------------------------------------

const DIRECTORY = 'p2p-share';
const handles = new Map(); // file name -> FileSystemSyncAccessHandle
let queue = Promise.resolve();

async function directory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY, { create: true });
}

function closeHandle(name) {
  const handle = handles.get(name);
  if (!handle) return;
  handle.flush();
  handle.close();
  handles.delete(name);
}

const operations = {
  async open({ name, size }) {
    if (!handles.has(name)) {
      const fileHandle = await (await directory()).getFileHandle(name, { create: true });
      handles.set(name, await fileHandle.createSyncAccessHandle());
    }
    const handle = handles.get(name);
    // Pre-size the file so every chunk can be written at its final offset.
    if (handle.getSize() !== size) handle.truncate(size);
    return true;
  },

  async write({ name, offset, data }) {
    handles.get(name).write(new Uint8Array(data), { at: offset });
    return true;
  },

  async read({ name, offset, length }) {
    const buffer = new Uint8Array(length);
    const read = handles.get(name).read(buffer, { at: offset });
    return read === length ? buffer.buffer : buffer.buffer.slice(0, read);
  },

  async flush({ name }) {
    handles.get(name)?.flush();
    return true;
  },

  async close({ name }) {
    closeHandle(name);
    return true;
  },

  async remove({ name }) {
    closeHandle(name);
    await (await directory()).removeEntry(name).catch(() => {});
    return true;
  },

  async list() {
    const names = [];
    for await (const name of (await directory()).keys()) names.push(name);
    return names;
  },
};

self.onmessage = ({ data: { id, op, args } }) => {
  queue = queue.then(async () => {
    try {
      const result = await operations[op](args);
      self.postMessage({ id, result }, result instanceof ArrayBuffer ? [result] : []);
    } catch (err) {
      self.postMessage({ id, error: err?.message || String(err) });
    }
  });
};
