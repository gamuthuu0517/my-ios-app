// 画面の切り抜き範囲を指定する枠（プレビュー動画の上に重ねる）
import { h } from '../dom';
import type { Rect } from '../gif/frames';

export const ASPECTS: { label: string; value: number | null | 'source' }[] = [
  { label: '自由', value: null },
  { label: '元の比率', value: 'source' },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 },
];

const MIN = 16; // 最小サイズ（元動画の画素）

export class Cropper {
  overlay: HTMLElement;
  private box: HTMLElement;
  rect: Rect;
  private aspect: number | null = null;

  constructor(
    private srcW: number,
    private srcH: number,
    initial: Rect | null,
    private onChange: (r: Rect) => void,
  ) {
    this.rect = initial ?? { x: 0, y: 0, w: srcW, h: srcH };
    const corners = ['nw', 'ne', 'sw', 'se'].map((c) => {
      const el = h('div', { class: `crop-handle ${c}` });
      this.bindDrag(el, c);
      return el;
    });
    this.box = h('div', { class: 'crop-box' }, h('div', { class: 'crop-grid' }), ...corners);
    this.bindDrag(this.box, 'move');
    this.overlay = h('div', { class: 'crop-overlay' }, this.box);
    this.layout();
  }

  setAspect(a: number | null | 'source'): void {
    this.aspect = a === 'source' ? this.srcW / this.srcH : a;
    if (this.aspect) {
      // 今の枠の中心を保ったまま、比率に合う最大の大きさにする
      const r = this.rect;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      let w = r.w;
      let hh = w / this.aspect;
      if (hh > r.h) {
        hh = r.h;
        w = hh * this.aspect;
      }
      if (w < MIN * 4 || hh < MIN * 4) {
        w = Math.min(this.srcW, this.srcH * this.aspect);
        hh = w / this.aspect;
      }
      this.set({ x: cx - w / 2, y: cy - hh / 2, w, h: hh });
    }
  }

  reset(): void {
    this.aspect = null;
    this.set({ x: 0, y: 0, w: this.srcW, h: this.srcH });
  }

  private set(r: Rect): void {
    // 画素単位（大きさは偶数）にそろえてから、動画の内側に収める
    const w = Math.min(this.srcW, Math.max(MIN, Math.round(r.w / 2) * 2));
    const hh = Math.min(this.srcH, Math.max(MIN, Math.round(r.h / 2) * 2));
    const x = Math.round(Math.min(this.srcW - w, Math.max(0, r.x)));
    const y = Math.round(Math.min(this.srcH - hh, Math.max(0, r.y)));
    this.rect = { x, y, w, h: hh };
    this.layout();
    this.onChange(this.rect);
  }

  private layout(): void {
    const r = this.rect;
    Object.assign(this.box.style, {
      left: `${(r.x / this.srcW) * 100}%`,
      top: `${(r.y / this.srcH) * 100}%`,
      width: `${(r.w / this.srcW) * 100}%`,
      height: `${(r.h / this.srcH) * 100}%`,
    });
  }

  private bindDrag(el: HTMLElement, mode: string): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const area = this.overlay.getBoundingClientRect();
      const sx = this.srcW / area.width; // 画面上の 1px が元動画の何画素か
      const sy = this.srcH / area.height;
      const start = { ...this.rect };
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - x0) * sx;
        const dy = (ev.clientY - y0) * sy;
        if (mode === 'move') {
          this.set({ ...start, x: start.x + dx, y: start.y + dy });
          return;
        }
        // 角のハンドル：反対側の角を固定して大きさを変える
        const left = mode.includes('w');
        const top = mode.includes('n');
        const fx = left ? start.x + start.w : start.x;
        const fy = top ? start.y + start.h : start.y;
        let w = Math.max(MIN, left ? start.w - dx : start.w + dx);
        let hh = Math.max(MIN, top ? start.h - dy : start.h + dy);
        w = Math.min(w, left ? fx : this.srcW - fx);
        hh = Math.min(hh, top ? fy : this.srcH - fy);
        if (this.aspect) {
          if (w / hh > this.aspect) w = hh * this.aspect;
          else hh = w / this.aspect;
        }
        this.set({ x: left ? fx - w : fx, y: top ? fy - hh : fy, w, h: hh });
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
}
