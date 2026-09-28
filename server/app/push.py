"""プッシュ通知（Web Push）。鍵は初回に自動で作ってバケットに保存する（リポジトリには置かない）。"""

from __future__ import annotations

import base64
import json
import logging
import os
from functools import lru_cache

from . import storage

KEY_OBJECT = "config/vapid_private.pem"
# 通知サービスに伝える連絡先（アプリの URL）
SUBJECT = os.environ.get("VAPID_SUBJECT", "https://gamuthuu0517.github.io/my-ios-app/")
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


def send(subscription: dict | None, title: str, body: str, url: str = "./#history") -> None:
    if not subscription:
        return
    try:
        from pywebpush import webpush

        webpush(
            subscription_info=subscription,
            data=json.dumps({"title": title, "body": body, "url": url}, ensure_ascii=False),
            vapid_private_key=vapid(),
            vapid_claims={"sub": SUBJECT},
            ttl=86400,
            timeout=10,
        )
    except Exception as e:  # noqa: BLE001 通知の失敗で処理全体を失敗にしない
        log.warning("push failed: %s", e)
