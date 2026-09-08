"""Generate the same Stream Reducer infographic prompt with RightCode models."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

from app.pipeline.prompts import (
    INFOGRAPHIC_SYSTEM,
    INFOGRAPHIC_TEMPLATE,
    language_directive,
)

MODEL_IMAGE_SIZES = {
    "gpt-image-2-vip": "4K",
    "gpt-image-2": "1K",
    "nano-banana": "1K",
    "nano-banana-2": "4K",
    "nano-banana-pro": "4K",
    "nano-banana-2-lite": "1K",
}
DRAW_URL = "https://www.rightapi.ai/draw/v1/images/generations"
TASK_URL = "https://www.rightapi.ai/v1/tasks/{task_id}"


def format_duration(seconds: int) -> str:
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def build_context(item: dict[str, Any]) -> str:
    lines = [
        f"- Title: {item.get('title') or '(unknown)'}",
        f"- Platform: {item.get('platform') or '(unknown)'}",
        f"- Channel / author: {item.get('author') or '(unknown)'}",
    ]
    if item.get("published_at"):
        lines.append(f"- Published: {item['published_at'][:10]}")
    if item.get("duration_s"):
        lines.append(f"- Duration: {format_duration(item['duration_s'])}")
    if item.get("view_count") is not None:
        lines.append(f"- View count: {item['view_count']:,}")
    if item.get("like_count") is not None:
        lines.append(f"- Like count: {item['like_count']:,}")
    lines.append(f"- Source URL: {item['source_url']}")
    description = (item.get("description") or "").strip()
    lines.append(
        f"- Show notes / description:\n{description[:4000]}"
        if description
        else "- Show notes / description: (none provided)"
    )
    return "\n".join(lines)


def build_prompt(item: dict[str, Any]) -> str:
    structured = item["summary"]["structured"]
    points = [
        f"- {(point.get('text') if isinstance(point, dict) else str(point)).strip()}"
        for point in (structured.get("key_points") or [])[:8]
        if (point.get("text") if isinstance(point, dict) else str(point)).strip()
    ]
    quotes = []
    for quote in (structured.get("quotes") or [])[:3]:
        text = (quote.get("text") if isinstance(quote, dict) else str(quote)).strip()
        speaker = quote.get("speaker") if isinstance(quote, dict) else None
        if text:
            quotes.append(f'- "{text}"' + (f" — {speaker}" if speaker else ""))
    sample = " ".join(
        str(structured.get(key) or "") for key in ("headline", "subhead", "tldr")
    )
    user_prompt = INFOGRAPHIC_TEMPLATE.format(
        context=build_context(item),
        headline=structured.get("headline") or item.get("title") or "(untitled)",
        subhead=structured.get("subhead") or "",
        tldr=structured.get("tldr") or "",
        key_points="\n".join(points) or "(none)",
        quotes="\n".join(quotes) or "(none)",
        entities=", ".join(str(value) for value in structured.get("entities") or [])
        or "(none)",
        language_instruction=language_directive(sample),
    )
    comparison_constraints = """

COMPARISON CONSTRAINTS:
- Do NOT include portraits, faces, people, avatars, or profile photographs.
- Use the space for information, not decoration.
- Maximize useful information density while keeping every label clearly legible.
- Include as many distinct, accurate facts from the supplied article as the layout permits.
"""
    return f"{INFOGRAPHIC_SYSTEM}\n\n{user_prompt}{comparison_constraints}"


def image_url(payload: dict[str, Any]) -> str | None:
    data = payload.get("data") or []
    if data and data[0].get("url"):
        return data[0]["url"]
    candidates = payload.get("candidates") or []
    if candidates:
        for part in candidates[0].get("content", {}).get("parts", []):
            text = part.get("text", "")
            if text.startswith("http"):
                return text
    return None


async def generate(
    client: httpx.AsyncClient,
    model: str,
    image_size: str,
    prompt: str,
    output_dir: Path,
) -> dict[str, Any]:
    started = time.monotonic()
    response = await client.post(
        DRAW_URL,
        json={
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": "16:9",
            "imageSize": image_size,
            "async": True,
        },
    )
    if response.is_error:
        return {
            "model": model,
            "status": "submit_error",
            "error": response.text[:500],
        }
    task_id = response.json()["task_id"]
    while time.monotonic() - started < 600:
        await asyncio.sleep(2)
        task = (await client.get(TASK_URL.format(task_id=task_id))).json()
        url = image_url(task)
        if url:
            image_response = await client.get(url)
            image_response.raise_for_status()
            content_type = image_response.headers.get("content-type", "image/png")
            extension = "jpg" if "jpeg" in content_type else "png"
            output_path = output_dir / f"{model}.{extension}"
            output_path.write_bytes(image_response.content)
            return {
                "model": model,
                "image_size": image_size,
                "status": "completed",
                "elapsed_s": round(time.monotonic() - started, 1),
                "content_type": content_type,
                "bytes": len(image_response.content),
                "path": str(output_path),
            }
        if task.get("status") == "failed":
            return {
                "model": model,
            "image_size": image_size,
                "status": "failed",
                "elapsed_s": round(time.monotonic() - started, 1),
                "error": task.get("error"),
            }
    return {
        "model": model,
        "image_size": image_size,
        "status": "timeout",
        "elapsed_s": 600,
    }


async def run(item_id: int, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    headers = {"Authorization": f"Bearer {os.environ['RIGHTCODE_API_KEY']}"}
    async with httpx.AsyncClient(headers=headers, timeout=120) as client:
        item = (
            await client.get(f"https://reducer.xgoose.org/api/items/{item_id}")
        ).raise_for_status().json()
        prompt = build_prompt(item)
        results = await asyncio.gather(
            *(
                generate(client, model, image_size, prompt, output_dir)
                for model, image_size in MODEL_IMAGE_SIZES.items()
            )
        )
    report = {
        "item_id": item_id,
        "title": item["title"],
        "prompt_characters": len(prompt),
        "models": results,
    }
    (output_dir / "report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--item-id", type=int, default=53)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.item_id, args.output_dir))


if __name__ == "__main__":
    main()
