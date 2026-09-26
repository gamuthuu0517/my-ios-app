import { loadSettings } from './settings';

export interface Quality {
  height: number;
  h264: boolean;
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

export class ApiError extends Error {}

function config() {
  const s = loadSettings();
  if (!s.serverUrl || !s.passphrase) throw new ApiError('設定画面でサーバーURLと合言葉を入力してください');
  return s;
}

async function post(path: string, body: unknown): Promise<Response> {
  const s = config();
  let res: Response;
  try {
    res = await fetch(`${s.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Passphrase': s.passphrase },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('サーバーに接続できません。電波状況とサーバーURLを確認してください');
  }
  if (res.status === 401) throw new ApiError('合言葉が正しくありません（設定画面で確認してください）');
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail, () => null);
    throw new ApiError(typeof detail === 'string' ? detail : `サーバーエラー（${res.status}）`);
  }
  return res;
}

export async function extract(url: string): Promise<ExtractResult> {
  return (await post('/api/extract', { url })).json();
}

export type FetchStage = 'prepare' | 'download' | 'convert' | 'finalize' | 'receive';
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
      body: JSON.stringify({ url, index, height }),
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
