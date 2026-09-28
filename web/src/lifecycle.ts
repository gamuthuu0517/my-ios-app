// アプリの表示状態と、画面をまたいだ更新の知らせ

/** アプリが表示されるまで待つ（裏にある間は iOS に止められるので問い合わせない） */
export function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const on = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', on);
      resolve();
    };
    document.addEventListener('visibilitychange', on);
  });
}

/** 待ち時間。アプリが前面に戻ったらすぐに切り上げて、最新の状態を取りに行けるようにする */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
      resolve();
    };
    const onVis = () => !document.hidden && done();
    const timer = setTimeout(done, ms);
    document.addEventListener('visibilitychange', onVis);
  });
}

export type MediaChange = { type: 'put'; id: string } | { type: 'delete'; id: string } | { type: 'clear' };

const bus = new EventTarget();

export function emitMediaChange(c: MediaChange): void {
  bus.dispatchEvent(new CustomEvent('media', { detail: c }));
}
export function onMediaChange(fn: (c: MediaChange) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<MediaChange>).detail);
  bus.addEventListener('media', h);
  return () => bus.removeEventListener('media', h);
}

/** サーバーで処理中の件数が変わったとき（履歴の「処理中」表示用） */
export function emitActivity(): void {
  bus.dispatchEvent(new Event('activity'));
}
export function onActivity(fn: () => void): () => void {
  bus.addEventListener('activity', fn);
  return () => bus.removeEventListener('activity', fn);
}
