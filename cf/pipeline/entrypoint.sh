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
TAILSCALE_SOCKS_PORT="${TAILSCALE_SOCKS_PORT:-42000}"
TAILSCALE_PROXY=""
if [[ -n "${TS_AUTHKEY:-}" && -n "${TS_EXIT_NODE:-}" ]]; then
  TAILSCALE_PROXY="socks5://127.0.0.1:${TAILSCALE_SOCKS_PORT}"
fi

# Publish PROXY_URLS immediately (optimistic): socks5 ports we're about to bring
# up, the residential Tailscale exit when configured, then direct. The YouTube
# adapter reorders these to direct -> residential -> WARP; Bilibili stays
# WARP-first because its datacenter-IP risk control has the opposite behavior.
proxies=()
for i in $(seq 1 "$WARP_INSTANCES"); do
  proxies+=("socks5://127.0.0.1:$((BASE_PORT + i - 1))")
done
if [[ -n "$TAILSCALE_PROXY" ]]; then
  proxies+=("$TAILSCALE_PROXY")
  export RESIDENTIAL_PROXY_URL="$TAILSCALE_PROXY"
fi
proxies+=("direct")
PROXY_URLS="$(IFS=,; echo "${proxies[*]}")"
export PROXY_URLS
echo "[warp] PROXY_URLS=${PROXY_URLS}"

setup_tailscale() {
  local socket="/tmp/tailscaled.sock"
  local state="mem:"
  local log="/tmp/tailscale.log"
  local hostname="stream-reduce-${HOSTNAME:-container}"
  local auth_key="$TS_AUTHKEY"
  local auth_args=()
  hostname="${hostname:0:63}"
  if [[ "$auth_key" == tskey-client-* ]]; then
    auth_key="${auth_key}?ephemeral=true&preauthorized=true"
    auth_args+=("--advertise-tags=${TS_ADVERTISE_TAGS:-tag:stream-reduce}")
  fi

  tailscaled \
    --tun=userspace-networking \
    --socks5-server="127.0.0.1:${TAILSCALE_SOCKS_PORT}" \
    --state="$state" \
    --socket="$socket" \
    >"$log" 2>&1 &

  for _ in $(seq 1 30); do
    if tailscale --socket="$socket" status >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  if ! tailscale --socket="$socket" up \
    --auth-key="$auth_key" \
    "${auth_args[@]}" \
    --hostname="$hostname" \
    --exit-node="$TS_EXIT_NODE" \
    --exit-node-allow-lan-access=false \
    --accept-dns=false \
    --accept-routes=false \
    >>"$log" 2>&1; then
    echo "[tailscale] failed to join tailnet; residential fallback unavailable"
    return 1
  fi

  local exit_ip
  exit_ip="$(curl -fsS --proxy "$TAILSCALE_PROXY" \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null \
    | awk -F= '$1 == "ip" { print $2; exit }')"
  echo "[tailscale] residential fallback ready via ${TS_EXIT_NODE} (exit ${exit_ip:-unknown})"
}

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
  # YouTube rejects IPv6 VPN/WARP media requests much more aggressively. Keep
  # the whole extraction/token/download flow on one stable IPv4 exit.
  python -c "from app.adapters.warp import force_ipv4_profile; force_ipv4_profile('$wg')"
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

# Join the tailnet in userspace mode. This is intentionally backgrounded so a
# Tailscale control-plane delay can never stop the container from binding 8080;
# direct egress is attempted first while this residential fallback warms up.
if [[ -n "$TAILSCALE_PROXY" ]]; then
  setup_tailscale &
fi

# Proof-of-origin token server for yt-dlp's YouTube extractor. The
# bgutil-ytdlp-pot-provider plugin looks for it on 127.0.0.1:4416 by default;
# the extractor degrades to token-free clients if it isn't up yet, so this too
# starts in the background rather than delaying the port bind.
(
  cd /opt/bgutil || exit 0
  DENO_DIR=/opt/bgutil/.cache/deno DENO_NO_PROMPT=1 \
    deno run --allow-env --allow-net --allow-ffi=/opt/bgutil/node_modules \
      --allow-read=/opt/bgutil/node_modules /opt/bgutil/src/main.ts \
      >/tmp/bgutil.log 2>&1
) &
echo "[pot] bgutil POT server starting on 127.0.0.1:4416 (pid $!)"

exec uvicorn server:app --host 0.0.0.0 --port 8080
