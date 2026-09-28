import { loadSettings } from './settings';
import { acceptedCodecs } from './codecs';

export interface Quality {
  height: number;
  direct?: boolean; // 変換なしで端末に渡せる
  h264: boolean; // 旧サーバー互換（direct と同じ意味）
}
export interface Item {
  index: number | null;
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  width?: number;
  height?: number;
  qualities: Quality[];
}
export interface ExtractResult {
  title?: string;
  extractor?: string;
  items: Item[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

function config() {
  const s = loadSettings();
  if (!s.serverUrl || !s.passphrase) throw new ApiError('設定画面でサーバーURLと合言葉を入力してください');
  return s;
}

async function post(path: string, body: unknown): Promise<Response> {
  return request('POST', path, body);
}

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  const s = config();
  let res: Response;
  try {
    res = await fetch(`${s.serverUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Passphrase': s.passphrase },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('サーバーに接続できません。電波状況とサーバーURLを確認してください');
  }
  if (res.status === 401) throw new ApiError('合言葉が正しくありません（設定画面で確認してください）', 401);
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail, () => null);
    throw new ApiError(typeof detail === 'string' ? detail : `サーバーエラー（${res.status}）`, res.status);
  }
  return res;
}

export async function extract(url: string): Promise<ExtractResult> {
  return (await post('/api/extract', { url, accept: await acceptedCodecs() })).json();
}

export type FetchStage = 'queued' | 'prepare' | 'download' | 'convert' | 'finalize' | 'store' | 'receive';
export interface FetchProgress {
  stage: FetchStage;
  pct: number | null;
  part?: number;
}

/**
 * mp4 を取得する。サーバーは進捗を JSON 行で送り続け、最後に
 * {"type":"file","size":N} の行と mp4 本体 N バイトを送ってくる。
 */
export async function fetchVideo(
  url: string,
  index: number | null,
  height: number | null,
  onProgress: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; name: string }> {
  const s = config();
  let res: Response;
  try {
    res = await fetch(`${s.serverUrl}/api/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passphrase': s.passphrase },
      body: JSON.stringify({ url, index, height, accept: await acceptedCodecs() }),
      signal,
    });
  } catch {
    throw new ApiError('サーバーに接続できません。電波状況とサーバーURLを確認してください');
  }
  if (res.status === 401) throw new ApiError('合言葉が正しくありません（設定画面で確認してください）');
  if (!res.ok || !res.body) throw new ApiError(`サーバーエラー（${res.status}）`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = new Uint8Array(0);
  let file: { name: string; size: number } | null = null;
  const parts: Uint8Array[] = [];
  let received = 0;

  const append = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (file) {
        parts.push(value);
        received += value.length;
        onProgress({ stage: 'receive', pct: Math.round((received / file.size) * 100) });
        continue;
      }
      pending = append(pending, value);
      let nl: number;
      while (!file && (nl = pending.indexOf(10)) >= 0) {
        const line = decoder.decode(pending.subarray(0, nl));
        pending = pending.subarray(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'progress') onProgress({ stage: ev.stage, pct: ev.pct ?? null, part: ev.part });
        else if (ev.type === 'error') throw new ApiError(ev.detail);
        else if (ev.type === 'file') {
          file = { name: ev.name, size: ev.size };
          if (pending.length) {
            parts.push(pending);
            received += pending.length;
          }
          onProgress({ stage: 'receive', pct: file.size ? Math.round((received / file.size) * 100) : 0 });
        }
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('通信が途中で切れました。もう一度お試しください');
  }
  if (!file || received < file.size) throw new ApiError('通信が途中で切れました。もう一度お試しください');
  return { blob: new Blob(parts as BlobPart[], { type: 'video/mp4' }), name: file.name };
}

// ---------------------------------------------------------------------------
// サーバー側ジョブ（アプリを閉じても処理が続き、完了時に通知が届く）

export interface JobStatus {
  id: string;
  type: 'download' | 'gif';
  title: string;
  state: 'queued' | 'running' | 'done' | 'error';
  stage: string;
  pct: number | null;
  part?: number;
  error?: string;
  result?: { object: string; name: string; size: number; contentType: string };
}

export interface GifJobParams {
  start: number;
  end: number;
  fps: number;
  width: number;
  height: number;
  dither: boolean;
  crop: { x: number; y: number; w: number; h: number } | null;
}

export type GifSource = { job: string } | { upload: string };

export async function startDownloadJob(
  url: string,
  index: number | null,
  height: number | null,
  title: string,
  notify: PushSubscriptionJSON | null,
): Promise<JobStatus> {
  return (await post('/api/jobs/download', { url, index, height, title, notify, accept: await acceptedCodecs() })).json();
}

export async function startGifJob(source: GifSource, params: GifJobParams, name: string, notify: PushSubscriptionJSON | null): Promise<JobStatus> {
  return (await post('/api/jobs/gif', { source, params, name, notify })).json();
}

export async function jobStatus(id: string): Promise<JobStatus> {
  return (await request('GET', `/api/jobs/${id}`)).json();
}

export async function sourceExists(source: GifSource): Promise<boolean> {
  return (await post('/api/sources/check', source)).json().then((r) => !!r.exists);
}

export async function pushKey(): Promise<string> {
  return (await request('GET', '/api/push/key')).json().then((r) => r.key);
}

/** 完成したファイルを受け取る（進み具合つき） */
export async function jobFile(id: string, onProgress: (ratio: number) => void): Promise<Blob> {
  const res = await request('GET', `/api/jobs/${id}/file`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const type = res.headers.get('Content-Type') ?? 'application/octet-stream';
  const reader = res.body?.getReader();
  if (!reader) return res.blob();
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total) onProgress(got / total);
    }
  } catch {
    throw new ApiError('受信が途中で切れました。もう一度お試しください');
  }
  if (total && got < total) throw new ApiError('受信が途中で切れました。もう一度お試しください');
  return new Blob(parts as BlobPart[], { type });
}

/** 動画をサーバーの一時保管場所へ直接アップロードする（大きなファイルでも可） */
export async function uploadVideo(blob: Blob, onProgress: (ratio: number) => void): Promise<string> {
  const type = blob.type || 'video/mp4';
  const { id, url } = await (await post('/api/uploads', { size: blob.size, contentType: type })).json();
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(`アップロードに失敗しました（${xhr.status}）`)));
    xhr.onerror = () => reject(new ApiError('アップロードに失敗しました。電波状況を確認してください'));
    xhr.send(blob);
  });
  return id;
}
