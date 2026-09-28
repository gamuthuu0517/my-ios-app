import { h, toast, formatBytes } from '../dom';
import { deleteMedia, getMedia, newId, putMedia } from '../db';
import { loadSettings } from '../settings';
import { shareFile } from '../share';
import { FrameGrabber } from '../gif/frames';
import { detectFps } from '../gif/mp4info';
import { Cancelled, encodeGif, estimateGifSize, type GifOptions } from '../gif/encoder';
import { frameTimes, outputSize } from '../gif/timing';
import { Trimmer, formatTime } from './trimmer';
import { runServerGif, serverSourceFor } from '../gifjobs';
import { ASPECTS, Cropper } from './cropper';
import type { Rect } from '../gif/frames';

const MAX_SEC = 30;

/** 画面を切り替えても続きから再開できるよう、変換中の状態は画面の外に持つ */
interface Session {
  blob: Blob;
  name: string;
  mediaId?: string; // アプリ内の動画から来た場合
  srcW: number;
  srcH: number;
  duration: number;
  srcFps: number | null;
  start: number;
  end: number;
  percent: number;
  fpsChoice: string; // 'auto' または数値
  dither: boolean;
  crop: Rect | null; // 画面の切り抜き（null は全体）
  cropEditing: boolean;
  editing: boolean; // false のときは変換結果だけを表示
  estimate?: { key: string; bytes: number | null };
  job?: { progress: number; label: string; cancel: { cancelled: boolean }; promise: Promise<void> };
  serverSource?: string | null; // サーバーで変換できる場合の元動画（undefined は確認中）
  result?: { blob: Blob; id: string; opts: GifOptions };
  error?: string;
}

let session: Session | null = null;
let grabber: FrameGrabber | null = null; // 予測・変換用（session と同じ動画）
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const progressListeners = new Set<() => void>();

// 予測と変換が同じ video を同時にシークしないよう、順番に使う
let grabberLock: Promise<unknown> = Promise.resolve();
function withGrabber<T>(fn: (g: FrameGrabber) => Promise<T>): Promise<T> {
  const run = grabberLock.then(() => {
    if (!grabber) throw new Error('動画が読み込まれていません');
    return fn(grabber);
  });
  grabberLock = run.catch(() => undefined);
  return run;
}

function hashParam(name: string): string | null {
  const q = location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get(name) : null;
}

function targetFps(s: Session): number {
  const src = s.srcFps ?? 30;
  if (s.fpsChoice === 'auto') return Math.min(30, Math.round(src * 100) / 100);
  return Math.min(Number(s.fpsChoice), src);
}

function options(s: Session): GifOptions {
  const base = s.crop ?? { x: 0, y: 0, w: s.srcW, h: s.srcH };
  const { w, h } = outputSize(base.w, base.h, s.percent);
  return { start: s.start, end: s.end, fps: targetFps(s), width: w, height: h, dither: s.dither, crop: s.crop };
}

async function openSource(blob: Blob, name: string, mediaId?: string): Promise<void> {
  if (session?.job) return toast('変換中です。終わってから選び直してください');
  grabber?.close();
  grabber = null;
  const g = await FrameGrabber.open(blob);
  const srcFps = await detectFps(blob);
  const s = loadSettings();
  session = {
    blob,
    name,
    mediaId,
    srcW: g.width,
    srcH: g.height,
    duration: g.duration,
    srcFps,
    start: 0,
    end: Math.min(g.duration, MAX_SEC),
    percent: s.gifScalePercent,
    fpsChoice: 'auto',
    dither: s.gifDither,
    crop: null,
    cropEditing: false,
    editing: true,
  };
  grabber = g;
  notify();
  if (mediaId) {
    const rec = await getMedia(mediaId);
    const src = await serverSourceFor(rec);
    if (session?.mediaId === mediaId) {
      session.serverSource = src;
      notify();
    }
  } else {
    session.serverSource = null;
  }
}

