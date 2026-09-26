import { h, toast, formatBytes } from '../dom';
import { deleteMedia, updateMedia, type MediaRecord } from '../db';
import { shareFile } from '../share';

/** アプリ内の動画/GIF 1件分のカード（保存・GIF化・削除） */
export function mediaCard(r: MediaRecord, onDeleted?: () => void): HTMLElement {
  const url = URL.createObjectURL(r.blob);
  const preview =
    r.kind === 'gif'
      ? h('img', { src: url, class: 'preview', alt: r.title })
      : h('video', { src: url, class: 'preview', controls: true, playsinline: true, preload: 'metadata' });

  const status = h('span', { class: 'muted small' }, r.savedToPhotos ? '写真に保存済み' : 'アプリ内のみ');
  const meta = [r.platform, r.height ? `${r.height}p` : null, formatBytes(r.blob.size), new Date(r.createdAt).toLocaleString('ja-JP')]
    .filter(Boolean)
    .join(' ・ ');

  const card = h(
    'div',
    { class: 'card media' },
    preview,
    h('div', { class: 'label clamp' }, r.title),
    h('div', { class: 'muted small' }, meta),
    status,
  );

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
    URL.revokeObjectURL(url);
    card.remove();
    toast('削除しました');
    onDeleted?.();
  });

  card.append(h('div', { class: 'actions' }, saveBtn, gifBtn, delBtn));
  return card;
}
