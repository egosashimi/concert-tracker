// Ticket wallet storage: screenshots, PDFs and .pkpass files live in IndexedDB on this device.
// Event records only hold metadata ({ id, name, type, size }); files are not synced to the Gist.

const DB_NAME = 'encore-files';
const STORE = 'files';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage aborted (out of space?)'));
  }));
}

export function putFile(rec) {
  return tx('readwrite', (s) => { s.put(rec); });
}

export function getFile(id) {
  return tx('readonly', (s) => s.get(id));
}

export function deleteFile(id) {
  return tx('readwrite', (s) => { s.delete(id); });
}

export function allFiles() {
  return tx('readonly', (s) => s.getAll());
}

export async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

/** Downscale very large photos so a few tickets don't eat the storage quota. */
export async function shrinkImage(file, maxDim = 2200) {
  if (!/^image\/(jpeg|png|webp|heic|heif)/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 2.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
    return blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}
