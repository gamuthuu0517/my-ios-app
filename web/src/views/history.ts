import { h, toast, formatBytes } from '../dom';
import { clearMedia, getMedia, listMedia, type MediaRecord } from '../db';
import { onActivity, onMediaChange } from '../lifecycle';
import { activeDownloads } from '../queue';
import { pendingGifs } from '../gifjobs';
import { mediaCard } from './mediaCard';

export function historyView(): HTMLElement {
  const list = h('div', {}, h('p', { class: 'muted small' }, '読み込み中…'));
  const info = h('span', { class: 'muted small' });
  const clearBtn = h('button', { class: 'btn small danger hidden' }, 'すべて削除');
  const empty = () => h('div', { class: 'empty' }, 'まだ履歴はありません');
  let items: MediaRecord[] = [];
  const cards = new Map<string, HTMLElement>();
  const activity = h('a', { class: 'card activity hidden', href: '#download' });

  const cardFor = (r: MediaRecord) => {
    const c = mediaCard(r, {
      collapsed: true,
      onDeleted: () => {
        items = items.filter((x) => x.id !== r.id);
        cards.delete(r.id);
        updateInfo();
      },
    });
    cards.set(r.id, c);
    return c;
  };

  // サーバーで処理中のもの（完了するとこの下に自動で追加される）
  const updateActivity = () => {
    const d = activeDownloads();
    const g = pendingGifs();
    activity.classList.toggle('hidden', d + g === 0);
    activity.replaceChildren(
      h('span', { class: 'spinner' }),
      h('span', {}, `処理中：${[d ? `ダウンロード ${d}件` : '', g ? `GIF ${g}件` : ''].filter(Boolean).join('・')}（完了すると自動でここに追加されます）`),
    );
    if (g === 0 || d > 0) activity.setAttribute('href', '#download');
    else activity.setAttribute('href', '#gif');
  };

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
      if (items.length) list.replaceChildren(...items.map(cardFor));
      updateInfo();
    })
    .catch(() => list.replaceChildren(h('div', { class: 'card error' }, '履歴を読み込めませんでした')));

  // 他の画面や裏で保存・削除されたら、その場で反映する（開いているカードはそのまま）
  const root = h(
    'section',
    { class: 'view' },
    h('h1', {}, '履歴'),
    activity,
    h('div', { class: 'row between list-head' }, info, clearBtn),
    list,
  );
  let mounted = false;
  requestAnimationFrame(() => (mounted = true));
  const alive = () => {
    if (mounted && !root.isConnected) {
      offMedia();
      offActivity();
      return false;
    }
    return true;
  };
  const offMedia = onMediaChange(async (c) => {
    if (!alive()) return;
    if (c.type === 'clear') {
      items = [];
      cards.clear();
      return updateInfo();
    }
    if (c.type === 'delete') {
      cards.get(c.id)?.remove();
      cards.delete(c.id);
      items = items.filter((x) => x.id !== c.id);
      return updateInfo();
    }
    const rec = await getMedia(c.id);
    if (!rec) return;
    const i = items.findIndex((x) => x.id === rec.id);
    if (i >= 0) {
      items[i] = rec; // サムネイル・保存済みなどの更新。表示中のカードは作り直さない
      return updateInfo();
    }
    items = [rec, ...items];
    if (!list.querySelector('.media')) list.replaceChildren();
    const card = cardFor(rec);
    card.classList.add('flash');
    list.prepend(card);
    updateInfo();
  });
  const offActivity = onActivity(() => alive() && updateActivity());
  updateActivity();
  return root;
}
