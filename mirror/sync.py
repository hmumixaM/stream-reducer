"""Build, export, and deploy the static public mirror to Cloudflare Pages.

Pipeline (all from the dev machine, using local `CLOUDFLARE_*` env vars):

  1. pick a content source: the NAS API reached by running `curl` over SSH
     (default; the NAS disallows SSH port-forwarding), or a reachable
     ``--base-url`` over plain HTTP;
  2. build the SPA in mirror mode (``VITE_MIRROR=1``) into ``mirror/dist``;
  3. export the static JSON bundle into ``mirror/dist/data`` (see ``export.py``);
  4. write the SPA-fallback ``_redirects``;
  5. ``wrangler pages deploy`` to the ``stream-reduce-mirror`` project.

Run: ``uv run python -m mirror.sync`` (add ``--no-deploy`` for a dry run).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from mirror.export import FetchBytes, FetchJson, export, http_fetchers

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = REPO_ROOT / "frontend"
DIST_DIR = REPO_ROOT / "mirror" / "dist"
DEFAULT_NAS_HOST = "maximumh@nas"
DEFAULT_PROJECT = "stream-reduce-mirror"
NAS_API = "http://localhost:8010"
SPA_REDIRECT = "/*    /index.html    200\n"


def ssh_fetchers(host: str) -> tuple[FetchJson, FetchBytes]:
    """JSON + bytes fetchers that run ``curl`` against the NAS API over SSH.

    The NAS sshd has TCP forwarding disabled, so a tunnel is not an option; we
    instead execute curl remotely and read its stdout. Auth uses ``NAS_PASSWORD``
    (see ``.cursor/rules/nas-deploy.mdc``).
    """
    password = os.environ.get("NAS_PASSWORD")
    if not password:
        raise SystemExit(
            "NAS_PASSWORD is not set. Load it from your shell "
            "(e.g. `eval \"$(rg '^export NAS_PASSWORD=' ~/.zshrc)\"`), "
            "or pass --base-url for a reachable API."
        )

    # Reuse a single SSH connection for every curl (the export makes hundreds of
    # calls — one per item detail / related / thumbnail). Without multiplexing the
    # NAS sshd throttles the connection storm and starts denying auth. The master
    # is opened on the first call and persists briefly between calls.
    control_path = f"/tmp/sr-mirror-{os.getpid()}-%h.sock"
    mux = [
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={control_path}",
        "-o", "ControlPersist=120s",
        "-o", "StrictHostKeyChecking=accept-new",
    ]

    def run(url: str, *, text: bool) -> subprocess.CompletedProcess:
        remote = f"curl -s --fail {shlex.quote(url)}"
        return subprocess.run(
            ["sshpass", "-p", password, "ssh", *mux, host, remote],
            capture_output=True,
            text=text,
        )

    def fetch(path: str, params: dict[str, Any] | None = None) -> Any:
        url = NAS_API + path
        if params:
            url += "?" + urlencode(params)
        proc = run(url, text=True)
        if proc.returncode != 0:
            detail = proc.stderr.strip() or proc.stdout.strip()
            raise SystemExit(f"SSH curl failed for {path}: {detail}")
        return json.loads(proc.stdout)

    def fetch_bytes(path: str) -> bytes | None:
        proc = run(NAS_API + path, text=False)
        return proc.stdout if proc.returncode == 0 else None

    return fetch, fetch_bytes


def build_spa() -> None:
    env = {**os.environ, "VITE_MIRROR": "1"}
    print("Building SPA (mirror mode)...")
    subprocess.run(["npx", "tsc", "-b"], cwd=FRONTEND_DIR, env=env, check=True)
    subprocess.run(
        ["npx", "vite", "build", "--outDir", str(DIST_DIR), "--emptyOutDir"],
        cwd=FRONTEND_DIR,
        env=env,
        check=True,
    )


def write_redirects() -> None:
    (DIST_DIR / "_redirects").write_text(SPA_REDIRECT)


def ensure_project(project: str) -> None:
    listing = subprocess.run(
        ["npx", "wrangler", "pages", "project", "list"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if project in listing.stdout:
        return
    print(f"Creating Cloudflare Pages project '{project}'...")
    subprocess.run(
        ["npx", "wrangler", "pages", "project", "create", project, "--production-branch", "main"],
        cwd=REPO_ROOT,
        check=True,
    )


def deploy(project: str) -> None:
    ensure_project(project)
    print(f"Deploying to Cloudflare Pages project '{project}'...")
    subprocess.run(
        [
            "npx",
            "wrangler",
            "pages",
            "deploy",
            str(DIST_DIR),
            "--project-name",
            project,
            "--branch",
            "main",
            "--commit-dirty=true",
        ],
        cwd=REPO_ROOT,
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default=None,
        help="API base URL over HTTP. If set, SSH is skipped and this URL is used.",
    )
    parser.add_argument("--nas-host", default=DEFAULT_NAS_HOST, help="SSH host for the NAS API")
    parser.add_argument(
        "--project-name", default=DEFAULT_PROJECT, help="Cloudflare Pages project"
    )
    parser.add_argument(
        "--no-build", action="store_true", help="Skip the SPA build (reuse mirror/dist)"
    )
    parser.add_argument(
        "--no-deploy", action="store_true", help="Build + export only; skip wrangler deploy"
    )
    args = parser.parse_args()

    if args.base_url:
        print(f"Using API at {args.base_url} (HTTP)...")
        fetch, fetch_bytes = http_fetchers(args.base_url)
    else:
        print(f"Using NAS API via SSH curl on {args.nas_host}...")
        fetch, fetch_bytes = ssh_fetchers(args.nas_host)
    fetch("/api/health", None)  # fail fast if the source API is unreachable

    if not args.no_build:
        build_spa()
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    meta = export(fetch, fetch_bytes, DIST_DIR)
    print(
        f"Exported {meta['item_count']} items, {meta['search_docs']} search docs, "
        f"{meta['thumbnails']} thumbnails."
    )
    write_redirects()

    if args.no_deploy:
        print(f"Dry run complete. Bundle ready at {DIST_DIR} (skipped deploy).")
        return
    deploy(args.project_name)
    print(f"Deployed. Live at https://{args.project_name}.pages.dev")


if __name__ == "__main__":
    main()
