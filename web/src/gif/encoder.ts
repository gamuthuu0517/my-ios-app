// GIF 変換の全体の流れ（フレーム取り出し → Worker で減色・圧縮）
import type { FrameGrabber } from './frames';
import { frameDelaysCs, frameTimes } from './timing';

export interface GifOptions {
  start: number;
  end: number;
  fps: number;
  width: number;
  height: number;
  dither: boolean;
}

function newWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}

function waitFor<T>(w: Worker, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data.type === type) {
        w.removeEventListener('message', on);
        resolve(e.data as T);
      } else if (e.data.type === 'error') {
        w.removeEventListener('message', on);
        reject(new Error(e.data.message));
      }
    };
    w.addEventListener('message', on);
  });
}

export class Cancelled extends Error {}

/** 予測容量（バイト）。選択範囲から連続2コマの組を数か所取り出して試し変換し、全体に換算する */
export async function estimateGifSize(g: FrameGrabber, o: GifOptions, isStale: () => boolean): Promise<number | null> {
  const count = frameTimes(o.start, o.end, o.fps).length;
  const points = 4;
  const pairs: [Uint8ClampedArray, Uint8ClampedArray][] = [];
  const span = Math.max(0, o.end - o.start - 1 / o.fps);
  for (let i = 0; i < points; i++) {
    const t = o.start + (span * (i + 0.5)) / points;
    const a = await g.grab(t, o.width, o.height);
    const b = await g.grab(Math.min(o.end - 0.001, t + 1 / o.fps), o.width, o.height);
    pairs.push([a, b]);
    if (isStale()) return null;
  }
  const w = newWorker();
  try {
    w.postMessage({ type: 'estimate', width: o.width, height: o.height, dither: o.dither, pairs });
    const r = await waitFor<{ firstFrame: number; perFrame: number }>(w, 'estimate');
    return Math.round(r.firstFrame + r.perFrame * Math.max(0, count - 1) + 32);
  } finally {
    w.terminate();
  }
}

/** GIF を作る。onProgress には 0〜1 を渡す */
export async function encodeGif(
  g: FrameGrabber,
  o: GifOptions,
  onProgress: (ratio: number) => void,
  signal: { cancelled: boolean },
): Promise<Blob> {
  const times = frameTimes(o.start, o.end, o.fps);
  const delays = frameDelaysCs(times.length, o.fps);
  const w = newWorker();
  try {
    // 動画全体で共通のパレットを作るため、範囲内から8コマを先に取り出す
    const samples: Uint8ClampedArray[] = [];
    const n = Math.min(8, times.length);
    for (let i = 0; i < n; i++) {
      samples.push(await g.grab(times[Math.floor(((i + 0.5) * times.length) / n)], o.width, o.height));
      if (signal.cancelled) throw new Cancelled();
    }
    w.postMessage({ type: 'init', width: o.width, height: o.height, dither: o.dither, samples });
    await waitFor(w, 'ready');

    // フレームの取り出しと Worker 側の処理を並行させる（同時に最大3コマまで）
    let inFlight = 0;
    let done = 0;
    let wake: (() => void) | null = null;
    let failure: Error | null = null;
    w.addEventListener('message', (e) => {
      if (e.data.type === 'frameDone') {
        inFlight--;
        done++;
        onProgress(0.05 + (0.95 * done) / times.length);
        wake?.();
      } else if (e.data.type === 'error') {
        failure = new Error(e.data.message);
        wake?.();
      }
    });
    onProgress(0.05);
    for (let i = 0; i < times.length; i++) {
      if (signal.cancelled) throw new Cancelled();
      if (failure) throw failure;
      const data = await g.grab(times[i], o.width, o.height);
      while (inFlight >= 3 && !failure) await new Promise<void>((r) => (wake = r));
      inFlight++;
      w.postMessage({ type: 'frame', data, delayCs: delays[i] }, [data.buffer]);
    }
    while (inFlight > 0 && !failure) await new Promise<void>((r) => (wake = r));
    if (failure) throw failure;
    w.postMessage({ type: 'finish' });
    const { bytes } = await waitFor<{ bytes: Uint8Array }>(w, 'done');
    return new Blob([bytes as BlobPart], { type: 'image/gif' });
  } finally {
    w.terminate();
  }
}
