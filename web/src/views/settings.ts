import { h, toast, isStandalone, formatBytes } from '../dom';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { enableDebugConsole } from '../debug';
import { acceptedCodecs } from '../codecs';

function field(label: string, control: HTMLElement, note?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, note ? h('span', { class: 'muted small' }, note) : null);
}

export function settingsView(): HTMLElement {
  const s = loadSettings();

  const serverUrl = h('input', { type: 'url', class: 'input', value: s.serverUrl, placeholder: 'https://xxxx.a.run.app', autocapitalize: 'off' });
  const passphrase = h('input', { type: 'password', class: 'input', value: s.passphrase, autocomplete: 'off' });
  const scale = h('input', { type: 'number', class: 'input', min: 1, max: 100, value: s.gifScalePercent, inputmode: 'numeric' });
  const warn = h('input', { type: 'number', class: 'input', min: 1, max: 500, value: s.sizeWarnMB, inputmode: 'numeric' });
  const dither = h('input', { type: 'checkbox', checked: s.gifDither });
  const debug = h('input', { type: 'checkbox', checked: s.debugConsole });

  const save = () => {
    const next: Settings = {
      serverUrl: serverUrl.value.trim().replace(/\/+$/, ''),
      passphrase: passphrase.value,
      gifScalePercent: Math.min(100, Math.max(1, Math.round(Number(scale.value) || 50))),
      sizeWarnMB: Math.max(1, Math.round(Number(warn.value) || 20)),
      gifDither: dither.checked,
      debugConsole: debug.checked,
    };
    saveSettings(next);
    if (next.debugConsole) enableDebugConsole();
    toast('保存しました');
  };

  const storage = h('span', {}, '計算中…');
  const codecs = h('span', {}, '確認中…');
  void acceptedCodecs().then((c) => (codecs.textContent = c.map((x) => ({ h264: 'H.264', hevc: 'HEVC', av1: 'AV1' })[x] ?? x).join(' / ')));
  navigator.storage
    ?.estimate?.()
    .then((e) => (storage.textContent = `${formatBytes(e.usage ?? 0)} 使用中`))
    .catch(() => (storage.textContent = '取得できません'));

  return h(
    'section',
    { class: 'view' },
    h('h1', {}, '設定'),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'ダウンロードサーバー'),
      field('サーバーURL', serverUrl, 'Cloud Run の URL（第3段階で設定）'),
      field('合言葉', passphrase),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'GIF変換の初期値'),
      field('解像度（%）', scale),
      field('容量の注意表示（MB 以上）', warn),
      h('label', { class: 'switch' }, dither, h('span', {}, 'ディザリング')),
    ),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'その他'),
      h('label', { class: 'switch' }, debug, h('span', {}, 'デバッグ表示（不具合調査用）')),
    ),
    h('button', { class: 'btn primary block', onclick: save }, '保存'),
    h(
      'div',
      { class: 'card about' },
      h('div', {}, `バージョン ${__APP_VERSION__}`),
      h('div', { class: 'muted small' }, `ビルド ${new Date(__BUILD_TIME__).toLocaleString('ja-JP')}`),
      h('div', { class: 'muted small' }, `起動モード：${isStandalone() ? 'ホーム画面アプリ' : 'ブラウザ'}`),
      h('div', { class: 'muted small' }, 'アプリ内ストレージ：', storage),
      h('div', { class: 'muted small' }, '変換なしで扱える形式：', codecs),
    ),
  );
}