export function gifView(): HTMLElement {
  const root = h('section', { class: 'view' });
  const fileInput = h('input', { type: 'file', accept: 'video/*', class: 'hidden' });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      await openSource(f, f.name);
    } catch (e) {
      toast((e as Error).message);
    }
  });

  let mounted = false;
  requestAnimationFrame(() => (mounted = true));
  const render = () => {
    if (mounted && !root.isConnected) {
      listeners.delete(render);
      return;
    }
    root.replaceChildren(
      h('h1', {}, 'GIF変換'),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => fileInput.click() }, session ? '別の動画を選ぶ' : '写真から動画を選ぶ'),
          h('a', { class: 'btn', href: '#history' }, 'アプリ内の動画'),
        ),
        session
          ? h('div', { class: 'row between' },
              h('div', { class: 'muted small clamp' }, session.name),
              h('button', { class: 'btn small', onclick: () => closeSession() }, '閉じる'),
            )
          : h('p', { class: 'muted small' }, '写真アプリの動画、またはダウンロードした動画（履歴の「GIFにする」）を GIF に変換します。'),
        fileInput,
      ),
      session ? (session.result && !session.editing ? resultView(session) : editor(session)) : '',
    );
  };
  listeners.add(render);

  // 履歴の「GIFにする」から来た場合
  const id = hashParam('id');
  if (id && session?.mediaId !== id) {
    getMedia(id).then(async (r) => {
      if (!r) return;
      try {
        await openSource(r.blob, r.title, r.id);
      } catch (e) {
        toast((e as Error).message);
      }
    });
  }
  render();
  return root;
}

