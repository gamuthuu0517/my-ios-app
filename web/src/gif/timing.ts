// GIF のフレーム時刻と表示間隔（1/100 秒単位）の計算

/** 出力する各フレームの元動画上の時刻（区間の中央を取って境界の取り違えを防ぐ） */
export function frameTimes(start: number, end: number, fps: number): number[] {
  const n = Math.max(1, Math.round((end - start) * fps));
  return Array.from({ length: n }, (_, i) => Math.min(end - 0.001, start + (i + 0.5) / fps));
}

/**
 * 各フレームの表示間隔（centisecond）。累積時刻を丸めて差を取るので、
 * 30fps なら 3,4,3,3,4,3… となり平均がちょうど 33.3ms になる（長くてもズレが溜まらない）。
 */
export function frameDelaysCs(count: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(((i + 1) * 100) / fps) - Math.round((i * 100) / fps));
  }
  return out;
}

export function outputSize(srcW: number, srcH: number, percent: number): { w: number; h: number } {
  const s = percent / 100;
  return { w: Math.max(1, Math.round(srcW * s)), h: Math.max(1, Math.round(srcH * s)) };
}
