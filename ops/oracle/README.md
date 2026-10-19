# Oracle host hardening

These files complement the separate application/relay/Tunnel isolation in
`xgoose-litellm/oracle/`. They contain no runtime secrets.

- Install `90-host-hardening.conf` under `/etc/sysctl.d/` and apply with
  `sysctl -p`. Keep Docker forwarding enabled; do not blindly disable network
  namespaces or forwarding needed by the deployed services.
- Install `90-no-core.conf` under `/etc/security/limits.d/` and
  `90-coredump.conf` under `/etc/systemd/coredump.conf.d/`. Disable core files
  in Compose as well, since existing processes do not inherit new PAM limits.
- Install `90-host-audit.rules` under `/etc/audit/rules.d/` with mode 0600,
  omitting watches whose paths do not exist. Load with `augenrules --load`.
  Credential reads are audited without logging file contents. Avoid global
  execve auditing: command arguments can include secrets.

Before SSH/firewall changes, keep an authenticated session open, back up the
configuration privately, validate with `sshd -t`, reload, and verify a fresh
key-authenticated connection. Keep the private Docker ingress guard and the
Cloudflare Access service policy intact. Disable headless desktop services
only after confirming no application depends on them.

Use vendor repositories with signature verification for host updates. Review
third-party repository errors separately; do not bypass GPG checks. Installing
packages does not replace the running kernel or every daemon's loaded library.
Review reboot requirements and coordinate interruption of audio/model work.
