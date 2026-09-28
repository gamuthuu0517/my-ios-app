export interface Settings {
  serverUrl: string;
  passphrase: string;
  gifScalePercent: number;
  gifDither: boolean;
  sizeWarnMB: number;
  debugConsole: boolean;
  notifyDownload: boolean;
  notifyGif: boolean;
}

const KEY = 'clipkit.settings.v1';

export const defaultSettings: Settings = {
  serverUrl: '',
  passphrase: '',
  gifScalePercent: 50,
  gifDither: true,
  sizeWarnMB: 20,
  debugConsole: false,
  notifyDownload: true,
  notifyGif: true,
};

const DEBUG_RESET_KEY = 'clipkit.debugReset.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s: Settings = { ...defaultSettings, ...JSON.parse(raw) };
      // v0.9.3：調査用に付けたままだったデバッグ表示を一度だけオフに戻す
      if (!localStorage.getItem(DEBUG_RESET_KEY)) {
        localStorage.setItem(DEBUG_RESET_KEY, '1');
        if (s.debugConsole) {
          s.debugConsole = false;
          localStorage.setItem(KEY, JSON.stringify(s));
        }
      }
      return s;
    }
  } catch {
    // ストレージが使えない環境では既定値で動かす
  }
  return { ...defaultSettings };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても動作は継続する
  }
}
