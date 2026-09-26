import { h, toast, formatBytes } from '../dom';
import { clearMedia, listMedia, type MediaRecord } from '../db';
import { mediaCard } from './mediaCard';

export function historyView(): HTMLElement {
  const list = h('div', {}, h('p', { class: 'muted small' }, '読み込み中…'));
  const info = h('span', { class: 'muted small' });
  const clearBtn = h('button', { class: 'btn small danger hidden' }, 'すべて削除');
  const empty = () => h('div', { class: 'empty' }, 'まだ履歴はありません');
  let items: MediaRecord[] = [];

  const updateInfo = () => {
    const total = items.reduce((n, r) => n + r.blob.size, 0);
    info.textContent = items.length ? `${items.length}件 ・ ${formatBytes(total)}` : '';
    clearBtn.classList.toggle('hidden', items.length === 0);
    if (items.length === 0) list.replaceChildren(empty());
  };

  clearBtn.addEventListener('click', async () => {
    const unsaved = items.filter((r) => !r.savedToPhotos).length;
    const msg =
      unsaved > 0
        ? `履歴をすべて削除します。\nそのうち ${unsaved} 件はまだ写真に保存していないため、元に戻せません。削除しますか？`
        : '履歴をすべて削除します（写真アプリに保存した分は残ります）。削除しますか？';
    if (!confirm(msg)) return;
    await clearMedia();
    items = [];
    updateInfo();
    toast('すべて削除しました');
  });

  listMedia()
    .then((all) => {
      items = all;
      list.replaceChildren(
        ...items.map((r) =>
          mediaCard(r, {
            collapsed: true,
            onDeleted: () => {
              items = items.filter((x) => x.id !== r.id);
              updateInfo();
            },
          }),
        ),
      );
      updateInfo();
    })
    .catch(() => list.replaceChildren(h('div', { class: 'card error' }, '履歴を読み込めませんでした')));

  return h(
    'section',
    { class: 'view' },
    h('h1', {}, '履歴'),
    h('div', { class: 'row between list-head' }, info, clearBtn),
    list,
  );
}
