import { h, toast, formatBytes } from '../dom';
import { extract, download, ApiError, type Item, type ExtractResult } from '../api';
import { putMedia, newId, type MediaRecord } from '../db';
import { loadSettings } from '../settings';
import { mediaCard } from './mediaCard';

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

function formatDuration(sec?: number): string {
  if (!sec) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : `エラーが発生しました：${(e as Error).message}`;
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
  const results = h('div');

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
          if (!analyzeBtn.disabled) analyzeBtn.click();
        } catch {
          toast('貼り付けできませんでした。入力欄を長押しして貼り付けてください');
        }
      },
    },
    '貼り付け',
  );

  analyzeBtn.addEventListener('click', async () => {
    const url = input.value.trim();
    const platform = detectPlatform(url) ?? '';
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = '解析中…';
    results.replaceChildren(
      h('p', { class: 'muted small' }, 'サーバーが停止中の場合、起動に数十秒かかることがあります'),
    );
    try {
      const info = await extract(url);
      results.replaceChildren(renderResult(url, platform, info));
    } catch (e) {
      results.replaceChildren(h('div', { class: 'card error' }, errorMessage(e)));
    } finally {
      analyzeBtn.textContent = '解析する';
      update();
    }
  });

  const needsSetup = !loadSettings().serverUrl || !loadSettings().passphrase;

  return h(
    'section',
    { class: 'view' },
    h('h1', {}, 'ダウンロード'),
    needsSetup
      ? h('a', { class: 'card error', href: '#settings' }, '設定画面でサーバーURLと合言葉を入力してください →')
      : null,
    h('div', { class: 'card' }, h('div', { class: 'row' }, input, pasteBtn), badge, analyzeBtn),
    results,
  );
}

function qualityLabel(q: { height: number; h264: boolean }): string {
  return `${q.height}p${q.h264 ? '' : '（要変換・時間がかかります）'}`;
}

function renderResult(url: string, platform: string, info: ExtractResult): HTMLElement {
  const multi = info.items.length > 1;
  const rows: { item: Item; check: HTMLInputElement; select: HTMLSelectElement; slot: HTMLElement }[] = [];

  const list = h('div');
  for (const item of info.items) {
    const check = h('input', { type: 'checkbox', checked: !multi, class: multi ? '' : 'hidden' });
    const select = h('select', { class: 'input select' });
    // 一覧の先頭（最高画質）が初期選択
    if (item.qualities.length === 0) select.append(h('option', { value: '' }, '最高画質'));
    for (const q of item.qualities) select.append(h('option', { value: String(q.height) }, qualityLabel(q)));

    const thumb = item.thumbnail
      ? h('img', { src: item.thumbnail, class: 'thumb', referrerpolicy: 'no-referrer', alt: '' })
      : h('div', { class: 'thumb' });
    thumb.addEventListener('error', () => thumb.classList.add('blank'));

    const slot = h('div');
    const row = h(
      'div',
      { class: 'card item' },
      h(
        'label',
        { class: 'item-head' },
        check,
        thumb,
        h(
          'div',
          { class: 'item-meta' },
          h('div', { class: 'label clamp' }, multi ? `${(item.index ?? 0) + 1}. ${item.title}` : item.title),
          h('div', { class: 'muted small' }, [formatDuration(item.duration), item.height ? `元 ${item.height}p` : ''].filter(Boolean).join(' ・ ')),
        ),
      ),
      h('label', { class: 'field' }, h('span', { class: 'label' }, '画質'), select),
      slot,
    );
    rows.push({ item, check, select, slot });
    list.append(row);
  }

  const dlBtn = h('button', { class: 'btn primary block' }, multi ? '選択した動画をダウンロード' : 'ダウンロード');
  dlBtn.addEventListener('click', async () => {
    const targets = rows.filter((r) => r.check.checked);
    if (targets.length === 0) return toast('動画を選択してください');
    dlBtn.disabled = true;
    for (const t of targets) {
      const bar = h('progress', { class: 'progress', max: 1 });
      const text = h('div', { class: 'muted small' }, 'サーバーで準備中…');
      t.slot.replaceChildren(bar, text);
      try {
        const height = t.select.value ? Number(t.select.value) : null;
        const { blob, name } = await download(url, t.item.index, height, (loaded, total) => {
          if (total) bar.value = loaded / total;
          else bar.removeAttribute('value');
          text.textContent = `受信中 ${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}` : ''}`;
        });
        const rec: MediaRecord = {
          id: newId(),
          kind: 'video',
          blob,
          name,
          title: t.item.title,
          platform,
          sourceUrl: url,
          height: height ?? t.item.height,
          duration: t.item.duration,
          createdAt: Date.now(),
        };
        await putMedia(rec);
        t.slot.replaceChildren(h('div', { class: 'ok small' }, '✓ ダウンロード完了'), mediaCard(rec));
        t.check.checked = false;
      } catch (e) {
        t.slot.replaceChildren(h('div', { class: 'card error' }, errorMessage(e)));
      }
    }
    dlBtn.disabled = false;
  });

  return h(
    'div',
    {},
    multi ? h('p', { class: 'muted small' }, `この投稿には ${info.items.length} 件の動画があります。保存するものを選んでください。`) : null,
    list,
    dlBtn,
  );
}
