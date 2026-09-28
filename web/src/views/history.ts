import { h, toast, formatBytes } from '../dom';
import { deleteMedia, getMedia, listMedia, type MediaRecord } from '../db';
import { onActivity, onMediaChange } from '../lifecycle';
import { activeDownloads } from '../queue';
import { pendingGifs } from '../gifjobs';
import { mediaCard } from './mediaCard';

type Kind = MediaRecord['kind'];
const TAB_KEY = 'clipkit.historyTab';
const LABEL: Record<Kind, string> = { video: 'ダウンロード', gif: 'GIF' };

function initialTab(): Kind {
  // 通知から開いたときは #history?tab=gif のように指定される
  const q = new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab');
  if (q === 'gif' || q === 'video') return q;
  if (q === 'download') return 'video';
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === 'gif' || saved === 'video') return saved;
  } catch {
    // 読めなければ既定のタブ
  }
  return 'video';
}

export function historyView(): HTMLElement {
  let tab: Kind = initialTab();
  let items: MediaRecord[] = [];
  const cards = new Map<string, HTMLElement>();

  const list = h('div', {}, h('p', { class: 'muted small' }, '読み込み中…'));
  const info = h('span', { class: 'muted small' });
  const clearBtn = h('button', { class: 'btn small danger hidden' }, 'すべて削除');
  const activity = h('a', { class: 'card activity hidden' });
  const tabBtns = (['video', 'gif'] as Kind[]).map((k) => {
    const b = h('button', { class: 'seg-btn', type: 'button' });
    b.addEventListener('click', () => setTab(k));
    return [k, b] as const;
  });
  const seg = h('div', { class: 'seg' }, ...tabBtns.map(([, b]) => b));

  const shown = () => items.filter((r) => r.kind === tab);

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

  const empty = () => h('div', { class: 'empty' }, tab === 'video' ? 'ダウンロードした動画はまだありません' : '作成した GIF はまだありません');

  const updateInfo = () => {
    for (const [k, b] of tabBtns) {
      const n = items.filter((r) => r.kind === k).length;
      b.textContent = `${LABEL[k]}（${n}）`;
      b.classList.toggle('active', k === tab);
    }
    const cur = shown();
    const total = cur.reduce((n, r) => n + r.blob.size, 0);
    info.textContent = cur.length ? `${cur.length}件 ・ ${formatBytes(total)}` : '';
    clearBtn.classList.toggle('hidden', cur.length === 0);
    if (cur.length === 0) list.replaceChildren(empty());
    updateActivity();
  };

  const renderList = () => {
    const cur = shown();
    list.replaceChildren(...(cur.length ? cur.map((r) => cards.get(r.id) ?? cardFor(r)) : [empty()]));
    updateInfo();
  };

  const setTab = (k: Kind) => {
    if (k === tab) return;
    tab = k;
    try {
      localStorage.setItem(TAB_KEY, k);
    } catch {
      // 覚えられなくても切り替えはできる
    }
    renderList();
  };

  // 表示中のタブに関係する、サーバーで処理中のもの
  const updateActivity = () => {
    const n = tab === 'video' ? activeDownloads() : pendingGifs();
    activity.classList.toggle('hidden', n === 0);
    activity.setAttribute('href', tab === 'video' ? '#download' : '#gif');
    activity.replaceChildren(
      h('span', { class: 'spinner' }),
      h('span', {}, `処理中の${LABEL[tab]}：${n}件（完了すると自動でここに追加されます）`),
    );
  };

  clearBtn.addEventListener('click', async () => {
    const cur = shown();
    const unsaved = cur.filter((r) => !r.savedToPhotos).length;
    const what = `${LABEL[tab]}の履歴（${cur.length}件）`;
    const msg =
      unsaved > 0
        ? `${what}をすべて削除します。\nそのうち ${unsaved} 件はまだ写真に保存していないため、元に戻せません。削除しますか？`
        : `${what}をすべて削除します（写真アプリに保存した分は残ります）。削除しますか？`;
    if (!confirm(msg)) return;
    for (const r of cur) await deleteMedia(r.id);
    toast('削除しました');
  });

  listMedia()
    .then((all) => {
      items = all;
      renderList();
    })
    .catch(() => list.replaceChildren(h('div', { class: 'card error' }, '履歴を読み込めませんでした')));

  const root = h(
    'section',
    { class: 'view' },
    h('h1', {}, '履歴'),
    seg,
    activity,
    h('div', { class: 'row between list-head' }, info, clearBtn),
    list,
  );

  // 他の画面や裏で保存・削除されたら、その場で反映する（開いているカードはそのまま）
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
      return renderList();
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
    if (rec.kind === tab) {
      if (!list.querySelector('.media')) list.replaceChildren();
      const card = cardFor(rec);
      card.classList.add('flash');
      list.prepend(card);
    }
    updateInfo();
  });
  const offActivity = onActivity(() => alive() && updateActivity());
  updateInfo();
  return root;
}
