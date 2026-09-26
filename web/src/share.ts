import { toast } from './dom';

/** 共有シートを開く（「ビデオを保存」「画像を保存」で写真アプリへ） */
export async function shareFile(blob: Blob, name: string): Promise<boolean> {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return false;
    }
  }
  // 共有シートが使えない環境ではファイルとして保存
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast('ファイルとして保存しました');
  return true;
}
