// この端末がそのまま再生・保存できる映像コーデックを調べる（サーバーが変換の要否を決めるのに使う）

const PROBES: Record<'hevc' | 'av1', string> = {
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
};

let cached: string[] | null = null;

export async function acceptedCodecs(): Promise<string[]> {
  if (cached) return cached;
  const out = ['h264'];
  const v = document.createElement('video');
  for (const [name, type] of Object.entries(PROBES)) {
    let ok = v.canPlayType(type) === 'probably';
    // 実際にハードウェアで再生できるか（AV1 は対応チップが無いと再生できない）
    try {
      const info = await navigator.mediaCapabilities?.decodingInfo({
        type: 'file',
        video: { contentType: type, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 },
      });
      if (info) ok = info.supported && (name !== 'av1' || info.powerEfficient);
    } catch {
      // 調べられなければ canPlayType の結果を使う
    }
    if (ok) out.push(name);
  }
  cached = out;
  return out;
}
