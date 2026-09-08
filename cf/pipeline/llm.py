"""LLM, image, and STT clients for the pipeline container.

Summary: the provided Gemini proxy (OpenAI-compatible /v1/chat/completions).
Images: RightCode Draw's asynchronous GPT Image endpoint.
STT: OpenRouter /audio/transcriptions. All read config from env vars injected
by the Worker (see cf/worker/src/pipeline/container.ts).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import threading
import time
from collections.abc import Callable
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


def _gemini_model_fallback() -> str:
    # Backup model on the same proxy; empty disables the fallback retry.
    return os.environ.get("GEMINI_MODEL_FALLBACK", "").strip()


_EMPTY_RESPONSE_MARKERS = (
    "upstream gemini returned an empty response",
    "gemini returns no response",
    "gemini returned no response",
)


def _validated_chat_content(data: object, model: str) -> str:
    """Return usable assistant text or raise a retryable protocol error.

    The Gemini proxy has historically answered HTTP 200 with either an empty
    ``content`` field or a short diagnostic paragraph beginning "Upstream
    Gemini returned an empty response". Treating that as a successful summary
    persisted 171 garbage episode bodies. A protocol-shaped error lets
    ``generate_text`` try the configured fallback model and, if both fail,
    makes the item retry rather than marking it done with the diagnostic text.
    """
    try:
        choice = data["choices"][0]  # type: ignore[index]
        content = choice["message"].get("content") or ""
    except (KeyError, IndexError, TypeError, AttributeError) as exc:
        raise httpx.RemoteProtocolError(
            f"LLM response from {model} has no assistant content",
        ) from exc
    finish_reason = choice.get("finish_reason")
    if finish_reason in {"length", "max_tokens"}:
        raise httpx.RemoteProtocolError(
            f"LLM response from {model} was truncated ({finish_reason})",
        )
    if not isinstance(content, str):
        raise httpx.RemoteProtocolError(f"LLM response from {model} has non-text content")

    normalized = " ".join(content.lower().split())
    if not normalized:
        raise httpx.RemoteProtocolError(f"LLM response from {model} is empty")
    if len(normalized) < 1000 and any(marker in normalized for marker in _EMPTY_RESPONSE_MARKERS):
        raise httpx.RemoteProtocolError(
            f"LLM response from {model} is an upstream empty-response diagnostic",
        )
    return content


def _chat_once(model: str, messages: list[dict], temperature: float, max_tokens: int | None, key: str) -> LlmResult:
    payload: dict = {"model": model, "messages": messages, "temperature": temperature}
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    start = time.monotonic()
    # HARD per-call wall-clock cap. httpx's `timeout` is per-read (gap between
    # bytes), so a proxy that *streams* a response slowly can run for many
    # minutes without tripping it — which let a single summarize call overrun the
    # worker's stream budget and leave items stuck in 'summarizing'. Run the
    # request in a daemon thread and abandon it past the deadline so the caller
    # can fall back. Normal calls finish in seconds.
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
        raise httpx.ReadTimeout(f"LLM call ({model}) exceeded {deadline + 5:.0f}s hard timeout")
    if "err" in box:
        raise box["err"]
    data = box["data"]
    content = _validated_chat_content(data, model)
    usage = data.get("usage") or {}
    return LlmResult(
        text=content,
        prompt_tokens=int(usage.get("prompt_tokens", 0) or 0),
        completion_tokens=int(usage.get("completion_tokens", 0) or 0),
        total_tokens=int(usage.get("total_tokens", 0) or 0),
        latency_ms=int((time.monotonic() - start) * 1000),
    )


def generate_text(
    prompt: str,
    *,
    system: str | None = None,
    model: str | None = None,
    max_tokens: int | None = None,
    temperature: float = 0.2,
    content_error: Callable[[str], str | None] | None = None,
) -> LlmResult:
    key = os.environ["GEMINI_API_KEY"]
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    # Try the primary model, then (once) the configured backup model if the
    # primary times out, errors, or returns unusable content — so a
    # flaky/overloaded primary doesn't force the section to fall back to an
    # empty summary.
    primary = model or _gemini_model()
    attempts = [primary]
    fallback = _gemini_model_fallback()
    if fallback and fallback != primary:
        attempts.append(fallback)

    log = logging.getLogger("pipeline")
    last_exc: httpx.HTTPError | None = None
    for attempt_model in attempts:
        try:
            res = _chat_once(attempt_model, messages, temperature, max_tokens, key)
            issue = content_error(res.text) if content_error else None
            if issue:
                raise httpx.RemoteProtocolError(
                    f"LLM response from {attempt_model} failed quality validation: {issue}",
                )
            log.info(
                "llm ok model=%s %dms tokens=%d",
                attempt_model,
                res.latency_ms,
                res.total_tokens,
            )
            return res
        except httpx.HTTPError as exc:
            last_exc = exc
            log.warning("LLM call on model %s failed: %s", attempt_model, exc)
    raise last_exc  # type: ignore[misc]  # at least one attempt always ran


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
    return os.environ.get("IMAGE_MODEL", "gpt-image-2-vip")


def _image_base() -> str:
    return os.environ.get("IMAGE_BASE_URL", "https://www.rightapi.ai/draw").rstrip("/")


def _image_key() -> str:
    return os.environ["RIGHTCODE_API_KEY"]


def _image_url(payload: dict) -> str | None:
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


def generate_image(prompt: str, *, system: str | None = None) -> ImageResult:
    model = _image_model()
    full_prompt = f"{system}\n\n{prompt}" if system else prompt
    payload = {
        "model": model,
        "prompt": full_prompt,
        "n": 1,
        "size": os.environ.get("IMAGE_ASPECT_RATIO", "16:9"),
        "imageSize": os.environ.get("IMAGE_SIZE", "4K"),
        "async": True,
    }
    start = time.monotonic()
    headers = {
        "Authorization": f"Bearer {_image_key()}",
        "Content-Type": "application/json",
    }
    deadline = float(os.environ.get("IMAGE_TIMEOUT", "600"))
    with httpx.Client(timeout=120, headers=headers) as client:
        resp = client.post(
            f"{_image_base()}/v1/images/generations",
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        task_id = data.get("task_id")
        if not task_id:
            raise RuntimeError("RightCode image request returned no task_id")
        task_url = os.environ.get(
            "IMAGE_TASK_BASE_URL",
            "https://www.rightapi.ai/v1/tasks",
        ).rstrip("/")
        while not (url := _image_url(data)):
            if time.monotonic() - start >= deadline:
                raise TimeoutError(
                    f"RightCode image task {task_id} exceeded {deadline:.0f}s",
                )
            time.sleep(2)
            task_resp = client.get(f"{task_url}/{task_id}")
            task_resp.raise_for_status()
            data = task_resp.json()
            if data.get("status") == "failed":
                error = data.get("error") or "unknown task failure"
                if isinstance(error, dict):
                    error = json.dumps(error, ensure_ascii=False)
                raise RuntimeError(f"RightCode image task failed: {error}")

        image_resp = client.get(url)
        image_resp.raise_for_status()
        mime_type = image_resp.headers.get("content-type", "image/png").split(";", 1)[0]
        image_b64 = base64.b64encode(image_resp.content).decode("ascii")

    return ImageResult(
        image_b64=image_b64,
        mime_type=mime_type,
        model=model,
        total_tokens=0,
        cost_usd=float(os.environ.get("IMAGE_COST_USD", "0.13")),
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
    log = logging.getLogger("pipeline")
    model = os.environ.get("STT_MODEL", "openai/whisper-large-v3-turbo")
    base = os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    key = os.environ["OPENROUTER_API_KEY"]
    chunk_bytes = os.path.getsize(chunk_path)
    # An empty/near-empty segment (ffmpeg can emit a tiny trailing chunk) has no
    # decodable audio; POSTing it makes the STT provider 400. Skip it cleanly.
    if chunk_bytes < 1024:
        log.warning("transcribe_chunk skipping tiny chunk=%s bytes=%d", os.path.basename(chunk_path), chunk_bytes)
        return "", None
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
        if resp.status_code >= 400:
            # Log the provider's reason (size/format/model/audio) before raising —
            # raise_for_status() drops the body, which hid WHY STT 400'd.
            log.error(
                "transcribe_chunk HTTP %d model=%s chunk=%s bytes=%d b64len=%d body=%s",
                resp.status_code, model, os.path.basename(chunk_path), chunk_bytes,
                len(audio_b64), resp.text[:600],
            )
        resp.raise_for_status()
        data = resp.json()
        u = data.get("usage") or {}
        usage.requests += 1
        usage.total_tokens += int(u.get("total_tokens", 0) or 0)
        usage.cost_usd += float(u.get("cost", 0) or 0)
        return data.get("text") or "", data.get("language")
    raise RuntimeError(f"transcription failed for {chunk_path}")
