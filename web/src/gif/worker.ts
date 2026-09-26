/// <reference lib="webworker" />
// GIF の減色・ディザリング・圧縮を担当する Web Worker（画面を固まらせないため）
import { GIFEncoder, quantize } from 'gifenc';

type Palette = number[][];

interface InitMsg { type: 'init'; width: number; height: number; dither: boolean; samples: Uint8ClampedArray[] }
interface FrameMsg { type: 'frame'; data: Uint8ClampedArray; delayCs: number }
interface FinishMsg { type: 'finish' }
interface EstimateMsg {
  type: 'estimate';
  width: number;
  height: number;
  dither: boolean;
  pairs: [Uint8ClampedArray, Uint8ClampedArray][]; // 連続する2フレームの組
}
type Msg = InitMsg | FrameMsg | FinishMsg | EstimateMsg;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** 複数フレームから動画全体で共通の 255 色パレットを作る（1色は透過用に残す） */
function buildPalette(samples: Uint8ClampedArray[]): Palette {
  const total = samples.reduce((n, s) => n + s.length, 0);
  // 大きすぎると遅いので間引いて集める
  const step = Math.max(1, Math.floor(total / 4 / 400_000));
  const px: number[] = [];
  for (const s of samples) for (let i = 0; i < s.length; i += 4 * step) px.push(s[i], s[i + 1], s[i + 2], 255);
  return quantize(new Uint8Array(px), 255, { format: 'rgb565' });
}

/** 近い色の検索を 5-6-5 ビットで表を引いて高速化する */
function makeLookup(palette: Palette) {
  const lut = new Int16Array(65536).fill(-1);
  return (r: number, g: number, b: number): number => {
    const key = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    let idx = lut[key];
    if (idx >= 0) return idx;
    let best = 1e9;
    idx = 0;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    lut[key] = idx;
    return idx;
  };
}

class FrameEncoder {
  private gif = GIFEncoder();
  private prev: Uint8Array | null = null;
  private lookup: (r: number, g: number, b: number) => number;
  private transparent: number;
  private first = true;

  constructor(private w: number, private h: number, private palette: Palette, private dither: boolean) {
    this.lookup = makeLookup(palette);
    this.transparent = palette.length; // パレットの外側の番号を透過に使う
  }

  private toIndex(rgba: Uint8ClampedArray): Uint8Array {
    const { w, h, palette, lookup } = this;
    const out = new Uint8Array(w * h);
    if (!this.dither) {
      for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = lookup(rgba[p], rgba[p + 1], rgba[p + 2]);
      return out;
    }
    // Floyd–Steinberg 法（誤差を周囲に振り分けて色の段差を目立たなくする）
    const err = new Float32Array((w + 2) * 2 * 3);
    let cur = 0;
    for (let y = 0; y < h; y++) {
      const next = 1 - cur;
      err.fill(0, next * (w + 2) * 3, (next + 1) * (w + 2) * 3);
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const e = (cur * (w + 2) + x + 1) * 3;
        const r = clamp(rgba[p] + err[e]);
        const g = clamp(rgba[p + 1] + err[e + 1]);
        const b = clamp(rgba[p + 2] + err[e + 2]);
        const idx = lookup(r, g, b);
        out[y * w + x] = idx;
        const c = palette[idx];
        const er = r - c[0], eg = g - c[1], eb = b - c[2];
        spread(err, (cur * (w + 2) + x + 2) * 3, er, eg, eb, 7 / 16);
        spread(err, (next * (w + 2) + x) * 3, er, eg, eb, 3 / 16);
        spread(err, (next * (w + 2) + x + 1) * 3, er, eg, eb, 5 / 16);
        spread(err, (next * (w + 2) + x + 2) * 3, er, eg, eb, 1 / 16);
      }
      cur = next;
    }
    return out;
  }

  /** 1フレーム追加して、増えたバイト数を返す */
  add(rgba: Uint8ClampedArray, delayCs: number): number {
    const before = this.gif.bytesView().length;
    const index = this.toIndex(rgba);
    let frame = index;
    // 前のフレームと同じ画素は透過にして容量を減らす（見た目は変わらない）
    if (this.prev) {
      frame = new Uint8Array(index.length);
      for (let i = 0; i < index.length; i++) frame[i] = index[i] === this.prev[i] ? this.transparent : index[i];
    }
    this.gif.writeFrame(frame, this.w, this.h, {
      palette: this.first ? [...this.palette, [0, 0, 0]] : undefined,
      delay: delayCs * 10,
      repeat: 0, // 無限ループ
      transparent: !this.first,
      transparentIndex: this.transparent,
      dispose: 1, // 前のフレームを残した上に重ねる
    });
    this.prev = index;
    this.first = false;
    return this.gif.bytesView().length - before;
  }

  finish(): Uint8Array {
    this.gif.finish();
    return this.gif.bytes();
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function spread(err: Float32Array, i: number, r: number, g: number, b: number, k: number) {
  err[i] += r * k;
  err[i + 1] += g * k;
  err[i + 2] += b * k;
}

let enc: FrameEncoder | null = null;

ctx.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      enc = new FrameEncoder(m.width, m.height, buildPalette(m.samples), m.dither);
      ctx.postMessage({ type: 'ready' });
    } else if (m.type === 'frame') {
      enc!.add(m.data, m.delayCs);
      ctx.postMessage({ type: 'frameDone' });
    } else if (m.type === 'finish') {
      const bytes = enc!.finish();
      enc = null;
      ctx.postMessage({ type: 'done', bytes }, [bytes.buffer]);
    } else if (m.type === 'estimate') {
      const palette = buildPalette(m.pairs.flat());
      let firstSize = 0;
      let diffTotal = 0;
      m.pairs.forEach(([a, b], i) => {
        const est = new FrameEncoder(m.width, m.height, palette, m.dither);
        const s1 = est.add(a, 3);
        const s2 = est.add(b, 3);
        if (i === 0) firstSize = s1;
        diffTotal += s2;
      });
      ctx.postMessage({ type: 'estimate', firstFrame: firstSize, perFrame: diffTotal / m.pairs.length });
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message });
  }
};
