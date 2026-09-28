type Eruda = { init(): void; destroy(): void };
let state: 'off' | 'loading' | 'on' = 'off';

const eruda = () => (window as unknown as { eruda?: Eruda }).eruda;

/** 画面上にコンソールを出す（Mac なしで iPhone の不具合を調べるため） */
export function enableDebugConsole(): void {
  if (state !== 'off') return;
  if (eruda()) {
    eruda()!.init();
    state = 'on';
    return;
  }
  state = 'loading';
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js';
  s.onload = () => {
    // 読み込み中にオフにされた場合は出さない
    if (state !== 'loading') return;
    eruda()!.init();
    state = 'on';
  };
  document.head.append(s);
}

/** 画面上のコンソール（右下の歯車）を消す */
export function disableDebugConsole(): void {
  if (state === 'on') eruda()?.destroy();
  state = 'off';
}