function editor(s: Session): HTMLElement {
  const box = h('div');
  const url = URL.createObjectURL(s.blob);
  const video = h('video', { src: url, class: 'stage-video', playsinline: true, muted: true, preload: 'auto' });

  // 画面の切り抜き：プレビューの上に枠を重ねる
  const cropLabel = h('span', { class: 'muted small' });
  const updateCropLabel = () => {
    const c = s.crop;
    cropLabel.textContent = c
      ? `${c.w}×${c.h}（元の ${Math.round(((c.w * c.h) / (s.srcW * s.srcH)) * 100)}%）`
      : '全体（切り抜きなし）';
  };
  const cropper = new Cropper(s.srcW, s.srcH, s.crop, (r) => {
    const full = r.x === 0 && r.y === 0 && r.w >= s.srcW - 1 && r.h >= s.srcH - 1;
    s.crop = full ? null : r;
    s.result = undefined;
    updateCropLabel();
    refresh();
  });
  const stage = h('div', { class: 'crop-stage' }, video, cropper.overlay);
  stage.style.aspectRatio = `${s.srcW} / ${s.srcH}`;
  stage.style.width = `min(100%, calc(50vh * ${s.srcW / s.srcH}))`;
  const setEditing = (on: boolean) => {
    s.cropEditing = on;
    cropper.overlay.classList.toggle('readonly', !on);
    cropper.overlay.classList.toggle('hidden', !on && !s.crop);
    editBtn.textContent = on ? '✓ 切り抜きを決定' : '切り抜き範囲を編集';
    editBtn.classList.toggle('primary', on);
    aspectRow.classList.toggle('hidden', !on);
  };
  const editBtn = h('button', { class: 'btn small', onclick: () => setEditing(!s.cropEditing) });
  const aspectRow = h(
    'div',
    { class: 'chips' },
    ...ASPECTS.map((a) => h('button', { class: 'btn small', onclick: () => cropper.setAspect(a.value) }, a.label)),
    h('button', { class: 'btn small danger', onclick: () => cropper.reset() }, 'リセット'),
  );
  let looping = false;

  // 選択範囲だけを繰り返し再生
  const playBtn = h('button', { class: 'btn small' }, '▶ 範囲を再生');
  const stopLoop = () => {
    looping = false;
    video.pause();
    playBtn.textContent = '▶ 範囲を再生';
  };
  playBtn.addEventListener('click', () => {
    if (looping) return stopLoop();
    looping = true;
    playBtn.textContent = '■ 停止';
    video.currentTime = s.start;
    void video.play();
  });
  video.addEventListener('timeupdate', () => {
    trimmer.setPlayhead(video.currentTime);
    if (looping && video.currentTime >= s.end) {
      video.currentTime = s.start;
      void video.play();
    }
  });

  const frameStep = 1 / (s.srcFps ?? 30);
  const trimmer = new Trimmer({
    duration: s.duration,
    frameStep,
    start: s.start,
    end: s.end,
    onChange: (a, b) => {
      s.start = a;
      s.end = b;
      s.result = undefined;
      refresh();
    },
    onScrub: (t) => {
      if (looping) stopLoop();
      video.currentTime = t;
      trimmer.setPlayhead(t);
      s.start = trimmer.start;
      s.end = trimmer.end;
      refreshSummary();
    },
  });
  void makeStrip(s.blob, s.duration, s.srcW, s.srcH).then((c) => trimmer.setThumbnails(c));

  // 変換設定
  const percent = h('input', { type: 'range', min: 1, max: 100, value: s.percent, class: 'slider' });
  const percentLabel = h('span', { class: 'label' });
  const setPercent = (p: number) => {
    s.percent = p;
    percent.value = String(p);
    refresh();
  };
  percent.addEventListener('input', () => setPercent(Number(percent.value)));
  const presets = h('div', { class: 'row' }, ...[100, 75, 50, 25].map((p) => h('button', { class: 'btn small', onclick: () => setPercent(p) }, `${p}%`)));

  const fps = h('select', { class: 'input select' });
  const src = s.srcFps ? Math.round(s.srcFps * 100) / 100 : null;
  fps.append(h('option', { value: 'auto' }, src ? `元のまま（${src}fps${src > 30 ? ' → 30fps' : ''}）` : '元のまま（上限30fps）'));
  for (const f of [30, 24, 20, 15, 10]) if (!src || f < src - 0.5) fps.append(h('option', { value: String(f) }, `${f}fps`));
  fps.value = s.fpsChoice;
  fps.addEventListener('change', () => {
    s.fpsChoice = fps.value;
    refresh();
  });

  const dither = h('input', { type: 'checkbox', checked: s.dither });
  dither.addEventListener('change', () => {
    s.dither = dither.checked;
    refresh();
  });

  // 概要（長さ・フレーム数・予測容量）
  const summary = h('div', { class: 'summary' });
  const warn = h('div', { class: 'warn small' });
  const convertBtn = h('button', { class: 'btn primary block' }, 'GIFに変換');
  const progressBox = h('div');
  const resultBox = h('div');

  const refreshSummary = () => {
    const o = options(s);
    const n = frameTimes(o.start, o.end, o.fps).length;
    const len = o.end - o.start;
    const est = s.estimate?.key === estimateKey(s) ? s.estimate.bytes : undefined;
    const estText =
      est === undefined ? '計算中…' : est === null ? '—' : `約 ${formatBytes(est)}（${formatBytes(est * 0.8)}〜${formatBytes(est * 1.2)}）`;
    percentLabel.textContent = `${s.percent}% → ${o.width}×${o.height}`;
    summary.replaceChildren(
      row('範囲', `${formatTime(o.start)} 〜 ${formatTime(o.end)}（${len.toFixed(2)}秒）`),
      row('出力', `${o.width}×${o.height} ・ ${Math.round(o.fps * 100) / 100}fps ・ ${n}コマ`),
      row('予測容量', estText),
    );
    const warnings: string[] = [];
    if (len > MAX_SEC + 0.001) warnings.push(`選択が${MAX_SEC}秒を超えています（容量が大きくなります）`);
    const limit = loadSettings().sizeWarnMB * 1024 * 1024;
    if (est && est > limit) warnings.push(`予測容量が ${loadSettings().sizeWarnMB}MB を超えています。解像度かfpsを下げると小さくなります`);
    warn.textContent = warnings.join('\n');
  };

  let estTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    refreshSummary();
    clearTimeout(estTimer);
    const key = estimateKey(s);
    if (s.estimate?.key === key) return;
    estTimer = setTimeout(async () => {
      if (!grabber || s.job) return;
      const bytes = await withGrabber((g) => estimateGifSize(g, options(s), () => estimateKey(s) !== key || !!s.job)).catch(
        () => null,
      );
      if (estimateKey(s) !== key) return;
      s.estimate = { key, bytes };
      refreshSummary();
    }, 500);
  };

  convertBtn.addEventListener('click', async () => {
    if (!grabber || s.job) return;
    const o = options(s);
    if (o.end - o.start > MAX_SEC + 0.001 && !confirm(`${MAX_SEC}秒を超えています。容量が大きくなりますが変換しますか？`)) return;
    stopLoop();
    const cancel = { cancelled: false };
    s.error = undefined;
    s.result = undefined;
    const name = s.name.replace(/\.[^.]+$/, '');
    const onServer = !!s.serverSource;
    // 進捗の通知が promise の作成中にも来るので、先に job を作ってから処理を始める
    const job: NonNullable<Session['job']> = {
      progress: 0,
      label: onServer ? 'サーバーに依頼中…' : '変換中…',
      cancel,
      promise: Promise.resolve(),
    };
    job.promise = (async () => {
        let wake: { release(): Promise<void> } | null = null;
        try {
          let out: { blob: Blob; id: string };
          if (onServer) {
            // ダウンロードした動画：サーバーで変換（アプリを閉じても続く）
            out = await runServerGif(s.serverSource!, { ...o }, name, (g) => {
              job.progress = g.ratio;
              job.label = g.label;
              progressListeners.forEach((l) => l());
            }, cancel);
          } else {
            // 写真アプリの動画：iPhone 内で変換。画面が消えると止まるので点けたままにする
            wake = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } })
              .wakeLock?.request('screen')
              .catch(() => null) ?? null;
            const blob = await withGrabber((g) =>
              encodeGif(g, o, (r) => {
                job.progress = r;
                job.label = `変換中 ${Math.round(r * 100)}%`;
                progressListeners.forEach((l) => l());
              }, cancel),
            );
            const id = newId();
            await putMedia({
              id,
              kind: 'gif',
              blob,
              name: `${name}.gif`,
              title: name,
              width: o.width,
              height: o.height,
              duration: o.end - o.start,
              createdAt: Date.now(),
            });
            out = { blob, id };
          }
          s.result = { blob: out.blob, id: out.id, opts: o };
          s.editing = false; // 完了したら設定を閉じて結果だけにする
          s.cropEditing = false;
        } catch (e) {
          if (!(e instanceof Cancelled) && (e as Error).name !== 'AbortError') s.error = `変換に失敗しました：${(e as Error).message}`;
        } finally {
          await wake?.release().catch(() => {});
          s.job = undefined;
          notify();
          // 結果だけの表示に切り替わるので先頭まで戻す
          if (s.result && !s.editing) document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'smooth' });
        }
      })();
    s.job = job;
    notify();
  });

  const showProgress = () => {
    const job = s.job;
    if (!job) return progressBox.replaceChildren();
    const bar = progressBox.querySelector('progress');
    if (bar) {
      bar.value = job.progress;
      progressBox.querySelector('.pct')!.textContent = `${Math.round(job.progress * 100)}%`;
      progressBox.querySelector('.stage')!.textContent = job.label;
      return;
    }
    progressBox.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('span', { class: 'label stage' }, job.label), h('span', { class: 'pct label' }, '0%')),
        h('progress', { class: 'progress', max: 1, value: job.progress }),
        h('p', { class: 'muted small' }, s.serverSource
          ? 'サーバーで変換しています。アプリを閉じても続き、完了すると通知が届きます（結果は履歴に入ります）。'
          : 'iPhone 内で変換しています。完了までアプリを開いたままにしてください（他のタブへの移動は大丈夫です）。'),
        h('button', { class: 'btn', onclick: () => (job.cancel.cancelled = true) }, s.serverSource ? '待つのをやめる' : 'キャンセル'),
      ),
    );
  };

  const showResult = () => {
    if (s.error) return resultBox.replaceChildren(h('div', { class: 'card error' }, s.error));
    resultBox.replaceChildren();
  };

  box.append(
    h('div', { class: 'card' },
      stage,
      h('div', { class: 'row between' }, h('div', { class: 'col' }, h('span', { class: 'label' }, '画面の切り抜き'), cropLabel), editBtn),
      aspectRow,
      h('div', { class: 'row between' }, playBtn, h('span', { class: 'muted small' }, `元：${s.srcW}×${s.srcH}${src ? ` ・ ${src}fps` : ''} ・ ${s.duration.toFixed(2)}秒`)),
      trimmer.el,
    ),
    h('div', { class: 'card' },
      h('h2', {}, '変換設定'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, '解像度'), percentLabel, percent, presets),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'フレームレート'), fps),
      h('label', { class: 'switch' }, dither, h('span', {}, 'ディザリング（色の段差をなめらかに）')),
    ),
    h('div', { class: 'card' }, summary, warn),
    s.job ? '' : convertBtn,
    s.job
      ? ''
      : h('p', { class: 'muted small center' },
          s.serverSource === undefined && s.mediaId
            ? '変換方法を確認中…'
            : s.serverSource
              ? '☁ サーバーで変換します（アプリを閉じても続き、完了時に通知）'
              : '📱 iPhone 内で変換します（完了までアプリを開いたままにしてください）'),
    s.result && !s.job
      ? h('button', {
          class: 'btn block',
          onclick: () => {
            if (!s.result) return toast('設定を変えたため、前回の結果は新しく変換し直してください');
            s.editing = false;
            notify();
          },
        }, '前回の結果に戻る')
      : '',
    progressBox,
    resultBox,
  );

  video.addEventListener('loadedmetadata', () => (video.currentTime = s.start), { once: true });
  const onProgress = () => {
    if (!box.isConnected) progressListeners.delete(onProgress);
    else showProgress();
  };
  progressListeners.add(onProgress);
  updateCropLabel();
  setEditing(s.cropEditing);
  refresh();
  showProgress();
  showResult();
  return box;
}

