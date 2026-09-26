import { h } from '../dom';

export function historyView(): HTMLElement {
  return h(
    'section',
    { class: 'view' },
    h('h1', {}, '履歴'),
    h('div', { class: 'empty' }, 'まだ履歴はありません'),
  );
}
