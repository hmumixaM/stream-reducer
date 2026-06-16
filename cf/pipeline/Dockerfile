# Pipeline container for Cloudflare Containers: runs yt-dlp + ffmpeg + the
# stateless ingest/transcribe/summarize service. Built from the repo ROOT
# (see wrangler.jsonc image_build_context) so it can vendor the shared `app/`
# adapters package.
FROM python:3.12-slim

# Static ffmpeg/ffprobe for audio decoding + chunking.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Rotate worker to get new IP / latest yt-dlp
ENV ROTATE_WORKER=1

COPY cf/pipeline/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Shared adapter code (reused as-is) + the stateless server.
COPY app ./app
COPY cf/pipeline/server.py cf/pipeline/pipeline.py cf/pipeline/llm.py ./

ENV DATA_DIR=/tmp/data \
    PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
