export interface Settings {
  serverUrl: string;
  passphrase: string;
  gifScalePercent: number;
  gifDither: boolean;
  sizeWarnMB: number;
  debugConsole: boolean;
}

const KEY = 'clipkit.settings.v1';

export const defaultSettings: Settings = {
  serverUrl: '',
  passphrase: '',
  gifScalePercent: 50,
  gifDither: true,
  sizeWarnMB: 20,
  debugConsole: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
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
