import { emitMediaChange } from './lifecycle';

// アプリ内に保存する動画・GIF（IndexedDB）

export interface MediaRecord {
  id: string;
  kind: 'video' | 'gif';
  blob: Blob;
  name: string;
  title: string;
  platform?: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
  savedToPhotos?: boolean;
  thumb?: Blob;
  remote?: { job: string; at: number }; // サーバーの一時保管場所にある同じ動画（GIF 変換に使う・1日で消える）
  createdAt: number;
}

const DB_NAME = 'clipkit';
const STORE = 'media';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putMedia(r: MediaRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(r));
  emitMediaChange({ type: 'put', id: r.id });
}
export const getMedia = (id: string) => tx<MediaRecord | undefined>('readonly', (s) => s.get(id));
export async function deleteMedia(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
  emitMediaChange({ type: 'delete', id });
}
export async function clearMedia(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
  emitMediaChange({ type: 'clear' });
}

export async function listMedia(): Promise<MediaRecord[]> {
  const all = await tx<MediaRecord[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateMedia(id: string, patch: Partial<MediaRecord>): Promise<void> {
  const r = await getMedia(id);
  if (r) await putMedia({ ...r, ...patch });
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
