import type { Session } from '../transcript/model';

const DB_NAME = 'motesskrivaren';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks'); // key: `${sessionId}:${index}`
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const db = {
  saveSession: (s: Session) => tx('sessions', 'readwrite', (st) => st.put(s)).then(() => undefined),
  getSession: (id: string) => tx<Session | undefined>('sessions', 'readonly', (st) => st.get(id)),
  listSessions: () =>
    tx<Session[]>('sessions', 'readonly', (st) => st.getAll()).then((all) =>
      all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    ),
  deleteSession: async (id: string) => {
    await tx('sessions', 'readwrite', (st) => st.delete(id));
    await db.deleteChunks(id);
  },
  deleteChunks: async (id: string) => {
    const keys = await tx<IDBValidKey[]>('chunks', 'readonly', (st) =>
      st.getAllKeys(IDBKeyRange.bound(`${id}:`, `${id}:￿`)),
    );
    for (const k of keys) await tx('chunks', 'readwrite', (st) => st.delete(k));
  },
  saveChunk: (sessionId: string, index: number, blob: Blob) =>
    tx('chunks', 'readwrite', (st) => st.put(blob, `${sessionId}:${String(index).padStart(6, '0')}`)).then(() => undefined),
  getChunk: (sessionId: string, index: number) =>
    tx<Blob | undefined>('chunks', 'readonly', (st) => st.get(`${sessionId}:${String(index).padStart(6, '0')}`)),
  listChunks: (sessionId: string) =>
    tx<Blob[]>('chunks', 'readonly', (st) => st.getAll(IDBKeyRange.bound(`${sessionId}:`, `${sessionId}:￿`))),
};

/** Ask the browser not to evict our audio while a long meeting is being recorded. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignore */
  }
  return false;
}
