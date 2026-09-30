import { useCallback, useEffect, useRef, useState } from 'react';
import { buildShareUrl, exportKey, generateKey, importKey } from '../lib/crypto.js';
import { buildManifest } from '../lib/manifest.js';
import { randomId } from '../lib/signaling.js';
import { SwarmSession } from '../lib/swarm.js';

function triggerDownload(url, fileName) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

/** Sender page: hash the file, create a key and room, then seed it. */
export function useHostSession() {
  const [snapshot, setSnapshot] = useState(null);
  const [preparing, setPreparing] = useState(null); // 0..1 while hashing
  const [shareUrl, setShareUrl] = useState('');
  const [error, setError] = useState('');
  const sessionRef = useRef(null);

  useEffect(() => () => sessionRef.current?.destroy(), []);

  const stop = useCallback(() => {
    sessionRef.current?.destroy();
    sessionRef.current = null;
    setSnapshot(null);
    setShareUrl('');
  }, []);

  const share = useCallback(
    async (file) => {
      stop();
      setError('');
      setPreparing(0);
      try {
        const manifest = await buildManifest(file, setPreparing);
        // Fresh key per room: it only lives in this tab and in the link's #fragment.
        const key = await generateKey();
        const roomId = randomId(4);
        const session = new SwarmSession({
          role: 'host',
          roomId,
          peerId: randomId(8),
          key,
          file,
          manifest,
          onUpdate: setSnapshot,
        });
        sessionRef.current = session;
        setShareUrl(buildShareUrl(roomId, await exportKey(key)));
        session.start();
      } catch (err) {
        setError(err.message || 'Could not prepare the file.');
      } finally {
        setPreparing(null);
      }
    },
    [stop],
  );

  return { snapshot, preparing, shareUrl, error, share, stop };
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
          peerId: randomId(8),
          key,
          onUpdate: setSnapshot,
          onComplete: (file) => {
            objectUrl = URL.createObjectURL(file);
            setDownload({ url: objectUrl, name: file.name });
            triggerDownload(objectUrl, file.name);
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
