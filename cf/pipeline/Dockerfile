# Pipeline container for Cloudflare Containers: runs yt-dlp + ffmpeg + the
# stateless ingest/transcribe/summarize service. Built from the repo ROOT
# (see wrangler.jsonc image_build_context) so it can vendor the shared `app/`
# adapters package.
FROM python:3.12-slim

# Static ffmpeg/ffprobe for audio decoding + chunking; curl to fetch the WARP
# tooling below (and for the proxy-check diagnostic).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# WARP egress: `wgcf` registers a free Cloudflare WARP (WireGuard) identity and
# `wireproxy` exposes it as a userspace SOCKS5 proxy — no TUN device / NET_ADMIN
# capability required, which serverless containers don't grant. This lets
# yt-dlp route Bilibili downloads through WARP exit IPs instead of the
# container's risk-controlled datacenter IP. Orchestrated by entrypoint.sh.
ARG WGCF_VERSION=2.2.31
ARG WIREPROXY_VERSION=1.0.9
RUN curl -fsSL -o /usr/local/bin/wgcf \
      "https://github.com/ViRb3/wgcf/releases/download/v${WGCF_VERSION}/wgcf_${WGCF_VERSION}_linux_amd64" \
    && chmod +x /usr/local/bin/wgcf \
    && curl -fsSL -o /tmp/wireproxy.tar.gz \
      "https://github.com/pufferffish/wireproxy/releases/download/v${WIREPROXY_VERSION}/wireproxy_linux_amd64.tar.gz" \
    && tar -xzf /tmp/wireproxy.tar.gz -C /usr/local/bin wireproxy \
    && chmod +x /usr/local/bin/wireproxy \
    && rm -f /tmp/wireproxy.tar.gz

WORKDIR /srv

# Rotate worker to get new IP / latest yt-dlp
ENV ROTATE_WORKER=1

COPY cf/pipeline/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Shared adapter code (reused as-is) + the stateless server.
COPY app ./app
COPY cf/pipeline/server.py cf/pipeline/pipeline.py cf/pipeline/llm.py ./
COPY cf/pipeline/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV DATA_DIR=/tmp/data \
    PYTHONUNBUFFERED=1 \
    WARP_INSTANCES=2
EXPOSE 8080

# entrypoint.sh brings up WARP proxies, exports PROXY_URLS, then execs uvicorn.
CMD ["./entrypoint.sh"]