function estimateKey(s: Session): string {
  const o = options(s);
  return JSON.stringify([o.start, o.end, o.fps, o.width, o.height, o.dither, o.crop]);
}

function row(label: string, value: string): HTMLElement {
  return h('div', { class: 'row between small' }, h('span', { class: 'muted' }, label), h('span', {}, value));
}

function summaryRows(size: number, o: GifOptions): HTMLElement {
  return h(
    'div',
    { class: 'summary' },
    row('容量', formatBytes(size)),
    row('解像度', `${o.width}×${o.height}`),
    row('長さ', `${(o.end - o.start).toFixed(2)}秒 ・ ${frameTimes(o.start, o.end, o.fps).length}コマ ・ ${Math.round(o.fps * 100) / 100}fps`),
  );
}

/** タイムライン用のサムネイル（別の video で取り出して、終わったら閉じる） */
async function makeStrip(blob: Blob, duration: number, w: number, hgt: number): Promise<HTMLCanvasElement[]> {
  const n = 12;
  const th = 56;
  const tw = Math.max(1, Math.round((w / hgt) * th));
  const g = await FrameGrabber.open(blob);
  const out: HTMLCanvasElement[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const data = await g.grab(((i + 0.5) / n) * duration, tw, th);
      const c = document.createElement('canvas');
      c.width = tw;
      c.height = th;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), tw, th), 0, 0);
      c.style.left = `${(i / n) * 100}%`;
      c.style.width = `${100 / n}%`;
      out.push(c);
    }
  } finally {
    g.close();
  }
  return out;
}

