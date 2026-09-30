import { useCallback, useEffect, useRef, useState } from 'react';
import { buildShareUrl, exportKey, generateKey, importKey } from '../lib/crypto.js';
import { buildManifest } from '../lib/manifest.js';
import { clearHostRecord, loadHostRecord, saveHostRecord, tabPeerId } from '../lib/resume.js';
import { randomId } from '../lib/signaling.js';
import { SwarmSession } from '../lib/swarm.js';

function triggerDownload(url, fileName) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

/**
 * Sender page: hash the file, create a key and room, then seed it.
 * If this tab was already sharing before a refresh, `resumeRecord` describes
 * that room, and `share(file, { resume: true })` takes it back over.
 */
export function useHostSession() {
  const [snapshot, setSnapshot] = useState(null);
  const [preparing, setPreparing] = useState(null); // 0..1 while hashing
  const [shareUrl, setShareUrl] = useState('');
  const [error, setError] = useState('');
  const [resumeRecord, setResumeRecord] = useState(loadHostRecord);
  const sessionRef = useRef(null);

  useEffect(() => () => sessionRef.current?.destroy(), []);

  const stop = useCallback(() => {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    clearHostRecord();
    setResumeRecord(null);
    setSnapshot(null);
    setShareUrl('');
  }, []);

  const share = useCallback(
    async (file, { resume = false } = {}) => {
      const previous = resume ? loadHostRecord() : null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
      setError('');
      setPreparing(0);
      try {
        const manifest = await buildManifest(file, setPreparing);

        let key;
        let keyString;
        let roomId;
        let peerId;
        if (previous) {
          // Same file (same chunk hashes) -> same room, id and key, so peers
          // carry on from the chunks they already verified.
          if (manifest.fileId !== previous.fileId) {
            throw new Error(`That isn't the same file. Select "${previous.name}" to resume sharing.`);
          }
          key = await importKey(previous.keyString);
          ({ roomId, peerId, keyString } = previous);
        } else {
          // Fresh key per room: it only lives in this tab and in the link's #fragment.
          key = await generateKey();
          roomId = randomId(4);
          peerId = randomId(8);
          keyString = await exportKey(key);
        }

        saveHostRecord({ roomId, peerId, keyString, fileId: manifest.fileId, name: file.name, size: file.size });
        setResumeRecord(null);

        const session = new SwarmSession({ role: 'host', roomId, peerId, key, file, manifest, onUpdate: setSnapshot });
        sessionRef.current = session;
        setShareUrl(buildShareUrl(roomId, keyString));
        session.start();
      } catch (err) {
        setError(err.message || 'Could not prepare the file.');
      } finally {
        setPreparing(null);
      }
    },
    [],
  );

  const discardResume = useCallback(() => {
    clearHostRecord();
    setResumeRecord(null);
  }, []);

  return { snapshot, preparing, shareUrl, error, resumeRecord, share, stop, discardResume };
}

/** Receiver page: join the room from the invite link and download. */
export function useGuestSession(roomId, keyString) {
  const [snapshot, setSnapshot] = useState(null);
  const [download, setDownload] = useState(null); // { url, name } once verified
  const [error, setError] = useState('');

  useEffect(() => {
    if (!keyString) {
      setError('This link is missing its decryption key (#key=...). Ask the sender for the full link.');
      return undefined;
    }

    let cancelled = false;
    let session = null;
    let objectUrl = null;

    importKey(keyString)
      .then((key) => {
        if (cancelled) return;
        session = new SwarmSession({
          role: 'guest',
          roomId,
          // Same id after a refresh, so the swarm treats us as a returning peer.
          peerId: tabPeerId(roomId, () => randomId(8)),
          key,
          onUpdate: setSnapshot,
          onComplete: (file, { resumed }) => {
            objectUrl = URL.createObjectURL(file);
            setDownload({ url: objectUrl, name: file.name });
            // Don't download a second time when reopening a finished transfer.
            if (!resumed) triggerDownload(objectUrl, file.name);
          },
        });
        session.start();
      })
      .catch((err) => setError(err.message || 'Invalid link.'));

    return () => {
      cancelled = true;
      session?.destroy();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [roomId, keyString]);

  return { snapshot, download, error };
}
