// ---------------------------------------------------------------------------
// Auto-resume state that survives reloads, closed tabs and dropped connections.
//
// Receiver: after each verified chunk is written to OPFS, its bit is saved in
// localStorage (`p2p-resume:<roomId>` = { fileId, have }). When the page opens
// the same link again, the bitfield is restored and only missing chunks are
// requested, resuming from the last verified chunk instead of 0%.
//
// Sender: the room id, peer id and key are kept in sessionStorage for this
// tab, so after a refresh the sender re-selects the same file and takes the
// room back over; peers keep their progress.
// ---------------------------------------------------------------------------

const RESUME_PREFIX = 'p2p-resume:';
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HOST_KEY = 'p2p-host';

function readJson(storage, key) {
  try {
    const text = storage.getItem(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: resume just won't be available */
  }
}

function remove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ receiver

/** { fileId, have (base64 bitfield), updatedAt } or null. */
export function loadResumeRecord(roomId) {
  const record = readJson(localStorage, RESUME_PREFIX + roomId);
  if (!record || Date.now() - record.updatedAt > RESUME_MAX_AGE_MS) return null;
  return record;
}

export function saveResumeRecord(roomId, fileId, have) {
  writeJson(localStorage, RESUME_PREFIX + roomId, { fileId, have, updatedAt: Date.now() });
}

export function clearResumeRecord(roomId) {
  remove(localStorage, RESUME_PREFIX + roomId);
}

/** Rooms with fresh resume records; expired records are deleted. */
export function resumableRoomIds() {
  const ids = new Set();
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key?.startsWith(RESUME_PREFIX)) continue;
      const roomId = key.slice(RESUME_PREFIX.length);
      if (loadResumeRecord(roomId)) ids.add(roomId);
      else remove(localStorage, key);
    }
  } catch {
    /* storage blocked */
  }
  return ids;
}

/**
 * This tab's peer id in a room, stable across refreshes so the signaling
 * server and other peers recognise a returning peer.
 */
export function tabPeerId(roomId, generate) {
  const key = `p2p-peer:${roomId}`;
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = generate();
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return generate();
  }
}

// -------------------------------------------------------------------- sender

/** { roomId, peerId, keyString, fileId, name, size } */
export function saveHostRecord(record) {
  writeJson(sessionStorage, HOST_KEY, record);
}

export function loadHostRecord() {
  return readJson(sessionStorage, HOST_KEY);
}

export function clearHostRecord() {
  remove(sessionStorage, HOST_KEY);
}
