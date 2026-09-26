/** 動画の先頭付近から縮小サムネイル（JPEG）を作る。失敗時は undefined */
export function makeVideoThumb(blob: Blob, width = 240): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const finish = (b?: Blob) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(b);
    };
    const timer = setTimeout(() => finish(), 8000);
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    });
    video.addEventListener('seeked', () => {
      const w = Math.min(width, video.videoWidth || width);
      const h = Math.round(((video.videoHeight || 9) / (video.videoWidth || 16)) * w);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return finish();
      ctx.drawImage(video, 0, 0, w, h);
      canvas.toBlob((b) => finish(b ?? undefined), 'image/jpeg', 0.8);
    });
    video.addEventListener('error', () => finish());
  });
}
