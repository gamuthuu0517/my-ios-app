let loaded = false;

/** 画面上にコンソールを出す（Mac なしで iPhone の不具合を調べるため） */
export function enableDebugConsole(): void {
  if (loaded) return;
  loaded = true;
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js';
  s.onload = () => (window as unknown as { eruda: { init(): void } }).eruda.init();
  document.head.append(s);
}
