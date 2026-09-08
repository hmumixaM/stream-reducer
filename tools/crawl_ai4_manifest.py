"""Refresh an AI4 collection manifest from an authenticated Chrome session."""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path
from typing import Any

from websockets.sync.client import connect

CDP_URL = "http://127.0.0.1:9223"
CAROUSEL_EXPRESSION = r"""
JSON.stringify(
  [...document.querySelectorAll(".ea-card")].map((card) => ({
    title: card.querySelector("h3.ea-header")?.innerText.trim() ?? "",
    items: [...card.querySelectorAll('a[href*="youtube.com/"]')].map((anchor) => {
      const url = new URL(anchor.href);
      return {
        youtube_id:
          url.searchParams.get("v") ??
          url.pathname.split("/").filter(Boolean).at(-1),
        title:
          anchor.dataset.title?.trim() ??
          anchor.dataset.caption?.trim() ??
          anchor.getAttribute("title")?.trim() ??
          "",
      };
    }),
  }))
)
"""


class CdpSession:
    def __init__(self, websocket_url: str) -> None:
        self.websocket = connect(websocket_url)
        self.next_id = 1

    def close(self) -> None:
        self.websocket.close()

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        request_id = self.next_id
        self.next_id += 1
        self.websocket.send(
            json.dumps({"id": request_id, "method": method, "params": params or {}})
        )
        while True:
            response = json.loads(self.websocket.recv())
            if response.get("id") == request_id:
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response["result"]

    def evaluate(self, expression: str) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            },
        )
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"])
        return result["result"].get("value")

    def navigate(self, url: str) -> None:
        marker = f"before-navigation-{time.monotonic_ns()}"
        self.evaluate(f"window.__ai4CrawlerMarker = {json.dumps(marker)}")
        self.call("Page.navigate", {"url": url})
        deadline = time.monotonic() + 45
        expected_url = json.dumps(url)
        while time.monotonic() < deadline:
            ready = self.evaluate(
                f"window.__ai4CrawlerMarker !== {json.dumps(marker)} && "
                f"location.href === {expected_url} && "
                "document.readyState === 'complete' && "
                "document.querySelectorAll('.ea-card').length > 0 && "
                "document.querySelectorAll('.ea-card a[href*=\"youtube.com/\"]')"
                ".length > 0"
            )
            if ready:
                time.sleep(1)
                return
            time.sleep(0.5)
        raise TimeoutError(f"AI4 page did not finish loading: {url}")


def chrome_page_websocket() -> str:
    with urllib.request.urlopen(f"{CDP_URL}/json/list") as response:
        targets = json.load(response)
    pages = [
        target
        for target in targets
        if target["type"] == "page" and "videos.ai4.io/" in target["url"]
    ]
    if not pages:
        raise RuntimeError("open an authenticated videos.ai4.io page in Chrome")
    return pages[0]["webSocketDebuggerUrl"]


def unique_items(items: list[dict[str, str]]) -> list[dict[str, str]]:
    unique: dict[str, dict[str, str]] = {}
    for item in items:
        youtube_id = item["youtube_id"]
        title = item["title"]
        if youtube_id and title:
            unique.setdefault(youtube_id, item)
    return list(unique.values())


def refresh_manifest(path: Path, write: bool, refresh_all: bool) -> None:
    manifest = json.loads(path.read_text())
    session = CdpSession(chrome_page_websocket())
    try:
        sections = (
            manifest["sections"]
            if refresh_all
            else [
                section
                for section in manifest["sections"]
                if any(not track["items"] for track in section["tracks"])
            ]
        )
        for section in sections:
            session.navigate(section["source_url"])
            cards = json.loads(session.evaluate(CAROUSEL_EXPRESSION))
            tracks = [
                {"title": card["title"], "items": unique_items(card["items"])}
                for card in cards
                if card["title"]
            ]
            titles = [track["title"] for track in tracks]
            if len(titles) != len(set(titles)):
                raise RuntimeError(f"{section['slug']} contains duplicate track titles")
            section["tracks"] = tracks
            for track in tracks:
                print(f"{section['slug']}: {track['title']}: {len(track['items'])}")
    finally:
        session.close()

    empty = [
        f"{section['slug']}: {track['title']}"
        for section in manifest["sections"]
        for track in section["tracks"]
        if not track["items"]
    ]
    if empty:
        raise RuntimeError(f"empty AI4 tracks remain: {empty}")
    if write:
        path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    refresh_manifest(args.manifest, args.write, args.all)


if __name__ == "__main__":
    main()
