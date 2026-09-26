import { h, toast, formatBytes } from '../dom';
import { deleteMedia, updateMedia, type MediaRecord } from '../db';
import { shareFile } from '../share';

const CHEVRON = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';

export function chevron(): HTMLElement {
  const el = h('span', { class: 'chevron' });
  el.innerHTML = CHEVRON;
  return el;
}

function formatDuration(sec?: number): string {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** アプリ内の動画/GIF 1件分のカード。見出しをタップで折りたたみ（保存・GIF化・削除） */
export function mediaCard(r: MediaRecord, opts: { collapsed?: boolean; onDeleted?: () => void } = {}): HTMLElement {
  let url: string | null = null;
  const thumbSrc = r.kind === 'gif' ? r.blob : r.thumb;
  const thumbUrl = thumbSrc ? URL.createObjectURL(thumbSrc) : null;

  const status = h('span', { class: 'muted small' }, r.savedToPhotos ? '写真に保存済み' : 'アプリ内のみ');
  const meta = [
    r.kind === 'gif' ? 'GIF' : r.platform,
    formatDuration(r.duration),
    r.height ? `${r.height}p` : null,
    formatBytes(r.blob.size),
  ]
    .filter(Boolean)
    .join(' ・ ');

  const head = h(
    'button',
    { class: 'collapse-head', type: 'button' },
    thumbUrl ? h('img', { src: thumbUrl, class: 'thumb', alt: '' }) : h('div', { class: 'thumb' }),
    h(
      'div',
      { class: 'item-meta' },
      h('div', { class: 'label clamp' }, r.title),
      h('div', { class: 'muted small' }, meta),
      h('div', { class: 'muted small' }, new Date(r.createdAt).toLocaleString('ja-JP')),
    ),
    chevron(),
  );
  const body = h('div', { class: 'collapse-body' });
  const card = h('div', { class: 'card media' }, head, body);

  const buildBody = () => {
    url ??= URL.createObjectURL(r.blob);
    const preview =
      r.kind === 'gif'
        ? h('img', { src: url, class: 'preview', alt: r.title })
        : h('video', { src: url, class: 'preview', controls: true, playsinline: true, preload: 'metadata' });

    const saveBtn = h('button', { class: 'btn primary' }, '写真に保存');
    saveBtn.addEventListener('click', async () => {
      if (await shareFile(r.blob, r.name)) {
        r.savedToPhotos = true;
        await updateMedia(r.id, { savedToPhotos: true });
        status.textContent = '写真に保存済み';
      }
    });
    const gifBtn =
      r.kind === 'video' ? h('a', { class: 'btn', href: `#gif?id=${encodeURIComponent(r.id)}` }, 'GIFにする') : null;
    const delBtn = h('button', { class: 'btn danger' }, '削除');
    delBtn.addEventListener('click', async () => {
      const msg = r.savedToPhotos
        ? 'アプリ内のデータを削除します（写真アプリの分は残ります）'
        : 'まだ写真に保存していません。削除すると元に戻せません。削除しますか？';
      if (!confirm(msg)) return;
      await deleteMedia(r.id);
      if (url) URL.revokeObjectURL(url);
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
      card.remove();
      toast('削除しました');
      opts.onDeleted?.();
    });
    body.replaceChildren(preview, status, h('div', { class: 'actions' }, saveBtn, gifBtn, delBtn));
  };

  const setCollapsed = (c: boolean) => {
    card.classList.toggle('collapsed', c);
    if (!c && !body.hasChildNodes()) buildBody();
    if (c) body.querySelector('video')?.pause();
  };
  head.addEventListener('click', () => setCollapsed(!card.classList.contains('collapsed')));
  setCollapsed(opts.collapsed ?? false);
  return card;
}
