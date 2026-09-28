# ClipKit

iPhone 向け PWA：SNS 動画ダウンロード & GIF 変換（個人利用）。

- 仕様書：[docs/SPEC.md](docs/SPEC.md)
- `web/`：PWA 本体（TypeScript + Vite）。`main` へ push すると GitHub Pages に自動公開
- `server/`：ダウンロード・GIF 変換サーバー（Cloud Run。リポジトリ直下の `Dockerfile` でビルド）

## 開発

```sh
cd web
npm ci
npm run dev
```

## サーバーの設置（Cloud Run）— すべて必須

アプリを閉じても続くダウンロード / GIF 変換と完了通知は、以下がそろって初めて動く。
`BUCKET` が無いと `/api/jobs/*`・`/api/push/*` は 503 になり、ダウンロードは画面を開いている間だけの方式に、
GIF 変換は端末内のみになり、通知も使えない。

1. **Cloud Storage バケット**
   - 例：`<project>-media`、リージョン `asia-northeast1`、公開アクセスの防止オン、均一アクセス
   - 削除（復元可能）ポリシーはオフ推奨
   - ライフサイクルはサーバーが起動時に自動で設定する（`jobs/` と `uploads/` を 1 日で削除。
     `config/`（通知用の鍵）は残す）。手動で「バケット全体を 1 日で削除」にすると通知用の鍵まで消えるので注意
2. **権限**：Cloud Run の実行サービスアカウント（既定は Compute Engine のデフォルト SA）に、バケットへの
   `Storage オブジェクト管理者` と、ライフサイクル設定用の `storage.buckets.update`（`Storage 管理者` など）
3. **Cloud Run サービス設定**

   | 項目 | 値 |
   |---|---|
   | 課金 | **インスタンスベース**（応答後もジョブのスレッドに CPU を割り当てるため必須） |
   | 最小 / 最大インスタンス | 0 / 2 |
   | CPU / メモリ | 4 / 4 GiB |
   | リクエストのタイムアウト | 900 秒 |
   | 認証 | 未認証の呼び出しを許可（アプリの合言葉で保護） |

4. **環境変数**

   | 名前 | 内容 |
   |---|---|
   | `PASSPHRASE` | アプリの合言葉（必須。未設定だと全 API が 401） |
   | `ALLOWED_ORIGIN` | `https://<user>.github.io`（CORS を許可するオリジン） |
   | `BUCKET` | 上で作ったバケット名 |
   | `VAPID_SUBJECT` | 任意。通知の送信者連絡先（`mailto:` 形式のみ） |

## サーバーの動作確認

`GET /api/health` が `{"ok": true, "storage": true, ...}` を返せば起動しており、バケットも設定済み（合言葉は不要）。

## 今後の課題

- ジョブは応答後のスレッドで実行しているため、インスタンスが止められると中断する
  （生存確認が 2 分途絶えたジョブは「中断」として返し、アプリから再試行できる）。
  より確実にするなら Cloud Tasks / Cloud Run Jobs に移す
