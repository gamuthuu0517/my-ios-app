// ダウンロードした動画の GIF 変換をサーバーに任せる（アプリを閉じても続き、完了時に通知）
import { ApiError, jobFile, jobStatus, sourceExists, startGifJob, type GifJobParams } from './api';
import { newId, putMedia, type MediaRecord } from './db';
import { toast } from './dom';
import { subscriptionFor } from './notify';

const KEY = 'clipkit.gifjobs.v1';
const REMOTE_TTL = 23 * 60 * 60 * 1000; // サーバーの一時保管は1日で消えるので少し手前まで

interface Pending {
  jobId: string;
  name: string;
  params: GifJobParams;
  createdAt: number;
}

const active = new Set<string>();

function loadPending(): Pending[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}
function savePending(list: Pending[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 保存できなくても処理は続く
  }
}

/** この動画をサーバーで変換できるか（ダウンロードした動画で、サーバーにまだ残っている） */
export async function serverSourceFor(rec: MediaRecord | undefined): Promise<string | null> {
  const r = rec?.remote;
  if (!r || Date.now() - r.at > REMOTE_TTL) return null;
  try {
    return (await sourceExists({ job: r.job })) ? r.job : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  return new Promise((r) => document.addEventListener('visibilitychange', () => !document.hidden && r(), { once: true }));
}

export interface GifProgress {
  ratio: number;
  label: string;
}

async function waitAndImport(p: Pending, onProgress: (g: GifProgress) => void, signal: { cancelled: boolean }): Promise<{ blob: Blob; id: string }> {
  active.add(p.jobId);
  try {
    let failures = 0;
    for (;;) {
      if (signal.cancelled) throw new DOMException('cancelled', 'AbortError');
      await whenVisible();
      let st;
      try {
        st = await jobStatus(p.jobId);
        failures = 0;
      } catch (e) {
        if (e instanceof ApiError && e.status && e.status !== 503) throw e;
        if (++failures > 20) throw e;
        await sleep(3000);
        continue;
      }
      if (st.state === 'error') throw new ApiError(st.error ?? 'サーバーでの変換に失敗しました');
      if (st.state === 'done') {
        const blob = await jobFile(st.id, (r) => onProgress({ ratio: 0.95 + r * 0.05, label: '受信中…' }));
        const id = newId();
        await putMedia({
          id,
          kind: 'gif',
          blob,
          name: st.result?.name ?? `${p.name}.gif`,
          title: p.name,
          width: p.params.width,
          height: p.params.height,
          duration: p.params.end - p.params.start,
          createdAt: Date.now(),
        });
        savePending(loadPending().filter((x) => x.jobId !== p.jobId));
        return { blob, id };
      }
      const pct = st.pct ?? 0;
      onProgress(
        st.stage === 'gif'
          ? { ratio: 0.15 + (pct / 100) * 0.8, label: `サーバーで変換中 ${pct}%` }
          : st.stage === 'palette'
            ? { ratio: 0.1, label: 'サーバーで色を分析中…' }
            : st.stage === 'store'
              ? { ratio: 0.95, label: 'サーバーに保存中…' }
              : { ratio: 0.05, label: 'サーバーで準備中…' },
      );
      await sleep(1200);
    }
  } finally {
    active.delete(p.jobId);
  }
}

/** サーバーで GIF を作る。完了すると履歴にも保存する */
export async function runServerGif(
  sourceJob: string,
  params: GifJobParams,
  name: string,
  onProgress: (g: GifProgress) => void,
  signal: { cancelled: boolean },
): Promise<{ blob: Blob; id: string }> {
  onProgress({ ratio: 0.02, label: 'サーバーに依頼中…' });
  const st = await startGifJob({ job: sourceJob }, params, name, subscriptionFor('gif'));
  const p: Pending = { jobId: st.id, name, params, createdAt: Date.now() };
  savePending([...loadPending(), p]);
  try {
    return await waitAndImport(p, onProgress, signal);
  } catch (e) {
    // 待つのをやめた場合は、あとで結果を取り込まない
    if ((e as Error).name === 'AbortError') savePending(loadPending().filter((x) => x.jobId !== p.jobId));
    throw e;
  }
}

/** アプリを開き直したとき、裏で終わっていた GIF を履歴に取り込む */
export function resumePendingGifJobs(): void {
  const list = loadPending().filter((p) => Date.now() - p.createdAt < REMOTE_TTL);
  savePending(list);
  for (const p of list) {
    if (active.has(p.jobId)) continue;
    waitAndImport(p, () => {}, { cancelled: false })
      .then(() => toast(`GIF変換が完了しました：${p.name.slice(0, 20)}（履歴に保存）`))
      .catch((e) => {
        savePending(loadPending().filter((x) => x.jobId !== p.jobId));
        toast(`GIF変換に失敗しました：${(e as Error).message.slice(0, 60)}`);
      });
  }
}
