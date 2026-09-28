"""Cloud Storage（一時保管場所）の読み書き。バケット名は環境変数 BUCKET で指定する。"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

BUCKET = os.environ.get("BUCKET", "")


def enabled() -> bool:
    return bool(BUCKET)


@lru_cache
def bucket():
    from google.cloud import storage  # 起動を軽くするため必要になってから読み込む

    return storage.Client().bucket(BUCKET)


def put_json(name: str, data: dict) -> None:
    bucket().blob(name).upload_from_string(json.dumps(data, ensure_ascii=False), content_type="application/json")


def get_json(name: str) -> dict | None:
    blob = bucket().blob(name)
    try:
        return json.loads(blob.download_as_bytes())
    except Exception:  # noqa: BLE001 見つからない場合など
        return None


def upload_file(name: str, path: Path, content_type: str) -> None:
    blob = bucket().blob(name)
    blob.chunk_size = 16 * 1024 * 1024
    blob.upload_from_filename(str(path), content_type=content_type)


def download_file(name: str, path: Path) -> bool:
    blob = bucket().blob(name)
    try:
        blob.download_to_filename(str(path))
        return True
    except Exception:  # noqa: BLE001
        return False


def exists(name: str) -> bool:
    return bucket().blob(name).exists()


def open_read(name: str):
    """ファイルを少しずつ読むためのストリーム（大きな動画をそのまま返すため）"""
    blob = bucket().blob(name)
    blob.reload()
    return blob, blob.open("rb", chunk_size=1024 * 1024)


def delete_prefix(prefix: str) -> None:
    for b in bucket().list_blobs(prefix=prefix):
        b.delete()


def resumable_upload_url(name: str, content_type: str, size: int, origin: str | None) -> str:
    """スマホから直接アップロードするための URL（Cloud Run の 32MB 制限を避ける）"""
    blob = bucket().blob(name)
    return blob.create_resumable_upload_session(content_type=content_type, size=size, origin=origin)
