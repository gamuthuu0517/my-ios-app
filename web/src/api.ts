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

/** mp4 を取得する。onProgress には受信済みバイト数と全体サイズ（不明なら 0）を渡す */
export async function download(
  url: string,
  index: number | null,
  height: number | null,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ blob: Blob; name: string }> {
  const res = await post('/api/download', { url, index, height });
  const total = Number(res.headers.get('Content-Length')) || 0;
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : 'video.mp4';

  const reader = res.body?.getReader();
  if (!reader) return { blob: await res.blob(), name };
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  return { blob: new Blob(chunks as BlobPart[], { type: 'video/mp4' }), name };
}
