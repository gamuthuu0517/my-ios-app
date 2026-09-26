import { h, toast } from '../dom';
import { getMedia } from '../db';
import { loadSettings } from '../settings';
import {
  addJob,
  clearFinished,
  enqueue,
  getJobs,
  removeJob,
  retryAnalyze,
  retryTask,
  stageText,
  subscribe,
  taskPercent,
  update,
  type Job,
} from '../queue';
import { chevron, mediaCard } from './mediaCard';

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
  const addBtn = h('button', { class: 'btn primary', disabled: true }, '追加して解析');

  const refreshInput = () => {
    const p = detectPlatform(input.value);
    badge.textContent = input.value
      ? p
        ? `対応サービス：${p}`
        : '対応していないURLです（X / TikTok / Instagram / YouTube）'
      : '';
    badge.classList.toggle('warn', !!input.value && !p);
    addBtn.disabled = !p;
  };
  input.addEventListener('input', refreshInput);

  const add = () => {
    const url = input.value.trim();
    const p = detectPlatform(url);
    if (!p) return;
    if (getJobs().some((j) => j.url === url && j.status !== 'error')) toast('同じURLがすでにリストにあります');
    else addJob(url, p);
    input.value = '';
    refreshInput();
  };
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());

  const pasteBtn = h('button', { class: 'btn' }, '貼り付け');
  pasteBtn.addEventListener('click', async () => {
    try {
      input.value = (await navigator.clipboard.readText()).trim();
      refreshInput();
      if (!addBtn.disabled) add();
    } catch {
      toast('貼り付けできませんでした。入力欄を長押しして貼り付けてください');
    }
  });

  const list = h('div');
  const clearBtn = h('button', { class: 'btn small hidden', onclick: () => clearFinished() }, '完了したものをリストから消す');
  const cards = new Map<string, JobCard>();

  let mounted = false;
  requestAnimationFrame(() => (mounted = true));
  const render = (changed?: Job) => {
    // 別のタブに移ったら購読をやめる（状態はキュー側に残る）
    if (mounted && !list.isConnected) {
      unsubscribe();
      return;
    }
    if (changed && cards.has(changed.id)) {
      cards.get(changed.id)!.update(changed);
    } else {
      const jobs = getJobs();
      for (const [id] of cards) if (!jobs.some((j) => j.id === id)) cards.delete(id);
      list.replaceChildren(
        ...jobs.map((j) => {
          let c = cards.get(j.id);
          if (!c) cards.set(j.id, (c = new JobCard(j)));
          c.update(j);
          return c.el;
        }),
      );
    }
    clearBtn.classList.toggle(
      'hidden',
      !getJobs().some((j) => j.tasks.length > 0 && j.tasks.every((t) => t.status === 'done')),
    );
  };
  const unsubscribe = subscribe(render);
  render();

  const s = loadSettings();
  return h(
    'section',
    { class: 'view' },
    h('h1', {}, 'ダウンロード'),
    !s.serverUrl || !s.passphrase
      ? h('a', { class: 'card error', href: '#settings' }, '設定画面でサーバーURLと合言葉を入力してください →')
      : null,
    h('div', { class: 'card' }, h('div', { class: 'row' }, input, pasteBtn), badge, addBtn),
    h('div', { class: 'list-head' }, clearBtn),
    list,
  );
}

/** URL 1件分のカード。見出し（サムネ・タイトル・進捗）をタップで折りたたみ */
class JobCard {
  el: HTMLElement;
  private thumb = h('div', { class: 'thumb' }) as HTMLElement;
  private title = h('div', { class: 'label clamp' });
  private status = h('div', { class: 'muted small' });
  private bar = h('progress', { class: 'progress', max: 100 });
  private body = h('div', { class: 'collapse-body' });
  private bodyKey = '';
  private taskEls = new Map<number, { text: HTMLElement; bar: HTMLProgressElement }>();

