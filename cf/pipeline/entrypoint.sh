#!/usr/bin/env bash
# Container entrypoint: bring up N Cloudflare WARP SOCKS5 proxies (userspace
# WireGuard via wgcf + wireproxy, so no TUN device / NET_ADMIN is required) and
# hand off to the FastAPI pipeline server.
#
# IMPORTANT: WARP setup (wgcf register + WireGuard handshake) is done in the
# BACKGROUND and uvicorn is exec'd immediately, so the container binds :8080
# right away. Blocking on WARP readiness here previously delayed the bind past
# Cloudflare's container-start window, causing "container is not listening" /
# blockConcurrencyWhile timeouts under load. PROXY_URLS is published up front
# (the ports are known); the yt-dlp adapter rotates WARP -> direct if a proxy
# isn't healthy yet, and pipeline.run waits briefly for WARP before egress.
set -u

WARP_INSTANCES="${WARP_INSTANCES:-2}"
BASE_PORT="${WARP_BASE_PORT:-40000}"

# Publish PROXY_URLS immediately (optimistic): socks5 ports we're about to bring
# up, then `direct` as the final fallback.
proxies=()
for i in $(seq 1 "$WARP_INSTANCES"); do
  proxies+=("socks5://127.0.0.1:$((BASE_PORT + i - 1))")
done
proxies+=("direct")
PROXY_URLS="$(IFS=,; echo "${proxies[*]}")"
export PROXY_URLS
echo "[warp] PROXY_URLS=${PROXY_URLS}"

setup_warp() {
  local idx="$1" port="$2"
  local toml="/tmp/wgcf-${idx}.toml"
  local wg="/tmp/wgcf-${idx}.conf"
  local wp="/tmp/wireproxy-${idx}.conf"
  local log="/tmp/warp-${idx}.log"

  if ! wgcf register --accept-tos --config "$toml" >"$log" 2>&1; then
    echo "[warp] register #${idx} failed:"; sed 's/^/[warp]   /' "$log"; return 1
  fi
  if ! wgcf generate --config "$toml" --profile "$wg" >>"$log" 2>&1; then
    echo "[warp] generate #${idx} failed:"; sed 's/^/[warp]   /' "$log"; return 1
  fi
  cat > "$wp" <<EOF
WGConfig = ${wg}

[Socks5]
BindAddress = 127.0.0.1:${port}
EOF
  wireproxy -c "$wp" >>"$log" 2>&1 &
  echo "[warp] wireproxy #${idx} -> socks5://127.0.0.1:${port} (pid $!)"
}

# Bring up all WARP instances in the background — never blocks the uvicorn bind.
{
  for i in $(seq 1 "$WARP_INSTANCES"); do
    setup_warp "$i" "$((BASE_PORT + i - 1))" || true
  done
} &

exec uvicorn server:app --host 0.0.0.0 --port 8080
