// トリミング用タイムライン：両端のハンドル、ピンチ/ボタンで拡大、1コマ送り、数値入力
import { h } from '../dom';

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export function parseTime(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d*)?)\s*$/.exec(s);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

export interface TrimmerOptions {
  duration: number;
  frameStep: number; // 1コマの長さ（秒）
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
  onScrub: (t: number) => void; // ハンドル操作中のプレビュー
}

export class Trimmer {
  el: HTMLElement;
  start: number;
  end: number;
  private zoom = 1;
  private wrap: HTMLElement;
  private track: HTMLElement;
  private sel: HTMLElement;
  private dimL: HTMLElement;
  private dimR: HTMLElement;
  private hStart: HTMLElement;
  private hEnd: HTMLElement;
  private playhead: HTMLElement;
  private strip: HTMLElement;
  private zoomLabel: HTMLElement;
  private inStart: HTMLInputElement;
  private inEnd: HTMLInputElement;

  constructor(private o: TrimmerOptions) {
    this.start = o.start;
    this.end = o.end;

    this.strip = h('div', { class: 'tl-strip' });
    this.dimL = h('div', { class: 'tl-dim' });
    this.dimR = h('div', { class: 'tl-dim' });
    this.sel = h('div', { class: 'tl-sel' });
    this.hStart = h('div', { class: 'tl-handle start' }, h('span'));
    this.hEnd = h('div', { class: 'tl-handle end' }, h('span'));
    this.playhead = h('div', { class: 'tl-playhead' });
    this.track = h('div', { class: 'tl-track' }, this.strip, this.dimL, this.dimR, this.sel, this.playhead, this.hStart, this.hEnd);
    this.wrap = h('div', { class: 'tl-wrap' }, this.track);

    this.zoomLabel = h('span', { class: 'muted small' });
    const zoomBar = h(
      'div',
      { class: 'tl-zoom' },
      h('span', { class: 'muted small' }, '2本指で広げると拡大'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => this.setZoom(this.zoom / 2) }, '－'),
        this.zoomLabel,
        h('button', { class: 'btn small', onclick: () => this.setZoom(this.zoom * 2) }, '＋'),
      ),
    );

    this.inStart = h('input', { class: 'input time', inputmode: 'decimal' });
    this.inEnd = h('input', { class: 'input time', inputmode: 'decimal' });
    this.inStart.addEventListener('change', () => this.fromInput('start'));
    this.inEnd.addEventListener('change', () => this.fromInput('end'));
    const stepRow = (label: string, which: 'start' | 'end', input: HTMLInputElement) =>
      h(
        'div',
        { class: 'tl-step' },
        h('span', { class: 'label' }, label),
        h('button', { class: 'btn small', onclick: () => this.step(which, -1), 'aria-label': `${label}を1コマ戻す` }, '◀'),
        input,
        h('button', { class: 'btn small', onclick: () => this.step(which, 1), 'aria-label': `${label}を1コマ進める` }, '▶'),
      );

    this.el = h('div', { class: 'trimmer' }, this.wrap, zoomBar, stepRow('開始', 'start', this.inStart), stepRow('終了', 'end', this.inEnd));

    this.bindDrag(this.hStart, 'start');
    this.bindDrag(this.hEnd, 'end');
    this.bindPinch();
    requestAnimationFrame(() => this.layout());
  }

  /** 表示中の端に動画のサムネイル（コマ）を並べる */
  setThumbnails(images: HTMLCanvasElement[]): void {
    this.strip.replaceChildren(...images.map((c) => (c.classList.add('tl-thumb'), c)));
  }

  setPlayhead(t: number | null): void {
    this.playhead.classList.toggle('hidden', t === null);
    if (t !== null) this.playhead.style.left = `${(t / this.o.duration) * 100}%`;
  }

  private maxZoom(): number {
    // 1コマが 14px 以上になるまで拡大できる
    const w = this.wrap.clientWidth || 320;
    return Math.max(1, (this.o.duration / this.o.frameStep) * 14 / w);
  }

  private setZoom(z: number, anchorT?: number, anchorX?: number): void {
    const old = this.zoom;
    this.zoom = Math.min(this.maxZoom(), Math.max(1, z));
    const w = this.wrap.clientWidth;
    // 拡大しても、基準の時刻（未指定なら画面中央）が同じ位置に来るようにする
    const t = anchorT ?? ((this.wrap.scrollLeft + w / 2) / (w * old)) * this.o.duration;
    const x = anchorX ?? w / 2;
    this.track.style.width = `${this.zoom * 100}%`;
    this.wrap.scrollLeft = (t / this.o.duration) * w * this.zoom - x;
    this.zoomLabel.textContent = `×${this.zoom < 10 ? this.zoom.toFixed(1) : Math.round(this.zoom)}`;
  }

  private layout(): void {
    const d = this.o.duration;
    const a = (this.start / d) * 100;
    const b = (this.end / d) * 100;
    this.dimL.style.cssText = `left:0;width:${a}%`;
    this.dimR.style.cssText = `left:${b}%;right:0`;
    this.sel.style.cssText = `left:${a}%;width:${b - a}%`;
    this.hStart.style.left = `${a}%`;
    this.hEnd.style.left = `${b}%`;
    if (document.activeElement !== this.inStart) this.inStart.value = formatTime(this.start);
    if (document.activeElement !== this.inEnd) this.inEnd.value = formatTime(this.end);
    if (!this.zoomLabel.textContent) this.setZoom(1);
  }

  set(start: number, end: number, notify = true): void {
    const min = this.o.frameStep;
    start = Math.max(0, Math.min(start, this.o.duration - min));
    end = Math.min(this.o.duration, Math.max(end, start + min));
    this.start = start;
    this.end = end;
    this.layout();
    if (notify) this.o.onChange(start, end);
  }

  private step(which: 'start' | 'end', dir: number): void {
    const d = this.o.frameStep * dir;
    if (which === 'start') {
      this.set(this.start + d, this.end);
      this.o.onScrub(this.start);
    } else {
      this.set(this.start, this.end + d);
      this.o.onScrub(Math.max(0, this.end - this.o.frameStep / 2));
    }
  }

  private fromInput(which: 'start' | 'end'): void {
    const v = parseTime(which === 'start' ? this.inStart.value : this.inEnd.value);
    if (v === null) return this.layout();
    if (which === 'start') this.set(v, this.end);
    else this.set(this.start, v);
    this.o.onScrub(which === 'start' ? this.start : this.end);
  }

  private timeAt(clientX: number): number {
    const r = this.track.getBoundingClientRect();
    return Math.min(this.o.duration, Math.max(0, ((clientX - r.left) / r.width) * this.o.duration));
  }

  private bindDrag(el: HTMLElement, which: 'start' | 'end'): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      const move = (ev: PointerEvent) => {
        const t = this.timeAt(ev.clientX);
        // 1コマ単位にそろえる
        const snapped = Math.round(t / this.o.frameStep) * this.o.frameStep;
        if (which === 'start') this.set(Math.min(snapped, this.end - this.o.frameStep), this.end, false);
        else this.set(this.start, Math.max(snapped, this.start + this.o.frameStep), false);
        this.o.onScrub(which === 'start' ? this.start : Math.max(0, this.end - this.o.frameStep / 2));
      };
      const up = () => {
        el.classList.remove('active');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this.o.onChange(this.start, this.end);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  private bindPinch(): void {
    let d0 = 0;
    let z0 = 1;
    let tMid = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midX = (t: TouchList) => (t[0].clientX + t[1].clientX) / 2;
    this.wrap.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 2) return;
        d0 = dist(e.touches);
        z0 = this.zoom;
        tMid = this.timeAt(midX(e.touches));
      },
      { passive: true },
    );
    this.wrap.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length !== 2 || !d0) return;
        e.preventDefault();
        const x = midX(e.touches) - this.wrap.getBoundingClientRect().left;
        this.setZoom((z0 * dist(e.touches)) / d0, tMid, x);
      },
      { passive: false },
    );
    this.wrap.addEventListener('touchend', () => (d0 = 0));
  }
}
