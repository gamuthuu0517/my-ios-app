import { h, toast } from '../dom';

const PLATFORMS: { name: string; pattern: RegExp }[] = [
  { name: 'X (Twitter)', pattern: /(^|\.)(twitter\.com|x\.com)$/ },
  { name: 'TikTok', pattern: /(^|\.)tiktok\.com$/ },
  { name: 'Instagram', pattern: /(^|\.)instagram\.com$/ },
  { name: 'YouTube', pattern: /(^|\.)(youtube\.com|youtu\.be)$/ },
];

export function detectPlatform(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return PLATFORMS.find((p) => p.pattern.test(host))?.name ?? null;
  } catch {
    return null;
  }
}

export function downloadView(): HTMLElement {
  const input = h('input', {
    type: 'url',
    class: 'input',
    placeholder: '動画のURLを貼り付け',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
  });
  const badge = h('div', { class: 'hint' });
  const analyzeBtn = h('button', { class: 'btn primary', disabled: true }, '解析する');

  const update = () => {
    const p = detectPlatform(input.value);
    badge.textContent = input.value
      ? p
        ? `対応サービス：${p}`
        : '対応していないURLです（X / TikTok / Instagram / YouTube）'
      : '';
    badge.classList.toggle('warn', !!input.value && !p);
    analyzeBtn.disabled = !p;
  };
  input.addEventListener('input', update);

  const pasteBtn = h(
    'button',
    {
      class: 'btn',
      onclick: async () => {
        try {
          input.value = (await navigator.clipboard.readText()).trim();
          update();
        } catch {
          toast('貼り付けできませんでした。入力欄を長押しして貼り付けてください');
        }
      },
    },
    '貼り付け',
  );

  analyzeBtn.addEventListener('click', () => {
    toast('ダウンロード機能は第3段階で実装します');
  });

  return h(
    'section',
    { class: 'view' },
    h('h1', {}, 'ダウンロード'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, input, pasteBtn), badge, analyzeBtn),
    h('p', { class: 'muted small' }, '※ ダウンロード機能はサーバー準備後（第3段階）に有効になります。'),
  );
}
