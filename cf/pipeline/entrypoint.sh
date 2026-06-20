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
WARP_WARMUP_SECONDS="${WARP_WARMUP_SECONDS:-3}"

proxies=()

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

# Let the WireGuard handshakes settle before the first download attempt.
if [ "${#proxies[@]}" -gt 1 ]; then
  sleep "$WARP_WARMUP_SECONDS"
fi

exec uvicorn server:app --host 0.0.0.0 --port 8080
