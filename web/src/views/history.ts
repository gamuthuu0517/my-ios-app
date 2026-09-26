import { h } from '../dom';
import { listMedia } from '../db';
import { mediaCard } from './mediaCard';

export function historyView(): HTMLElement {
  const list = h('div', {}, h('p', { class: 'muted small' }, '読み込み中…'));
  const empty = () => h('div', { class: 'empty' }, 'まだ履歴はありません');

  listMedia()
    .then((items) => {
      if (items.length === 0) return list.replaceChildren(empty());
      list.replaceChildren(
        ...items.map((r) =>
          mediaCard(r, () => {
            if (!list.querySelector('.media')) list.replaceChildren(empty());
          }),
        ),
      );
    })
    .catch(() => list.replaceChildren(h('div', { class: 'card error' }, '履歴を読み込めませんでした')));

  return h('section', { class: 'view' }, h('h1', {}, '履歴'), list);
}
