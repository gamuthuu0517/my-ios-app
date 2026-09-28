"""サーバー側での GIF 変換（ffmpeg）。範囲・切り抜き・解像度・fps・ディザリングはアプリで決めた値をそのまま使う。

- パレットは2段階（先に全体の色を調べてから変換）で作り、メモリを使いすぎないようにする
- 表示間隔は ffmpeg が 1/100 秒の端数を繰り越して配分する（30fps → 3,4,3…）ので再生速度は元動画と一致する
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from pydantic import BaseModel


class Crop(BaseModel):
    x: int
    y: int
    w: int
    h: int


class GifParams(BaseModel):
    start: float
    end: float
    fps: float
    width: int
    height: int
    dither: bool = True
    crop: Crop | None = None


def _filters(p: GifParams) -> str:
    parts = []
    if p.crop:
        c = p.crop
        parts.append(f"crop={c.w}:{c.h}:{c.x}:{c.y}")
    parts.append(f"fps={p.fps:.6f}")
    parts.append(f"scale={p.width}:{p.height}:flags=lanczos")
    return ",".join(parts)


def make_gif(src: Path, p: GifParams, workdir: Path, emit) -> Path:
    dur = max(0.01, p.end - p.start)
    base = ["ffmpeg", "-y", "-v", "error", "-nostats", "-ss", f"{p.start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    palette = workdir / "palette.png"
    out = workdir / "out.gif"

    emit({"type": "progress", "stage": "palette", "pct": None})
    subprocess.run(
        [*base, "-vf", f"{_filters(p)},palettegen=max_colors=256:stats_mode=diff", str(palette)],
        check=True, capture_output=True,
    )

    dither = "floyd_steinberg" if p.dither else "none"
    proc = subprocess.Popen(
        [*base, "-i", str(palette), "-progress", "pipe:1",
         "-lavfi", f"{_filters(p)}[v];[v][1:v]paletteuse=dither={dither}:diff_mode=rectangle",
         "-loop", "0", str(out)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_us="):
            try:
                sec = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            emit({"type": "progress", "stage": "gif", "pct": min(99, round(sec / dur * 100))})
    if proc.wait() != 0:
        raise RuntimeError(f"GIF の作成に失敗しました：{proc.stderr.read()[-200:] if proc.stderr else ''}")
    return out
