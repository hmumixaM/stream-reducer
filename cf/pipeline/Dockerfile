# Pipeline container for Cloudflare Containers: runs yt-dlp + ffmpeg + the
# stateless ingest/transcribe/summarize service. Built from the repo ROOT
# (see wrangler.jsonc image_build_context) so it can vendor the shared `app/`
# adapters package.
FROM python:3.14-slim

# Userspace Tailscale provides an authenticated residential fallback through
# the user's NAS exit node. It needs no TUN device or NET_ADMIN capability:
# tailscaled exposes a local SOCKS5 listener used only after direct egress fails.
COPY --from=tailscale/tailscale:v1.102.3 /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale/tailscale:v1.102.3 /usr/local/bin/tailscaled /usr/local/bin/tailscaled

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

# YouTube downloads need a JS runtime for signature challenges and a current
# proof-of-origin provider for clients that require WebPO tokens. Version 1.3.2
# fixes token minting under YouTube's latest A/B tests; keeping the server image
# and Python plugin on the same pinned release avoids protocol skew.
COPY --from=brainicism/bgutil-ytdlp-pot-provider:1.3.2-deno /usr/bin/deno /usr/local/bin/deno
COPY --from=brainicism/bgutil-ytdlp-pot-provider:1.3.2-deno /app /opt/bgutil
RUN deno --version

WORKDIR /srv

# Rotate worker to get new IP / latest yt-dlp (bump to force a clean rebuild)
ENV ROTATE_WORKER=bld-v11

COPY cf/pipeline/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Shared adapter code (reused as-is) + the stateless server.
COPY app ./app
COPY cf/pipeline/server.py cf/pipeline/pipeline.py cf/pipeline/llm.py cf/pipeline/bili_refresh.py ./
COPY cf/pipeline/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV DATA_DIR=/tmp/data \
    PYTHONUNBUFFERED=1 \
    DENO_DIR=/tmp/deno \
    WARP_INSTANCES=2 \
    TAILSCALE_SOCKS_PORT=42000
EXPOSE 8080

# entrypoint.sh brings up WARP proxies, exports PROXY_URLS, then execs uvicorn.
CMD ["./entrypoint.sh"]
