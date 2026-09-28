import { FrameGrabber } from './gif/frames';

// 同時に何本も動画を開くと iPhone のメモリを圧迫するので1本ずつ作る
let chain: Promise<unknown> = Promise.resolve();

/**
 * 動画の先頭付近から縮小サムネイル（JPEG）を作る。失敗時は undefined。
 * iOS は画面外の動画を再生するまでコマを読み込まないため、GIF 変換と同じ仕組み
 * （見えない形で配置 → 一度再生 → シーク）でコマを取り出す。
 */
export function makeVideoThumb(blob: Blob, width = 320): Promise<Blob | undefined> {
  const run = chain.then(() => withTimeout(create(blob, width), 15000));
  chain = run.catch(() => undefined);
  return run.catch(() => undefined);
}

async function create(blob: Blob, width: number): Promise<Blob | undefined> {
  const g = await FrameGrabber.open(blob);
  try {
    const w = Math.min(width, g.width || width);
    const h = Math.max(1, Math.round(((g.height || 9) / (g.width || 16)) * w));
    const data = await g.grab(Math.min(0.5, (g.duration || 1) / 2), w, h);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
    return await new Promise<Blob | undefined>((r) => canvas.toBlob((b) => r(b ?? undefined), 'image/jpeg', 0.8));
  } finally {
    g.close();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}
