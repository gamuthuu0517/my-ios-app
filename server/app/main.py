"""ClipKit ダウンロードサーバー（Cloud Run 用）

- POST /api/extract  : URL を解析し、投稿内の動画一覧と選べる画質を返す
- POST /api/download : 指定した動画・画質を iPhone で扱える mp4（H.264 + AAC）で返す
全 API は X-Passphrase ヘッダーの合言葉が一致したときだけ応答する。
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote, urlparse

import yt_dlp
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import jobs, push, storage
from .gif import GifParams, make_gif

PASSPHRASE = os.environ.get("PASSPHRASE", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGIN", "").split(",") if o.strip()]
MAX_ENTRIES = 50

ALLOWED_HOSTS = re.compile(
    r"(^|\.)(twitter\.com|x\.com|tiktok\.com|instagram\.com)$", re.I
)

app = FastAPI(title="ClipKit server")


@app.exception_handler(Exception)
async def storage_unavailable(_request, exc: Exception):
    """Cloud Storage の一時的な障害は 503 で返す（アプリは 503 なら待って再確認する）"""
    from fastapi.responses import JSONResponse
    from google.api_core.exceptions import GoogleAPICallError, RetryError

    if isinstance(exc, (GoogleAPICallError, RetryError, TimeoutError, ConnectionError)):
        return JSONResponse({"detail": "一時保管場所に一時的に接続できません。しばらくして再確認します"}, status_code=503)
    raise exc
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Passphrase"],
    expose_headers=["Content-Disposition", "Content-Length"],
    max_age=86400,
)


def require_passphrase(x_passphrase: str = Header(default="")) -> None:
    # 合言葉が未設定のときは全て拒否する（設定漏れで誰でも使える状態にしない）
    if not PASSPHRASE or not hmac.compare_digest(x_passphrase.encode(), PASSPHRASE.encode()):
        raise HTTPException(status_code=401, detail="合言葉が正しくありません")


# 端末がそのまま再生・保存できる映像コーデック（アプリが端末を調べて送ってくる）
Codec = str  # "h264" | "hevc" | "av1"


class ExtractRequest(BaseModel):
    url: str
    accept: list[Codec] = ["h264"]


class DownloadRequest(BaseModel):
    url: str
    index: int | None = None  # 複数動画の投稿で何番目か（0 始まり）
    height: int | None = None  # 画質（縦の画素数）。None なら最高画質
    accept: list[Codec] = ["h264"]


def check_url(url: str) -> str:
    url = url.strip()
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or not ALLOWED_HOSTS.search(host):
        raise HTTPException(status_code=400, detail="対応していないURLです")
    return url


def base_opts() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "playlistend": MAX_ENTRIES,
        "socket_timeout": 30,
    }


def codec_family(vcodec: str | None) -> str | None:
    """yt-dlp の vcodec 表記を h264 / hevc / av1 / vp9 などにまとめる。不明なら None"""
    if not vcodec or vcodec == "none":
        return None
    c = vcodec.lower().split(".")[0]
    if c in ("avc1", "avc3", "h264"):
        return "h264"
    if c in ("hvc1", "hev1", "h265", "hevc", "bytevc1"):
        return "hevc"
    if c in ("av01", "av1"):
        return "av1"
    if c.startswith("vp"):
        return "vp9"
    return c


def is_direct(f: dict, accept: list[str]) -> bool:
    """変換せずに端末へ渡せそうか。コーデック不明の mp4 は H.264 のことが多い（Instagram など）ので候補に含める"""
    fam = codec_family(f.get("vcodec"))
    if fam is None:
        return f.get("ext") in ("mp4", "mov", None)
    return fam in accept


def quality_options(info: dict, accept: list[str]) -> list[dict]:
    heights: dict[int, bool] = {}
    for f in info.get("formats") or []:
        h = f.get("height")
        if not h or f.get("vcodec") == "none":
            continue
        heights[h] = heights.get(h, False) or is_direct(f, accept)
    # h264 は旧バージョンのアプリ向け（意味は「変換不要」）
    return [{"height": h, "direct": ok, "h264": ok} for h, ok in sorted(heights.items(), reverse=True)]


def summarize(entry: dict, index: int | None, accept: list[str]) -> dict:
    return {
        "index": index,
        "id": entry.get("id"),
        "title": entry.get("title") or entry.get("id") or "video",
        "thumbnail": entry.get("thumbnail"),
        "duration": entry.get("duration"),
        "width": entry.get("width"),
        "height": entry.get("height"),
        "qualities": quality_options(entry, accept),
    }


def friendly_error(e: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=friendly_detail(e))


def friendly_detail(e: Exception) -> str:
    msg = str(e)
    if re.search(r"not a bot|confirm you", msg, re.I):
        detail = "サービス側にサーバーからのアクセスを拒否されました（ボット判定）。時間をおくか、別の動画でお試しください"
    elif re.search(r"login|log in|sign in|private|cookies", msg, re.I):
        detail = "ログインが必要な投稿、または非公開の投稿のため取得できません"
    elif re.search(r"429|rate.?limit|too many", msg, re.I):
        detail = "サービス側でアクセスが制限されています。時間をおいて再度お試しください"
    elif re.search(r"no video|unsupported url|no media", msg, re.I):
        detail = "この投稿には取得できる動画がありません"
    else:
        detail = "動画を取得できませんでした"
    return f"{detail}（{msg[-300:]}）"


def _mem_limit_gib() -> float | None:
    for f in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            v = open(f).read().strip()
            if v.isdigit() and int(v) < 1024**4:  # 上限なしの場合は巨大な値になる
                return round(int(v) / 1024**3, 2)
        except OSError:
            pass
    return None


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "yt_dlp": yt_dlp.version.__version__,
        "cpus": len(os.sched_getaffinity(0)),
        "memory_gib": _mem_limit_gib(),
        "storage": storage.enabled(),
    }


@app.post("/api/extract", dependencies=[Depends(require_passphrase)])
async def extract(req: ExtractRequest) -> dict:
    url = check_url(req.url)

    def run() -> dict:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            return ydl.sanitize_info(ydl.extract_info(url, download=False))

    try:
        info = await run_in_threadpool(run)
    except yt_dlp.utils.DownloadError as e:
        raise friendly_error(e) from e

    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        items = [summarize(e, i, req.accept) for i, e in enumerate(entries)]
    else:
        items = [summarize(info, None, req.accept)]
    if not items:
        raise HTTPException(status_code=422, detail="この投稿には取得できる動画がありません")
    return {"title": info.get("title"), "extractor": info.get("extractor_key"), "items": items}


def probe(path: Path) -> tuple[str, str, float]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    streams = data.get("streams", [])
    v = next((s["codec_name"] for s in streams if s.get("codec_type") == "video"), "")
    a = next((s["codec_name"] for s in streams if s.get("codec_type") == "audio"), "")
    return v, a, float(data.get("format", {}).get("duration") or 0)


def to_iphone_mp4(src: Path, dst: Path, accept: list[str], emit=lambda _: None) -> Path:
    """端末で再生・保存できる mp4 にそろえる。端末が扱えるコーデックなら再エンコードせず入れ物だけ整える"""
    v, a, duration = probe(src)
    fam = {"h264": "h264", "hevc": "hevc", "av1": "av1"}.get(v)
    transcode = fam is None or fam not in accept
    if not transcode:
        vargs = ["-c:v", "copy"]
        if fam == "hevc":
            vargs += ["-tag:v", "hvc1"]  # Apple 製品は hvc1 タグでないと再生できない
    else:
        vargs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "0"]
    aargs = ["-c:a", "copy"] if a in ("aac", "") else ["-c:a", "aac", "-b:a", "192k"]
    emit({"type": "progress", "stage": "convert" if transcode else "finalize", "pct": 0})
    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
         *vargs, *aargs, "-movflags", "+faststart", str(dst)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration > 0:
            try:
                sec = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            emit({"type": "progress", "stage": "convert" if transcode else "finalize", "pct": min(99, round(sec / duration * 100))})
    if proc.wait() != 0:
        raise RuntimeError(f"ffmpeg failed: {proc.stderr.read()[-300:] if proc.stderr else ''}")
    return dst


def fetch_video(req: "DownloadRequest", workdir: Path, emit=lambda _: None) -> tuple[Path, str]:
    """yt-dlp で取得し、iPhone 向け mp4 にして (パス, タイトル) を返す"""
    url = check_url(req.url)
    res = f"res:{req.height}" if req.height else "res"
    part = {"n": 0}

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            emit({"type": "progress", "stage": "download", "part": part["n"] + 1,
                  "pct": round(done / total * 100) if total else None})
        elif d.get("status") == "finished":
            part["n"] += 1

    opts = {
        **base_opts(),
        "outtmpl": str(workdir / "src.%(ext)s"),
        "format": format_selector(req.height, req.accept),
        # 同じ条件の中では画質の高いものを選び、同じ画質なら H.264 / AAC / mp4 を優先する
        "format_sort": [res, "vcodec:h264", "acodec:aac", "ext:mp4:m4a"],
        "merge_output_format": "mp4",
        "progress_hooks": [hook],
    }
    if req.index is not None:
        opts["playlist_items"] = str(req.index + 1)
        opts["noplaylist"] = False

    emit({"type": "progress", "stage": "prepare"})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    if info.get("_type") == "playlist":
        info = next((e for e in (info.get("entries") or []) if e), {})
    src = next((p for p in workdir.iterdir() if p.name.startswith("src.")), None)
    if src is None:
        raise yt_dlp.utils.DownloadError("no media downloaded")
    out = to_iphone_mp4(src, workdir / "out.mp4", req.accept, emit)
    src.unlink(missing_ok=True)
    return out, info.get("title") or info.get("id") or "video"


def format_selector(height: int | None, accept: list[str]) -> str:
    """変換せずに済む形式（端末が扱えるコーデック・不明な mp4）を優先し、無ければ何でも取って後で変換する"""
    hf = f"[height<=?{height}]" if height else ""
    # 「?」はコーデック不明のものも通す指定
    ng = "[vcodec!*=?vp]"
    if "av1" not in accept:
        ng += "[vcodec!*=?av01]"
    if "hevc" not in accept:
        ng += "[vcodec!*=?hvc1][vcodec!*=?hev1][vcodec!*=?h265][vcodec!*=?hevc]"
    return f"bv*{hf}{ng}+ba/b{hf}{ng}/bv*{hf}+ba/b{hf}/bv*+ba/b"


def safe_name(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|\r\n]+', "_", title).strip()[:80].rstrip(". ") or "video"


@app.post("/api/fetch", dependencies=[Depends(require_passphrase)])
async def fetch(req: DownloadRequest) -> StreamingResponse:
    """進捗を JSON 行で送り続け、最後に {"type":"file","size":N} の行と mp4 本体 N バイトを送る。
    処理中も通信が途切れないため、長い変換でもスマホ側で切断されにくい。"""
    check_url(req.url)
    workdir = Path(tempfile.mkdtemp(prefix="clipkit-"))
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    done = object()

    def emit(obj: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, obj)

    def worker():
        try:
            return fetch_video(req, workdir, emit)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, done)

    async def stream():
        task = loop.run_in_executor(None, worker)
        try:
            last = None
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=5)
                except asyncio.TimeoutError:
                    yield b'{"type":"ping"}\n'
                    continue
                if item is done:
                    break
                if item != last:  # 同じ進捗は送らない
                    last = item
                    yield (json.dumps(item, ensure_ascii=False) + "\n").encode()
            try:
                path, title = await task
            except yt_dlp.utils.DownloadError as e:
                yield (json.dumps({"type": "error", "detail": friendly_error(e).detail}, ensure_ascii=False) + "\n").encode()
                return
            except Exception as e:  # noqa: BLE001
                yield (json.dumps({"type": "error", "detail": f"変換に失敗しました（{str(e)[-200:]}）"}, ensure_ascii=False) + "\n").encode()
                return
            size = path.stat().st_size
            yield (json.dumps({"type": "file", "name": f"{safe_name(title)}.mp4", "size": size}, ensure_ascii=False) + "\n").encode()
            with path.open("rb") as f:
                while chunk := f.read(1024 * 256):
                    yield chunk
        finally:
            # 途中で切断されても、取得処理が終わった時点で一時ファイルを消す
            if task.done():
                shutil.rmtree(workdir, ignore_errors=True)
            else:
                task.add_done_callback(lambda _: shutil.rmtree(workdir, ignore_errors=True))

    return StreamingResponse(stream(), media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


@app.post("/api/download", dependencies=[Depends(require_passphrase)])
async def download(req: DownloadRequest) -> FileResponse:
    """旧形式（ファイルのみ返す）。互換のため残している"""
    check_url(req.url)
    workdir = Path(tempfile.mkdtemp(prefix="clipkit-"))
    try:
        path, title = await run_in_threadpool(fetch_video, req, workdir)
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise friendly_error(e) from e
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={"Content-Disposition": f"attachment; filename=\"video.mp4\"; filename*=UTF-8''{quote(safe_name(title))}.mp4"},
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )


# ---------------------------------------------------------------------------
# サーバー側で最後まで処理するジョブ（アプリを閉じても続き、完了時に通知する）

class JobDownloadRequest(DownloadRequest):
    title: str = "動画"
    notify: dict | None = None  # Web Push の購読情報（通知しない場合は null）


class GifSource(BaseModel):
    job: str | None = None  # ダウンロードジョブの結果を使う
    upload: str | None = None  # アップロードした動画を使う


class JobGifRequest(BaseModel):
    source: GifSource
    params: GifParams
    name: str = "animation"
    notify: dict | None = None


class UploadRequest(BaseModel):
    size: int
    contentType: str = "video/mp4"


def require_storage() -> None:
    if not storage.enabled():
        raise HTTPException(status_code=503, detail="サーバーの一時保管場所（Cloud Storage）が未設定です")


def source_object(src: GifSource) -> str | None:
    if src.job:
        st = jobs.get(src.job)
        return (st or {}).get("result", {}).get("object")
    if src.upload:
        return f"uploads/{src.upload}/src"
    return None


@app.post("/api/jobs/download", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def job_download(req: JobDownloadRequest) -> dict:
    check_url(req.url)

    def runner(workdir: Path, emit):
        path, title = fetch_video(req, workdir, emit)
        return path, f"{safe_name(title)}.mp4", "video/mp4"

    return jobs.start("download", req.title, runner, req.notify, "ダウンロードが完了しました")


@app.post("/api/jobs/gif", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def job_gif(req: JobGifRequest) -> dict:
    obj = source_object(req.source)
    if not obj or not storage.exists(obj):
        raise HTTPException(status_code=404, detail="元動画がサーバーにありません")

    def runner(workdir: Path, emit):
        src = workdir / "src"
        emit({"type": "progress", "stage": "prepare"})
        if not storage.download_file(obj, src):
            raise RuntimeError("元動画を読み込めませんでした")
        return make_gif(src, req.params, workdir, emit), f"{safe_name(req.name)}.gif", "image/gif"

    return jobs.start("gif", req.name, runner, req.notify, "GIF変換が完了しました")


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def job_status(job_id: str) -> dict:
    st = jobs.get(job_id)
    if not st:
        raise HTTPException(status_code=404, detail="処理が見つかりません（期限切れの可能性があります）")
    return st


@app.get("/api/jobs/{job_id}/file", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def job_file(job_id: str) -> StreamingResponse:
    st = jobs.get(job_id)
    res = (st or {}).get("result")
    if not res:
        raise HTTPException(status_code=404, detail="ファイルがありません")
    blob, reader = storage.open_read(res["object"])

    def chunks():
        with reader:
            while chunk := reader.read(1024 * 1024):
                yield chunk

    return StreamingResponse(
        chunks(),
        media_type=res["contentType"],
        headers={"Content-Length": str(blob.size), "Cache-Control": "no-store"},
    )


@app.post("/api/sources/check", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def source_check(src: GifSource) -> dict:
    obj = source_object(src)
    return {"exists": bool(obj and storage.exists(obj))}


@app.post("/api/uploads", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def upload_start(req: UploadRequest, origin: str | None = Header(default=None)) -> dict:
    upload_id = uuid.uuid4().hex
    url = storage.resumable_upload_url(f"uploads/{upload_id}/src", req.contentType, req.size, origin)
    return {"id": upload_id, "url": url}


@app.get("/api/push/key", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def push_key() -> dict:
    return {"key": push.public_key()}


class PushTestRequest(BaseModel):
    subscription: dict


@app.post("/api/push/test", dependencies=[Depends(require_passphrase), Depends(require_storage)])
def push_test(req: PushTestRequest) -> dict:
    ok, detail = push.send(req.subscription, "ClipKit テスト通知", "通知は正しく届いています", "./#settings")
    return {"ok": ok, "detail": detail}
