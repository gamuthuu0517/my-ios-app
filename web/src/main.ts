import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { h, isStandalone } from './dom';
import { loadSettings } from './settings';
import { enableDebugConsole } from './debug';
import { downloadView } from './views/download';
import { gifView } from './views/gif';
import { historyView } from './views/history';
import { settingsView } from './views/settings';
import { resumePendingGifJobs } from './gifjobs';
import './queue'; // 起動時にサーバー側で処理中のダウンロードを確認する

const ICONS = {
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16"/></svg>',
  gif: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>',
  history: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
};

const routes = {
  download: { label: 'ダウンロード', view: downloadView },
  gif: { label: 'GIF変換', view: gifView },
  history: { label: '履歴', view: historyView },
  settings: { label: '設定', view: settingsView },
} as const;
type Route = keyof typeof routes;

const app = document.getElementById('app')!;
const main = h('main', { class: 'content' });
const tabs = h('nav', { class: 'tabbar' });

for (const [key, r] of Object.entries(routes) as [Route, (typeof routes)[Route]][]) {
  const btn = h('a', { href: `#${key}`, class: 'tab', 'data-route': key });
  btn.innerHTML = ICONS[key];
  btn.append(h('span', {}, r.label));
  tabs.append(btn);
}

function currentRoute(): Route {
  const key = location.hash.slice(1).split('?')[0];
  return key in routes ? (key as Route) : 'download';
}

function render(): void {
  const route = currentRoute();
  main.replaceChildren(routes[route].view());
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.getAttribute('data-route') === route));
  main.scrollTop = 0;
}

window.addEventListener('hashchange', render);

// iPhone の Safari で開かれているとき、ホーム画面への追加を案内する
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installHint =
  isIOS && !isStandalone()
    ? h('div', { class: 'banner' }, '共有ボタン →「ホーム画面に追加」でアプリとして使えます')
    : null;

app.append(...[installHint, main, tabs].filter((x): x is HTMLElement => !!x));
render();

if (loadSettings().debugConsole) enableDebugConsole();

// 閉じている間にサーバーで終わった GIF を取り込む
resumePendingGifJobs();
// 裏から戻ったときも、終わっていた GIF をすぐ取り込む
document.addEventListener('visibilitychange', () => !document.hidden && resumePendingGifJobs());

// アプリ内の動画が iOS に勝手に消されにくくする
navigator.storage?.persist?.().catch(() => {});

// 新しいバージョンが公開されたら更新ボタンを出す
const updateSW = registerSW({
  onNeedRefresh() {
    const bar = h(
      'div',
      { class: 'update' },
      h('span', {}, '新しいバージョンがあります'),
      h('button', { class: 'btn primary small', onclick: () => updateSW(true) }, '更新'),
    );
    document.body.append(bar);
  },
});
