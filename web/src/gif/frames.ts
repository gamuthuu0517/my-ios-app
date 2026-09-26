// 動画の指定時刻のフレームを取り出す（<video> を1コマずつシークして描画する）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FrameGrabber {
  readonly video: HTMLVideoElement;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private url: string;

  private constructor(blob: Blob) {
    this.url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = this.url;
    // iOS は画面上にない動画のコマを描かないことがあるため、見えない形で置いておく
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.append(v);
    this.video = v;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  static async open(blob: Blob): Promise<FrameGrabber> {
    const g = new FrameGrabber(blob);
    const v = g.video;
    await new Promise<void>((resolve, reject) => {
      if (v.readyState >= 1) return resolve();
      v.addEventListener('loadedmetadata', () => resolve(), { once: true });
      v.addEventListener('error', () => reject(new Error('この動画は読み込めません')), { once: true });
    });
    // iOS は一度再生しないとデータを読み込まないことがある
    try {
      await v.play();
    } catch {
      // 再生できなくてもシークで読み込まれる
    }
    v.pause();
    return g;
  }

  get width(): number {
    return this.video.videoWidth;
  }
  get height(): number {
    return this.video.videoHeight;
  }
  get duration(): number {
    return this.video.duration;
  }

  async seek(t: number): Promise<void> {
    const v = this.video;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        v.removeEventListener('seeked', done);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      v.addEventListener('seeked', done);
      v.currentTime = t;
    });
    // 新しいコマが実際に表示されるまで待つ（古いコマを描いてしまうのを防ぐ）
    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number })
      .requestVideoFrameCallback;
    if (rvfc) await Promise.race([new Promise<void>((r) => rvfc.call(v, () => r())), sleep(60)]);
  }

  /** 時刻 t のフレームを w×h に縮小した RGBA で返す */
  async grab(t: number, w: number, h: number): Promise<Uint8ClampedArray> {
    await this.seek(t);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.video, 0, 0, w, h);
    return this.ctx.getImageData(0, 0, w, h).data;
  }

  close(): void {
    this.video.remove();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
