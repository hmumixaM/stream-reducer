"""LLM + STT clients for the pipeline container.

Summary: the provided Gemini proxy (OpenAI-compatible /v1/chat/completions).
STT: OpenRouter /audio/transcriptions. Both read config from env vars injected
by the Worker (see cf/worker/src/pipeline/container.ts).
"""

from __future__ import annotations

import base64
import os
import random
import time
from dataclasses import dataclass, field

import httpx


@dataclass
class LlmResult:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    latency_ms: int = 0


def _gemini_base() -> str:
    return os.environ.get("GEMINI_BASE_URL", "").rstrip("/")


def _gemini_model() -> str:
    return os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")


def generate_text(
    prompt: str,
    *,
    system: str | None = None,
    model: str | None = None,
    max_tokens: int | None = None,
    temperature: float = 0.2,
) -> LlmResult:
    key = os.environ["GEMINI_API_KEY"]
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload: dict = {
        "model": model or _gemini_model(),
        "messages": messages,
        "temperature": temperature,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    start = time.monotonic()
    with httpx.Client(timeout=300) as client:
        resp = client.post(
            f"{_gemini_base()}/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
    content = data["choices"][0]["message"].get("content") or ""
    usage = data.get("usage") or {}
    return LlmResult(
        text=content,
        prompt_tokens=int(usage.get("prompt_tokens", 0) or 0),
        completion_tokens=int(usage.get("completion_tokens", 0) or 0),
        total_tokens=int(usage.get("total_tokens", 0) or 0),
        latency_ms=int((time.monotonic() - start) * 1000),
    )


@dataclass
class SttUsage:
    requests: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    http_429: int = 0


@dataclass
class TranscribeResult:
    language: str | None = None
    segments: list[dict] = field(default_factory=list)
    text: str = ""
    usage: SttUsage = field(default_factory=SttUsage)


def transcribe_chunk(client: httpx.Client, chunk_path: str, usage: SttUsage) -> tuple[str, str | None]:
    model = os.environ.get("STT_MODEL", "openai/whisper-large-v3-turbo")
    base = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    key = os.environ["OPENROUTER_API_KEY"]
    with open(chunk_path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode("ascii")
    payload = {"model": model, "input_audio": {"data": audio_b64, "format": "mp3"}}
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/stream-reduce",
        "X-Title": "stream-reduce",
    }
    backoff = 2.0
    for _ in range(5):
        resp = client.post(f"{base}/audio/transcriptions", json=payload, headers=headers)
        if resp.status_code == 429 or resp.status_code >= 500:
            usage.http_429 += int(resp.status_code == 429)
            time.sleep(backoff + random.uniform(0, 1))
            backoff *= 2
            continue
        resp.raise_for_status()
        data = resp.json()
        u = data.get("usage") or {}
        usage.requests += 1
        usage.total_tokens += int(u.get("total_tokens", 0) or 0)
        usage.cost_usd += float(u.get("cost", 0) or 0)
        return data.get("text") or "", data.get("language")
    raise RuntimeError(f"transcription failed for {chunk_path}")
