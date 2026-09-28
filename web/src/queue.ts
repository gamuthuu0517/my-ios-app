// ダウンロードの順番待ち（キュー）。画面を切り替えても状態が残るよう、画面とは別に持つ。
import { extract, fetchVideo, ApiError, type ExtractResult, type FetchProgress, type Item } from './api';
import { putMedia, newId } from './db';
import { makeVideoThumb } from './thumb';

export type TaskStatus = 'queued' | 'running' | 'done' | 'error';

export interface Task {
  itemIdx: number; // info.items の何番目か
  height: number | null;
  status: TaskStatus;
  progress?: FetchProgress;
  error?: string;
  mediaId?: string;
}

export interface Job {
  id: string;
  url: string;
  platform: string;
  status: 'analyzing' | 'ready' | 'error';
  error?: string;
  info?: ExtractResult;
  selected: number[]; // 選択中の itemIdx（複数動画の投稿用）
  quality: Record<number, string>; // itemIdx → 画質（空文字は最高画質）
  tasks: Task[];
  collapsed: boolean;
  createdAt: number;
}

const KEY = 'clipkit.queue.v1';
const MAX_PARALLEL = 2;

let jobs: Job[] = load();
const listeners = new Set<(job?: Job) => void>();

function load(): Job[] {
  try {
    const list: Job[] = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    // アプリが閉じられて中断したものは、再試行できる状態にする
    for (const j of list) {
      for (const t of j.tasks) {
        if (t.status === 'running' || t.status === 'queued') {
          t.status = 'error';
          t.error = 'アプリが閉じられたため中断しました';
          t.progress = undefined;
        }
      }
    }
    return list;
  } catch {
    return [];
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(jobs));
    } catch {
      // 保存できなくても動作は継続
    }
  }, 300);
}

function emit(job?: Job): void {
  save();
  for (const l of listeners) l(job);
}

export function subscribe(fn: (job?: Job) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getJobs(): Job[] {
  return jobs;
}

/** 画質の初期値：変換不要（端末が扱える形式）で取れる最高画質。なければ最高画質 */
export function defaultQuality(item: Item): string {
  const q = item.qualities.find((x) => x.direct ?? x.h264) ?? item.qualities[0];
  return q ? String(q.height) : '';
}

export function addJob(url: string, platform: string): Job {
  const job: Job = {
    id: newId(),
    url,
    platform,
    status: 'analyzing',
    selected: [],
    quality: {},
    tasks: [],
    collapsed: false,
    createdAt: Date.now(),
  };
  jobs = [job, ...jobs];
  emit();
  void analyze(job);
  return job;
}

async function analyze(job: Job): Promise<void> {
  job.status = 'analyzing';
  job.error = undefined;
  emit(job);
  try {
    const info = await extract(job.url);
    job.info = info;
    job.status = 'ready';
    job.selected = info.items.length === 1 ? [0] : [];
    info.items.forEach((item, i) => (job.quality[i] = defaultQuality(item)));
  } catch (e) {
    job.status = 'error';
    job.error = e instanceof ApiError ? e.message : `エラーが発生しました：${(e as Error).message}`;
  }
  emit(job);
}

export function retryAnalyze(job: Job): void {
  void analyze(job);
}

export function update(job: Job, patch: Partial<Job>): void {
  Object.assign(job, patch);
  emit(job);
}

export function removeJob(job: Job): void {
  jobs = jobs.filter((j) => j !== job);
  emit();
}

export function clearFinished(): void {
  jobs = jobs.filter((j) => !(j.status === 'ready' && j.tasks.length > 0 && j.tasks.every((t) => t.status === 'done')));
  emit();
}

/** 選択中の動画をキューに入れる（すでに完了・実行中のものは除く） */
export function enqueue(job: Job): number {
  let added = 0;
  for (const idx of job.selected) {
    const existing = job.tasks.find((t) => t.itemIdx === idx);
    const height = job.quality[idx] ? Number(job.quality[idx]) : null;
    if (existing && (existing.status === 'done' || existing.status === 'running' || existing.status === 'queued')) continue;
    if (existing) Object.assign(existing, { status: 'queued', height, error: undefined, progress: undefined });
    else job.tasks.push({ itemIdx: idx, height, status: 'queued' });
    added++;
  }
  if (added) {
    job.collapsed = true;
    emit(job);
    pump();
  }
  return added;
}

export function retryTask(job: Job, task: Task): void {
  Object.assign(task, { status: 'queued', error: undefined, progress: undefined });
  emit(job);
  pump();
}

function running(): number {
  return jobs.reduce((n, j) => n + j.tasks.filter((t) => t.status === 'running').length, 0);
}

function pump(): void {
  // 古いものから順に、同時に MAX_PARALLEL 件まで実行
  const queued: [Job, Task][] = [];
  for (const j of [...jobs].reverse()) for (const t of j.tasks) if (t.status === 'queued') queued.push([j, t]);
  while (running() < MAX_PARALLEL && queued.length) {
    const [j, t] = queued.shift()!;
    void runTask(j, t);
  }
}

async function runTask(job: Job, task: Task): Promise<void> {
  const item = job.info!.items[task.itemIdx];
  task.status = 'running';
  task.progress = { stage: 'prepare', pct: null };
  emit(job);
  try {
    const { blob, name } = await fetchVideo(job.url, item.index, task.height, (p) => {
      task.progress = p;
      emit(job);
    });
    const id = newId();
    await putMedia({
      id,
      kind: 'video',
      blob,
      name,
      title: item.title,
      platform: job.platform,
      sourceUrl: job.url,
      height: task.height ?? item.height,
      duration: item.duration,
      thumb: await makeVideoThumb(blob),
      createdAt: Date.now(),
    });
    task.status = 'done';
    task.mediaId = id;
    task.progress = undefined;
  } catch (e) {
    task.status = 'error';
    task.error = e instanceof ApiError ? e.message : `エラーが発生しました：${(e as Error).message}`;
  }
  emit(job);
  pump();
}

/** 全体の進み具合（0〜100）。重み：取得 60% / 変換 30% / 受信 10% */
export function taskPercent(t: Task): number {
  if (t.status === 'done') return 100;
  const p = t.progress;
  if (!p) return 0;
  const pct = p.pct ?? 0;
  switch (p.stage) {
    case 'prepare':
      return 0;
    case 'download':
      return pct * 0.6;
    case 'convert':
    case 'finalize':
      return 60 + pct * 0.3;
    case 'receive':
      return 90 + pct * 0.1;
  }
}

export function stageText(t: Task): string {
  if (t.status === 'queued') return '順番待ち';
  if (t.status === 'done') return '完了';
  if (t.status === 'error') return t.error ?? 'エラー';
  const p = t.progress;
  const pct = p?.pct != null ? ` ${p.pct}%` : '';
  switch (p?.stage) {
    case 'download':
      return `サーバーで取得中${pct}${p.part && p.part > 1 ? '（音声）' : ''}`;
    case 'convert':
      return `iPhone用に変換中${pct}`;
    case 'finalize':
      return `仕上げ中${pct}`;
    case 'receive':
      return `受信中${pct}`;
    default:
      return 'サーバーで準備中…';
  }
}

// 解析中に閉じられたものは、次回起動時に解析し直す
for (const j of jobs) if (j.status === 'analyzing') void analyze(j);
