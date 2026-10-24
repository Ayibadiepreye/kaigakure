/**
 * Persistent download folder.
 *
 * Browsers do not let a web page create a folder anywhere it likes — that is a
 * deliberate security boundary. The closest thing that actually works is the
 * File System Access API: the user picks a folder once, we keep the permission,
 * and every later download is written straight into it with no Save As dialog.
 *
 * Support is Chrome/Edge (desktop and Android) and, from 2024, Safari 18.2+.
 * Everywhere else `isSupported()` is false and the app falls back to normal
 * browser downloads — nothing breaks, the user just gets Save As each time.
 */

const PERM = { mode: 'readwrite' };

export function isSaveFolderSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Restore a previously granted folder handle (kept in IndexedDB). */
export async function getSaveFolder() {
  if (!isSaveFolderSupported()) return null;
  try {
    const db = await openDb();
    const handle = await new Promise((resolve) => {
      const tx = db.transaction('handles', 'readonly');
      tx.objectStore('handles').get('saveFolder').onsuccess = (e) => resolve(e.target.result || null);
      tx.oncomplete = () => db.close();
    });
    if (!handle) return null;
    // Permission can be revoked by the browser at any time — re-verify.
    if ((await handle.queryPermission(PERM)) === 'granted') return handle;
    if ((await handle.requestPermission(PERM)) === 'granted') return handle;
    return null;
  } catch {
    return null;
  }
}

/** Ask the user to choose the folder downloads should land in. */
export async function pickSaveFolder() {
  if (!isSaveFolderSupported()) return null;
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  if ((await handle.queryPermission(PERM)) !== 'granted') {
    await handle.requestPermission(PERM);
  }
  const db = await openDb();
  await new Promise((resolve) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'saveFolder');
    tx.oncomplete = () => { db.close(); resolve(); };
  });
  return handle;
}

export async function forgetSaveFolder() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete('saveFolder');
      tx.oncomplete = () => { db.close(); resolve(); };
    });
  } catch {
    /* nothing stored */
  }
}

export function folderName(handle) {
  return handle?.name || null;
}

/**
 * Fetch a job file and write it into the folder. Returns the full path-ish
 * label on success, or null if the folder was unavailable.
 */
export async function saveToFolder(jobId, fileName) {
  const dir = await getSaveFolder();
  if (!dir) return null;

  const res = await fetch(`/api/jobs/${jobId}/file/${encodeURIComponent(fileName)}`);
  if (!res.ok) throw new Error(`Could not fetch ${fileName} (${res.status})`);
  const blob = await res.blob();

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return `${dir.name}/${fileName}`;
}

/**
 * Write a whole ZIP into the folder. The server can stream the zip; we pull it
 * as one blob because the File System Access API writes whole files.
 */
export async function saveZipToFolder(jobId, zipName) {
  const dir = await getSaveFolder();
  if (!dir) return null;

  const res = await fetch(`/api/jobs/${jobId}/zip`);
  if (!res.ok) throw new Error(`Could not fetch the zip (${res.status})`);
  const blob = await res.blob();

  const fileHandle = await dir.getFileHandle(zipName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return `${dir.name}/${zipName}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kaigakure', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
