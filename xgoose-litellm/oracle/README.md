# Oracle LiteLLM

Stream Reducer uses `https://litellm-origin.xgoose.org/v1`, independently of
the on-demand Cloudflare LiteLLM gateway. The two Vertex aliases in that older
gateway also delegate to Oracle so its LiteLLM process no longer receives ADC.
Other legacy models and the disabled-user check remain in the older gateway.

## Security boundaries

```text
Worker / media container / legacy gateway
  -> Cloudflare Access (dedicated service identity)
  -> outbound-only Cloudflare Tunnel (only /v1/models and /v1/chat/completions)
  -> LiteLLM (separate bearer, no Internet route, no provider credentials)
  -> private fixed-destination relay
  -> Google Vertex or RightCode
```

Only `vertex-relay` mounts the Google ADC. Its distinct UID is 65531; LiteLLM
runs as UID 65532 and has no mount of the file, its parent directory, a host
filesystem, or the Docker socket. A LiteLLM authentication bypass or a process
compromise therefore does not directly expose the ADC file. LiteLLM's only
networks are Docker internal networks; a compromised process can still invoke
the explicitly permitted model operations through the relay. It cannot select
another destination/project/model, fetch URLs/files through this relay, or
request a Google access/refresh token. Provider errors and exception details
are not returned by the relay. Redirects and environment HTTP proxies are
disabled for provider calls; HTTPS certificate verification remains enabled.

The relay is a separate trusted process: a relay compromise, a container
escape, or host root compromise remains a credential risk. This is isolation,
not a claim that arbitrary future vulnerabilities are harmless. The current
ADC is an authorized-user refresh credential copied from the NAS. A dedicated
Google service account with the minimum project permissions would further
reduce its authority; do not assume the user's existing ADC is project-scoped.

All services run without capabilities, with no-new-privileges, read-only root
filesystems, disabled core dumps, bounded memory/PIDs/CPU and rotating logs.
Images use immutable digests. No service publishes a host port, including
loopback. Diagnostics run inside the private Docker networks. Oracle inbound
port 4000 is not opened. The relay and connector publish no ports. `/ui`, configuration, filesystem paths and other
management endpoints are not routed through the tunnel.

## Installation and secret storage

The deployment lives at `/var/oled/litellm` on the selected Oracle host. That
directory is root-owned mode 0700. Copy only the versioned source/config files
there. Create these files privately, never through terminal arguments or Git:

| File | Contents | Ownership / mode |
| --- | --- | --- |
| `.env` | `LITELLM_MASTER_KEY`, `VERTEX_RELAY_KEY` | root / 0600 |
| `relay.env` | `VERTEX_RELAY_KEY`, `RIGHTCODE_API_KEY` | root / 0600 |
| `secrets/vertex-adc.json` | Google ADC | 65531:65531 / 0400 |
| `secrets/tunnel-token` | Tunnel connector token | 65532:65532 / 0400 |

`VERTEX_RELAY_KEY` must match between the two env files. Both are protected by
the root-only parent directory. ADC is mounted read-only into the relay only;
the connector token is mounted into cloudflared only. No Google credentials
belong in a container environment, image, workflow secret, or Worker secret.

Cloudflare Access application: `Stream Reducer Oracle LiteLLM` on the entire
origin hostname, Service Auth policy, explicitly including only the Stream
Reducer and legacy-gateway service tokens. There are no public/bypass policies.
Tunnel ID: `28a90436-e1c7-4b86-94e4-7b2ae859db4a`; ingress:

```yaml
ingress:
  - hostname: litellm-origin.xgoose.org
    path: ^/v1/(chat/completions|models)/?$
    service: http://litellm:4000
  - service: http_status:404
```

Do not route the relay directly. Establish Access protection before enabling
the tunnel/DNS. Keep the existing Oracle host services and firewall unchanged.

## Application release

The main workflow takes `ORACLE_LITELLM_API_KEY`, `LLM_ACCESS_CLIENT_ID`, and
`LLM_ACCESS_CLIENT_SECRET` from repository secrets. It uploads them together
with the version using `wrangler deploy --secrets-file`, avoiding a period
where an old endpoint uses a new bearer. Worker callers and media containers
send both Access headers. Bump `CONTAINER_GEN` when rebuilding the media image.
The old `GEMINI_API_KEY` repository secret is preserved for controlled rollback.

The legacy gateway takes the Oracle bearer and its separate Access identity
from `LEGACY_LLM_ACCESS_CLIENT_ID` / `LEGACY_LLM_ACCESS_CLIENT_SECRET`. It no
longer injects `VERTEX_CREDENTIALS`. A fresh container instance key prevents
new traffic from reusing the old process containing the ADC environment.
Remove the obsolete Cloudflare Worker secret after verifying the new routes;
old in-flight containers/Worker versions must be accounted for separately.
Legacy gateway idle sleep is five minutes; requests wake it on demand.

The short-lived management API token is local only, in the protected file
`~/.config/stream-reducer/cloudflare-oracle.env`, loaded by `~/.zshrc` as
`CLOUDFLARE_ORACLE_API_TOKEN`. It expires November 18, 2026. Its expiration does
not stop the separate runtime Tunnel/Access tokens. Do not copy this management
token to Oracle or into GitHub runtime secrets. Runtime Access service tokens
were created for one year; renew them before expiration.

## Verification and operations

Run `test_vertex_broker.py` in an environment containing google-auth and
requests (the pinned image has both). Tests use dummy credentials and mocked
provider HTTP responses. Verify the deployed boundary as well:

| Request | Required result |
| --- | --- |
| No credentials, `/v1/models` | Access 403 |
| LiteLLM bearer only | Access 403 |
| Access credentials only | LiteLLM 401 |
| Both credentials | 200 model list |
| Both credentials, `/ui` or a credential/config path | 404 |
| Vertex and RightCode text completions | Nonempty successful answer |
| Streaming completion | Content events and `[DONE]` |
| LiteLLM checks `/run/secrets/vertex-adc.json` | File absent |
| LiteLLM TCP to a public IP | Network unreachable |

Inspect `docker compose ps` and bounded health/status output. Avoid dumping
full container environments, rendered Compose configuration, ADC contents,
request headers, or upstream exception bodies into logs/chats. Check actual
ADC refresh-token/client-secret values against env/log/config output using a
script that prints only boolean findings, never the values.

Before a rollback, preserve the new authentication boundary. Do not restore
ADC access to LiteLLM just to restore a route; repair or roll back the relay
separately. Restore the prior Worker version together with its matching
endpoint and bearer if necessary. Keep NAS's original deployment unchanged.
