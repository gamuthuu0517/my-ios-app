"""ClipKit ダウンロードサーバー（Cloud Run 用）

- POST /api/extract  : URL を解析し、投稿内の動画一覧と選べる画質を返す
- POST /api/download : 指定した動画・画質を iPhone で扱える mp4（H.264 + AAC）で返す
全 API は X-Passphrase ヘッダーの合言葉が一致したときだけ応答する。
"""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote, urlparse

import yt_dlp
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

PASSPHRASE = os.environ.get("PASSPHRASE", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGIN", "").split(",") if o.strip()]
MAX_ENTRIES = 50

ALLOWED_HOSTS = re.compile(
    r"(^|\.)(twitter\.com|x\.com|tiktok\.com|instagram\.com|youtube\.com|youtu\.be)$", re.I
)

app = FastAPI(title="ClipKit server")
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


class ExtractRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    index: int | None = None  # 複数動画の投稿で何番目か（0 始まり）
    height: int | None = None  # 画質（縦の画素数）。None なら最高画質


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
        "noplaylist": True,  # YouTube の「再生リスト付きURL」は単体の動画として扱う
        "playlistend": MAX_ENTRIES,
        "socket_timeout": 30,
    }


def is_h264(vcodec: str | None) -> bool:
    return bool(vcodec) and vcodec.split(".")[0] in ("avc1", "avc3", "h264")


def quality_options(info: dict) -> list[dict]:
    heights: dict[int, bool] = {}
    for f in info.get("formats") or []:
        h = f.get("height")
        if not h or f.get("vcodec") == "none":
            continue
        heights[h] = heights.get(h, False) or is_h264(f.get("vcodec"))
    return [{"height": h, "h264": ok} for h, ok in sorted(heights.items(), reverse=True)]


def summarize(entry: dict, index: int | None) -> dict:
    return {
        "index": index,
        "id": entry.get("id"),
        "title": entry.get("title") or entry.get("id") or "video",
        "thumbnail": entry.get("thumbnail"),
        "duration": entry.get("duration"),
        "width": entry.get("width"),
        "height": entry.get("height"),
        "qualities": quality_options(entry),
    }


def friendly_error(e: Exception) -> HTTPException:
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
    return HTTPException(status_code=422, detail=f"{detail}（{msg[-300:]}）")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__}


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
        items = [summarize(e, i) for i, e in enumerate(entries)]
    else:
        items = [summarize(info, None)]
    if not items:
        raise HTTPException(status_code=422, detail="この投稿には取得できる動画がありません")
    return {"title": info.get("title"), "extractor": info.get("extractor_key"), "items": items}


def probe_codecs(path: Path) -> tuple[str, str]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    streams = json.loads(out).get("streams", [])
    v = next((s["codec_name"] for s in streams if s.get("codec_type") == "video"), "")
    a = next((s["codec_name"] for s in streams if s.get("codec_type") == "audio"), "")
    return v, a


def to_iphone_mp4(src: Path, dst: Path) -> Path:
    """写真アプリで扱える H.264 + AAC の mp4 にそろえる（既にそうなら再エンコードしない）"""
    v, a = probe_codecs(src)
    vargs = ["-c:v", "copy"] if v == "h264" else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
    aargs = ["-c:a", "copy"] if a in ("aac", "") else ["-c:a", "aac", "-b:a", "192k"]
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", *vargs, *aargs,
         "-movflags", "+faststart", str(dst)],
        check=True,
    )
    return dst


@app.post("/api/download", dependencies=[Depends(require_passphrase)])
async def download(req: DownloadRequest) -> FileResponse:
    url = check_url(req.url)
    workdir = Path(tempfile.mkdtemp(prefix="clipkit-"))

    res = f"res:{req.height}" if req.height else "res"
    opts = {
        **base_opts(),
        "outtmpl": str(workdir / "src.%(ext)s"),
        "format": "bv*+ba/b",
        # 指定画質以下で最大のものを選び、同じ画質なら H.264 / AAC / mp4 を優先する
        "format_sort": [res, "vcodec:h264", "acodec:aac", "ext:mp4:m4a"],
        "merge_output_format": "mp4",
    }
    if req.index is not None:
        opts["playlist_items"] = str(req.index + 1)
        opts["noplaylist"] = False

    def run() -> tuple[Path, str]:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        if info.get("_type") == "playlist":
            info = next((e for e in (info.get("entries") or []) if e), {})
        src = next((p for p in workdir.iterdir() if p.name.startswith("src.")), None)
        if src is None:
            raise yt_dlp.utils.DownloadError("no media downloaded")
        out = to_iphone_mp4(src, workdir / "out.mp4")
        src.unlink(missing_ok=True)
        return out, info.get("title") or info.get("id") or "video"

    try:
        path, title = await run_in_threadpool(run)
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise friendly_error(e) from e
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise

    name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", title).strip()[:80] or "video"
    return FileResponse(
        path,
        media_type="video/mp4",
        headers={"Content-Disposition": f"attachment; filename=\"video.mp4\"; filename*=UTF-8''{quote(name)}.mp4"},
        background=BackgroundTask(shutil.rmtree, workdir, ignore_errors=True),
    )