/** 変換結果のカード（保存・元動画の削除・作り直し・閉じる） */
function resultView(s: Session): HTMLElement {
  const r = s.result!;
  const gifUrl = URL.createObjectURL(r.blob);
  const box = h('div');
  const delBtn = s.mediaId ? h('button', { class: 'btn danger' }, '元動画を削除') : null;
  delBtn?.addEventListener('click', async () => {
    const rec = await getMedia(s.mediaId!);
    const msg = rec?.savedToPhotos
      ? 'アプリ内の元動画を削除します（写真アプリに保存した分は残ります）'
      : '元動画はまだ写真に保存していません。削除すると元に戻せません。削除しますか？';
    if (!confirm(msg)) return;
    await deleteMedia(s.mediaId!);
    s.mediaId = undefined;
    toast('元動画を削除しました');
    delBtn.remove();
  });
  box.append(
    h('div', { class: 'card' },
      h('div', { class: 'ok' }, '✓ 変換できました'),
      h('img', { src: gifUrl, class: 'preview gif', alt: 'GIF' }),
      h('p', { class: 'muted small' }, '画像を長押し →「写真に追加」で保存できます'),
      summaryRows(r.blob.size, r.opts),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => shareFile(r.blob, `${s.name.replace(/\.[^.]+$/, '')}.gif`) }, '保存・共有'),
        delBtn,
      ),
      h('p', { class: 'muted small' }, 'GIF は履歴にも保存されています'),
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn',
          onclick: () => {
            s.editing = true;
            notify();
          },
        }, '設定を変えて作り直す'),
        h('button', { class: 'btn', onclick: () => closeSession() }, '閉じる'),
      ),
    ),
  );
  return box;
}

/** 選んだ動画・設定・結果をすべて片付けて、変換タブを最初の状態に戻す */
function closeSession(): void {
  if (session?.job) return toast('変換中は閉じられません');
  grabber?.close();
  grabber = null;
  session = null;
  if (location.hash.includes('?')) history.replaceState(null, '', '#gif');
  notify();
}
