"""サーバー側で最後まで処理するジョブ（アプリを閉じても続く）。

状態は Cloud Storage の jobs/<id>/status.json に置くので、どのインスタンスからでも問い合わせられる。
処理は応答後のスレッドで続けるため、Cloud Run は「インスタンスベースの課金」（CPU を常に割り当て）が必須。
それでもインスタンスが止められた場合に備え、20秒ごとに生存確認を書き、途絶えたジョブは get() で中断扱いにする。
（より確実にするなら Cloud Tasks / Cloud Run Jobs へ移す。README の「今後の課題」参照）
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


STALE_SEC = 120  # この時間、生存確認が更新されなければ中断とみなす


def get(job_id: str) -> dict | None:
    if job_id in _local:
        return _local[job_id]
    st = storage.get_json(status_name(job_id))
    # 処理していたインスタンスが止められた場合、状態が「処理中」のまま残る。
    # 生存確認（updatedAt）が途絶えていたら中断として返し、アプリから再試行できるようにする
    if st and st.get("state") in ("queued", "running"):
        if time.time() * 1000 - st.get("updatedAt", st.get("createdAt", 0)) > STALE_SEC * 1000:
            st["state"] = "error"
            st["error"] = "サーバーの処理が中断されました。再試行してください"
            storage.put_json(status_name(job_id), st)
    return st


def start(kind: str, title: str, runner: Runner, notify: dict | None, done_text: str) -> dict:
    job = {
        "id": uuid.uuid4().hex,
        "type": kind,
        "title": title,
        "state": "queued",
        "stage": "queued",
        "pct": None,
        "createdAt": int(time.time() * 1000),
        "updatedAt": int(time.time() * 1000),
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
            job["updatedAt"] = int(now * 1000)
            storage.put_json(status_name(job["id"]), job)

    # 進捗が出ない工程（解析・色の分析など）でも生存確認を更新し続ける
    stop = threading.Event()

    def heartbeat() -> None:
        while not stop.wait(20):
            try:
                save(True)
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=heartbeat, daemon=True).start()

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
                # 通知をタップしたら履歴の該当タブ（ダウンロード / GIF）を開く
                tab = "gif" if job["type"] == "gif" else "video"
                job["push"] = push.send(notify, done_text, name, f"./#history?tab={tab}")[1]
                save(True)
        except Exception as e:  # noqa: BLE001
            log.exception("job failed")
            from .main import friendly_detail

            job["state"] = "error"
            job["error"] = friendly_detail(e)
            save(True)
            if notify:
                page = "#gif" if job["type"] == "gif" else "#download"
                job["push"] = push.send(notify, "処理に失敗しました", f"{job['title']}：{job['error'][:80]}", f"./{page}")[1]
                save(True)
        finally:
            stop.set()
            shutil.rmtree(workdir, ignore_errors=True)
            _local.pop(job["id"], None)
