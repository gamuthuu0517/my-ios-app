FROM python:3.12-slim

# ffmpeg: 映像と音声の結合・H.264 への変換 / deno: yt-dlp が YouTube の解析に使う JS 実行環境
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app

ENV PYTHONUNBUFFERED=1
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