  constructor(private job: Job) {
    const head = h(
      'button',
      { class: 'collapse-head', type: 'button' },
      this.thumb,
      h('div', { class: 'item-meta' }, this.title, this.status, this.bar),
      chevron(),
    );
    head.addEventListener('click', () => update(this.job, { collapsed: !this.job.collapsed }));
    this.el = h('div', { class: 'card job' }, head, this.body);
  }

  update(job: Job): void {
    this.job = job;
    const items = job.info?.items ?? [];
    const firstThumb = items.find((i) => i.thumbnail)?.thumbnail;
    if (firstThumb && !(this.thumb instanceof HTMLImageElement)) {
      const img = h('img', { src: firstThumb, class: 'thumb', referrerpolicy: 'no-referrer', alt: '' });
      img.addEventListener('error', () => img.classList.add('blank'));
      this.thumb.replaceWith(img);
      this.thumb = img;
    }
    this.title.textContent =
      job.info?.items.length === 1 ? job.info.items[0].title : (job.info?.title ?? job.url);

    // 見出しの状態表示
    const { text, pct } = this.summary();
    this.status.textContent = text;
    this.status.classList.toggle('warn', job.status === 'error' || job.tasks.some((t) => t.status === 'error'));
    if (pct === null) this.bar.classList.add('hidden');
    else {
      this.bar.classList.remove('hidden');
      this.bar.value = pct;
    }
    this.el.classList.toggle('collapsed', job.collapsed);

    // 中身は構造が変わったときだけ作り直し、進捗だけの変化はその場で更新
    const key = JSON.stringify([job.status, job.collapsed, job.selected, job.tasks.map((t) => [t.itemIdx, t.status]), items.length]);
    if (key !== this.bodyKey) {
      this.bodyKey = key;
      this.buildBody();
    } else {
      for (const t of job.tasks) {
        const el = this.taskEls.get(t.itemIdx);
        if (!el) continue;
        el.text.textContent = stageText(t);
        el.bar.value = taskPercent(t);
      }
    }
  }

  private summary(): { text: string; pct: number | null } {
    const j = this.job;
    if (j.status === 'analyzing') return { text: '解析中…', pct: null };
    if (j.status === 'error') return { text: 'エラー（タップで詳細）', pct: null };
    const tasks = j.tasks;
    if (tasks.length === 0) {
      const n = j.info?.items.length ?? 0;
      return { text: n > 1 ? `${n}件の動画・保存するものを選んでください` : '画質を選んでダウンロード', pct: null };
    }
    const done = tasks.filter((t) => t.status === 'done').length;
    const err = tasks.filter((t) => t.status === 'error').length;
    const run = tasks.find((t) => t.status === 'running');
    const pct = tasks.reduce((a, t) => a + taskPercent(t), 0) / tasks.length;
    const count = tasks.length > 1 ? `（${done}/${tasks.length}件完了）` : '';
    if (done === tasks.length) return { text: tasks.length > 1 ? `${done}件 完了` : '完了', pct: null };
    if (run) return { text: `${stageText(run)}${count}`, pct };
    if (tasks.some((t) => t.status === 'queued')) return { text: `順番待ち${count}`, pct };
    return { text: `${err}件 失敗${count}`, pct: null };
  }

