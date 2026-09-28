import { h, toast, isStandalone, formatBytes } from '../dom';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { disableDebugConsole, enableDebugConsole } from '../debug';
import { acceptedCodecs } from '../codecs';
import { enableNotifications, permission, sendTestNotification } from '../notify';

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
  const notifyDl = h('input', { type: 'checkbox', checked: s.notifyDownload });
  const notifyGif = h('input', { type: 'checkbox', checked: s.notifyGif });

  // 通知の許可状態と、許可するボタン
  const notifyState = h('div', { class: 'muted small' });
  const allowBtn = h('button', { class: 'btn small' }, '通知を許可する');
  const testBtn = h('button', { class: 'btn small' }, 'テスト通知を送る');
  const testResult = h('div', { class: 'muted small' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.textContent = '送信中…（アプリを閉じると通知が見やすくなります）';
    try {
      const r = await sendTestNotification();
      testResult.textContent = r.ok ? `✓ ${r.detail}。数秒で通知が届きます` : `✗ ${r.detail}`;
      testResult.classList.toggle('warn', !r.ok);
    } catch (e) {
      testResult.textContent = `✗ ${(e as Error).message}`;
      testResult.classList.add('warn');
    }
    testBtn.disabled = false;
  });
  const refreshNotify = () => {
    const p = permission();
    allowBtn.classList.toggle('hidden', p === 'denied' || p === 'unsupported');
    allowBtn.textContent = p === 'granted' ? '通知を登録し直す' : '通知を許可する';
    testBtn.classList.toggle('hidden', p !== 'granted');
    notifyState.textContent =
      p === 'granted'
        ? '通知：許可済み'
        : p === 'denied'
          ? '通知：拒否されています（iPhone の「設定」→「通知」→「ClipKit」で許可してください）'
          : p === 'unsupported'
            ? isStandalone()
              ? '通知：この端末では使えません（iOS 16.4 以降が必要です）'
              : '通知：ホーム画面に追加したアプリから開くと使えます'
            : '通知：まだ許可されていません';
  };
  allowBtn.addEventListener('click', async () => {
    try {
      toast((await enableNotifications()) ? '通知を許可しました' : '通知が許可されませんでした');
    } catch (e) {
      toast(`通知を設定できませんでした：${(e as Error).message}`);
    }
    refreshNotify();
  });
  refreshNotify();

  const save = () => {
    const next: Settings = {
      serverUrl: serverUrl.value.trim().replace(/\/+$/, ''),
      passphrase: passphrase.value,
      gifScalePercent: Math.min(100, Math.max(1, Math.round(Number(scale.value) || 50))),
      sizeWarnMB: Math.max(1, Math.round(Number(warn.value) || 20)),
      gifDither: dither.checked,
      debugConsole: debug.checked,
      notifyDownload: notifyDl.checked,
      notifyGif: notifyGif.checked,
    };
    saveSettings(next);
    if (next.debugConsole) enableDebugConsole();
    else disableDebugConsole();
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
      h('h2', {}, '完了通知'),
      h('label', { class: 'switch' }, notifyDl, h('span', {}, 'ダウンロード完了を通知')),
      h('label', { class: 'switch' }, notifyGif, h('span', {}, 'GIF変換完了を通知（ダウンロードした動画のみ）')),
      h('div', { class: 'row between' }, notifyState, allowBtn),
      h('div', { class: 'row between' }, testResult, testBtn),
      h('p', { class: 'muted small' }, 'サーバーで処理するので、アプリを閉じても処理は続き、完了すると通知が届きます。写真アプリの動画の GIF 変換は iPhone 内で行うため、アプリを開いたままにしてください。'),
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
