"""サーバー側で最後まで処理するジョブ（アプリを閉じても続く）。

状態は Cloud Storage の jobs/<id>/status.json に置くので、どのインスタンスからでも問い合わせられる。
Cloud Run は「インスタンスベースの課金」（CPU を常に割り当て）にしておく必要がある。
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

from . import push, storage

log = logging.getLogger("jobs")
_local: dict[str, dict] = {}  # このインスタンスで処理中のジョブ（問い合わせを速くするため）
_slots = threading.Semaphore(2)  # 同時に重い処理をするのは2件まで

Emit = Callable[[dict], None]
# 処理本体：作業フォルダと進捗通知を受け取り、(出来たファイル, ファイル名, Content-Type) を返す
Runner = Callable[[Path, Emit], tuple[Path, str, str]]


def status_name(job_id: str) -> str:
    return f"jobs/{job_id}/status.json"


def get(job_id: str) -> dict | None:
    return _local.get(job_id) or storage.get_json(status_name(job_id))


def start(kind: str, title: str, runner: Runner, notify: dict | None, done_text: str) -> dict:
    job = {
        "id": uuid.uuid4().hex,
        "type": kind,
        "title": title,
        "state": "queued",
        "stage": "queued",
        "pct": None,
        "createdAt": int(time.time() * 1000),
    }
    _local[job["id"]] = job
    storage.put_json(status_name(job["id"]), job)
    threading.Thread(target=_run, args=(job, runner, notify, done_text), daemon=True).start()
    return job


def _run(job: dict, runner: Runner, notify: dict | None, done_text: str) -> None:
    last_save = 0.0

    def save(force: bool = False) -> None:
        nonlocal last_save
        now = time.time()
        if force or now - last_save > 3:
            last_save = now
            storage.put_json(status_name(job["id"]), job)

    def emit(ev: dict) -> None:
        if ev.get("type") != "progress":
            return
        job["stage"] = ev.get("stage")
        job["pct"] = ev.get("pct")
        job["part"] = ev.get("part")
        save()

    workdir = Path(tempfile.mkdtemp(prefix=f"job-{job['id'][:8]}-"))
    with _slots:
        try:
            job["state"] = "running"
            save(True)
            path, name, ctype = runner(workdir, emit)
            job["stage"] = "store"
            job["pct"] = None
            save(True)
            obj = f"jobs/{job['id']}/{'out.gif' if ctype == 'image/gif' else 'out.mp4'}"
            storage.upload_file(obj, path, ctype)
            job["result"] = {"object": obj, "name": name, "size": path.stat().st_size, "contentType": ctype}
            job["state"] = "done"
            job["stage"] = "done"
            save(True)
            if notify:
                job["push"] = push.send(notify, done_text, name)[1]
                save(True)
        except Exception as e:  # noqa: BLE001
            log.exception("job failed")
            from .main import friendly_detail

            job["state"] = "error"
            job["error"] = friendly_detail(e)
            save(True)
            if notify:
                job["push"] = push.send(notify, "処理に失敗しました", f"{job['title']}：{job['error'][:80]}")[1]
                save(True)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            _local.pop(job["id"], None)
