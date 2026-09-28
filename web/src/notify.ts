// 完了通知（Web Push）。ホーム画面に追加したアプリで、通知を許可したときだけ使える。
import { pushKey, pushTest } from './api';
import { loadSettings } from './settings';

const KEY = 'clipkit.push.v1';

export function notifySupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function permission(): NotificationPermission | 'unsupported' {
  return notifySupported() ? Notification.permission : 'unsupported';
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '='));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** 通知を許可して購読する（ボタンを押したときに呼ぶ） */
export async function enableNotifications(): Promise<boolean> {
  if (!notifySupported()) return false;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const key = await pushKey();
  let sub = await reg.pushManager.getSubscription();
  // サーバーの鍵が変わっていたら購読し直す
  if (sub && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey);
    const want = b64ToBytes(key);
    if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) as BufferSource });
  try {
    localStorage.setItem(KEY, JSON.stringify(sub.toJSON()));
  } catch {
    // 保存できなくても今回の購読は使える
  }
  return true;
}

function stored(): PushSubscriptionJSON | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

/** テスト通知を送って結果の説明を返す */
export async function sendTestNotification(): Promise<{ ok: boolean; detail: string }> {
  const sub = stored();
  if (permission() !== 'granted' || !sub) return { ok: false, detail: '先に「通知を許可する」を押してください' };
  return pushTest(sub);
}

/** ジョブに添える購読情報。通知がオフ・未許可なら null */
export function subscriptionFor(kind: 'download' | 'gif'): PushSubscriptionJSON | null {
  const s = loadSettings();
  if (kind === 'download' ? !s.notifyDownload : !s.notifyGif) return null;
  if (permission() !== 'granted') return null;
  return stored();
}