  private buildBody(): void {
    const j = this.job;
    this.taskEls.clear();
    if (j.collapsed) {
      this.body.replaceChildren();
      return;
    }
    if (j.status === 'analyzing') {
      this.body.replaceChildren(
        h('p', { class: 'muted small' }, 'しばらく使っていなかった場合、サーバーの起動に数十秒かかります。'),
        this.removeBtn('取り消す'),
      );
      return;
    }
    if (j.status === 'error') {
      this.body.replaceChildren(
        h('div', { class: 'warn small' }, j.error ?? 'エラー'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => retryAnalyze(j) }, '再試行'), this.removeBtn('リストから消す')),
      );
      return;
    }

    const items = j.info!.items;
    const multi = items.length > 1;
    const rows = items.map((item, idx) => {
      const task = j.tasks.find((t) => t.itemIdx === idx);
      const locked = task && task.status !== 'error';

      const check = h('input', { type: 'checkbox', checked: j.selected.includes(idx), disabled: !!locked });
      check.addEventListener('change', () => {
        j.selected = check.checked ? [...j.selected, idx] : j.selected.filter((x) => x !== idx);
        update(j, {});
      });
      const select = h('select', { class: 'input select', disabled: !!locked });
      if (item.qualities.length === 0) select.append(h('option', { value: '' }, '最高画質'));
      for (const q of item.qualities) {
        select.append(h('option', { value: String(q.height) }, `${q.height}p${q.h264 ? '' : '（要変換・時間がかかります）'}`));
      }
      select.value = j.quality[idx] ?? '';
      select.addEventListener('change', () => (j.quality[idx] = select.value));

      const thumb = item.thumbnail
        ? h('img', { src: item.thumbnail, class: 'thumb small', referrerpolicy: 'no-referrer', alt: '' })
        : null;
      thumb?.addEventListener('error', () => thumb.classList.add('blank'));

      const row = h(
        'div',
        { class: 'sub-item' },
        multi
          ? h(
              'label',
              { class: 'item-head' },
              check,
              thumb,
              h(
                'div',
                { class: 'item-meta' },
                h('div', { class: 'label clamp' }, `${idx + 1}. ${item.title}`),
                h('div', { class: 'muted small' }, formatDuration(item.duration)),
              ),
            )
          : h('div', { class: 'muted small' }, [formatDuration(item.duration), item.height ? `元 ${item.height}p` : ''].filter(Boolean).join(' ・ ')),
        h('label', { class: 'field' }, h('span', { class: 'label' }, '画質'), select),
      );

      if (task) {
        if (task.status === 'done' && task.mediaId) {
          const slot = h('div', { class: 'ok small' }, '✓ ダウンロード完了');
          row.append(slot);
          getMedia(task.mediaId).then((r) => r && slot.after(mediaCard(r, { collapsed: false })));
        } else if (task.status === 'error') {
          row.append(
            h('div', { class: 'warn small' }, stageText(task)),
            h('button', { class: 'btn small', onclick: () => retryTask(j, task) }, '再試行'),
          );
        } else {
          const text = h('div', { class: 'muted small' }, stageText(task));
          const bar = h('progress', { class: 'progress', max: 100, value: taskPercent(task) });
          this.taskEls.set(idx, { text, bar });
          row.append(bar, text);
        }
      }
      return row;
    });

    const pendingSel = j.selected.filter((idx) => {
      const t = j.tasks.find((x) => x.itemIdx === idx);
      return !t || t.status === 'error';
    });
    const dlBtn = h(
      'button',
      { class: 'btn primary', disabled: pendingSel.length === 0 },
      multi ? `選択した動画をダウンロード（${pendingSel.length}件）` : 'ダウンロード',
    );
    dlBtn.addEventListener('click', () => {
      if (enqueue(j) === 0) toast('ダウンロードする動画を選んでください');
    });

    const allDone = j.tasks.length > 0 && j.tasks.every((t) => t.status === 'done') && pendingSel.length === 0;
    this.body.replaceChildren(
      multi ? h('p', { class: 'muted small' }, `この投稿には ${items.length} 件の動画があります。保存するものを選んでください。`) : '',
      ...rows,
      h('div', { class: 'actions' }, allDone ? null : dlBtn, this.removeBtn('リストから消す')),
    );
  }

  private removeBtn(label: string): HTMLElement {
    return h(
      'button',
      {
        class: 'btn',
        onclick: () => {
          if (this.job.tasks.some((t) => t.status === 'running' || t.status === 'queued')) {
            if (!confirm('ダウンロード中のものがあります。リストから消しますか？（処理は裏で続き、完了すると履歴に入ります）')) return;
          }
          removeJob(this.job);
        },
      },
      label,
    );
  }
}
