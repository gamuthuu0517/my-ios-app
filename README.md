# ClipKit

iPhone 向け PWA：SNS 動画ダウンロード & GIF 変換（個人利用）。

- 仕様書：[docs/SPEC.md](docs/SPEC.md)
- `web/`：PWA 本体（TypeScript + Vite）。`main` へ push すると GitHub Pages に自動公開
- `server/`：ダウンロードサーバー（Cloud Run、`server/Dockerfile` でビルド。環境変数 `PASSPHRASE` / `ALLOWED_ORIGIN`）

## 開発

```sh
cd web
npm ci
npm run dev
```
