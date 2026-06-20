#!/usr/bin/env bash
# Container entrypoint: bring up N Cloudflare WARP SOCKS5 proxies (userspace
# WireGuard via wgcf + wireproxy, so no TUN device / NET_ADMIN is required),
# export their addresses as PROXY_URLS for the yt-dlp adapter to rotate through,
# then hand off to the FastAPI pipeline server.
#
# Each proxy is a fresh WARP identity registered at startup, so concurrent
# container instances don't share one WireGuard key and rotation lands on a
# different exit IP. `direct` is always appended as the final fallback so a
# WARP/UDP failure degrades to the previous (datacenter-IP) behaviour instead
# of breaking the pipeline.
set -u

WARP_INSTANCES="${WARP_INSTANCES:-2}"
BASE_PORT="${WARP_BASE_PORT:-40000}"
# Max seconds to wait for the first WARP proxy's WireGuard handshake to pass
# traffic before starting the server anyway (rotation + `direct` cover misses).
WARP_READY_TIMEOUT="${WARP_READY_TIMEOUT:-45}"

proxies=()

# True once the SOCKS proxy can actually fetch through the WARP tunnel.
proxy_ready() {
  local hostport="${1#*://}"
  curl -fsS --max-time 8 --socks5-hostname "$hostport" \
    https://www.cloudflare.com/cdn-cgi/trace >/dev/null 2>&1
}

wait_ready() {
  local url="$1" deadline=$(( $(date +%s) + WARP_READY_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if proxy_ready "$url"; then return 0; fi
    sleep 2
  done
  return 1
}

start_warp() {
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
  return 0
}

for i in $(seq 1 "$WARP_INSTANCES"); do
  port=$((BASE_PORT + i - 1))
  if start_warp "$i" "$port"; then
    proxies+=("socks5://127.0.0.1:${port}")
  fi
done

# Always keep a direct egress as the last resort.
proxies+=("direct")

# Join with commas without spawning a subshell that loses the array.
PROXY_URLS="$(IFS=,; echo "${proxies[*]}")"
export PROXY_URLS
echo "[warp] PROXY_URLS=${PROXY_URLS}"

# Block (bounded) until the first WARP proxy can pass traffic, so the first job
# doesn't race the WireGuard handshake. Falls through to `direct` on timeout.
if [ "${proxies[0]}" != "direct" ]; then
  if wait_ready "${proxies[0]}"; then
    echo "[warp] ${proxies[0]} ready"
  else
    echo "[warp] WARNING: ${proxies[0]} not ready after ${WARP_READY_TIMEOUT}s; relying on rotation/direct"
  fi
fi

exec uvicorn server:app --host 0.0.0.0 --port 8080
