"""LLM + STT clients for the pipeline container.

Summary: the provided Gemini proxy (OpenAI-compatible /v1/chat/completions).
STT: OpenRouter /audio/transcriptions. Both read config from env vars injected
by the Worker (see cf/worker/src/pipeline/container.ts).
"""

from __future__ import annotations

import base64
import os
import random
import threading
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
    # HARD per-call wall-clock cap. httpx's `timeout` is per-read (gap between
    # bytes), so a proxy that *streams* a response slowly can run for many
    # minutes without tripping it — which let a single summarize call overrun the
    # worker's ~15min stream budget and leave items stuck in 'summarizing'. Run
    # the request in a daemon thread and abandon it past the deadline so the
    # caller can fall back. Normal calls finish in seconds.
    deadline = float(os.environ.get("LLM_TIMEOUT", "60"))
    box: dict = {}

    def _call() -> None:
        try:
            with httpx.Client(timeout=deadline) as client:
                resp = client.post(
                    f"{_gemini_base()}/chat/completions",
                    json=payload,
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                )
                resp.raise_for_status()
                box["data"] = resp.json()
        except BaseException as exc:  # noqa: BLE001 — propagated to the caller below
            box["err"] = exc

    thread = threading.Thread(target=_call, daemon=True)
    thread.start()
    thread.join(deadline + 5)
    if thread.is_alive():
        raise httpx.ReadTimeout(f"LLM call exceeded {deadline + 5:.0f}s hard timeout")
    if "err" in box:
        raise box["err"]
    data = box["data"]
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
class ImageResult:
    image_b64: str
    mime_type: str
    model: str
    prompt_tokens: int = 0
    image_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0


def _image_model() -> str:
    return os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview")


def _image_base() -> str:
    # Native Gemini (generateContent) endpoint. The OpenAI-compatible proxy used
    # for text can't return image output (it rejects the image mime), so image
    # generation talks to AI Studio directly.
    return os.environ.get("GEMINI_IMAGE_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")


def _image_key() -> str:
    # A dedicated Google AI Studio key for image generation; fall back to the
    # general Gemini key when a separate one isn't configured.
    return os.environ.get("GEMINI_IMAGE_API_KEY") or os.environ["GEMINI_API_KEY"]


# Gemini 3 Pro Image pricing (USD). Image output is a flat per-image rate at the
# default <=2K resolution (1120 output image tokens); text in/out are token-based.
_IMG_TOKEN_USD = 0.134 / 1120.0
_TEXT_OUT_USD = 12.0 / 1_000_000.0
_TEXT_IN_USD = 2.0 / 1_000_000.0


def generate_image(prompt: str, *, system: str | None = None) -> ImageResult:
    model = _image_model()
    payload: dict = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    start = time.monotonic()
    with httpx.Client(timeout=300) as client:
        resp = client.post(
            f"{_image_base()}/models/{model}:generateContent",
            json=payload,
            headers={"x-goog-api-key": _image_key(), "Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()

    parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts")) or []
    image_b64 = ""
    mime_type = "image/png"
    for part in parts:
        inline = part.get("inlineData") or part.get("inline_data")
        if inline and inline.get("data"):
            image_b64 = inline["data"]
            mime_type = inline.get("mimeType") or inline.get("mime_type") or mime_type
            break
    if not image_b64:
        raise RuntimeError("image model returned no image data")

    usage = data.get("usageMetadata") or {}
    prompt_tokens = int(usage.get("promptTokenCount", 0) or 0)
    total_tokens = int(usage.get("totalTokenCount", 0) or 0)
    image_tokens = 0
    for detail in usage.get("candidatesTokensDetails") or []:
        if (detail.get("modality") or "").upper() == "IMAGE":
            image_tokens += int(detail.get("tokenCount", 0) or 0)
    thoughts = int(usage.get("thoughtsTokenCount", 0) or 0)
    text_out = max(0, int(usage.get("candidatesTokenCount", 0) or 0) - image_tokens) + thoughts
    cost = image_tokens * _IMG_TOKEN_USD + text_out * _TEXT_OUT_USD + prompt_tokens * _TEXT_IN_USD

    return ImageResult(
        image_b64=image_b64,
        mime_type=mime_type,
        model=model,
        prompt_tokens=prompt_tokens,
        image_tokens=image_tokens,
        total_tokens=total_tokens,
        cost_usd=round(cost, 6),
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
