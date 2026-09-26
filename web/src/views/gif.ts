import { h, formatBytes } from '../dom';

export function gifView(): HTMLElement {
  const info = h('div', { class: 'card hidden' });
  const fileInput = h('input', { type: 'file', accept: 'video/*', class: 'hidden' });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const video = h('video', { src: url, controls: true, playsinline: true, muted: true, class: 'preview' });
    const meta = h('div', { class: 'muted small' }, '読み込み中…');
    video.addEventListener('loadedmetadata', () => {
      meta.textContent = `${video.videoWidth}×${video.videoHeight} ・ ${video.duration.toFixed(2)}秒 ・ ${formatBytes(file.size)}`;
    });
    info.replaceChildren(h('div', { class: 'label' }, file.name), video, meta);
    info.classList.remove('hidden');
  });

  return h(
    'section',
    { class: 'view' },
    h('h1', {}, 'GIF変換'),
    h(
      'div',
      { class: 'card' },
      h('p', {}, '写真アプリの動画を選んで GIF に変換します。'),
      h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '動画を選択'),
      fileInput,
    ),
    info,
    h('p', { class: 'muted small' }, '※ トリミング・変換機能は第2段階で実装します（現在は動画の読み込み確認のみ）。'),
  );
}
