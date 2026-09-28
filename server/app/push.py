"""プッシュ通知（Web Push）。鍵は初回に自動で作ってバケットに保存する（リポジトリには置かない）。"""

from __future__ import annotations

import base64
import json
import logging
import os
from functools import lru_cache

from . import storage

KEY_OBJECT = "config/vapid_private.pem"
# 通知サービスに伝える送信者の連絡先。送信に使う部品（pywebpush）は mailto: 形式しか受け付けない
SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:clipkit@example.com")
log = logging.getLogger("push")


@lru_cache
def vapid():
    from py_vapid import Vapid

    blob = storage.bucket().blob(KEY_OBJECT)
    if blob.exists():
        return Vapid.from_pem(blob.download_as_bytes())
    v = Vapid()
    v.generate_keys()
    blob.upload_from_string(v.private_pem(), content_type="application/x-pem-file")
    return v


def public_key() -> str:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    raw = vapid().public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def send(subscription: dict | None, title: str, body: str, url: str = "./#history") -> tuple[bool, str]:
    """通知を送る。(成功したか, 結果の説明) を返す"""
    if not subscription:
        return False, "通知先が登録されていません"
    try:
        from pywebpush import WebPushException, webpush

        res = webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "url": url}, ensure_ascii=False),
            vapid_private_key=vapid(),
            vapid_claims={"sub": SUBJECT},
            ttl=86400,
            timeout=10,
        )
        return True, f"送信しました（{getattr(res, 'status_code', '')}）"
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        text = (getattr(e.response, "text", "") or "")[:200]
        log.warning("push failed: %s %s", status, text)
        if status in (404, 410):
            return False, "通知の登録が無効になっています。設定画面で「通知を許可する」をもう一度押してください"
        return False, f"通知サービスに拒否されました（{status}：{text or e}）"
    except Exception as e:  # noqa: BLE001 通知の失敗で処理全体を失敗にしない
        log.warning("push failed: %s", e)
        return False, f"通知を送れませんでした（{e}）"
