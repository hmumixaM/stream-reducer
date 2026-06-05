"""Application configuration loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = PROJECT_ROOT / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Storage
    data_dir: Path = DEFAULT_DATA_DIR
    database_url: str = ""
    media_dir: Path | None = None

    # Queue / broker
    redis_url: str = "redis://localhost:6379/0"

    # LLM: Gemini models served by a LiteLLM proxy (OpenAI-compatible API)
    llm_base_url: str = "https://your-litellm-host/v1"
    llm_api_key: str = ""
    llm_model: str = "gemini-3.5-flash"
    llm_temperature: float = 0.2

    # Speech-to-text via OpenRouter
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    stt_model: str = "openai/whisper-large-v3-turbo"
    transcribe_chunk_seconds: int = 300
    transcribe_rate_limit: int = 20  # max STT requests per minute
    transcribe_max_retries: int = 5
    transcribe_concurrency: int = 1

    # Summarization
    summary_prompt_version: str = "v2"
    # Fast model for the per-chunk map step; the main llm_model handles the
    # final reduce. Keeps long-transcript summarization fast and cheap.
    summary_map_model: str = "gemini-3.5-flash"
    # Smaller chunks => more detail budget per section in the walkthrough.
    summary_chunk_chars: int = 20000
    # Generous output budgets so the detailed walkthrough is not truncated.
    summary_map_max_tokens: int = 8000
    summary_reduce_max_tokens: int = 16000
    enable_gemini_audio_fallback: bool = False

    # MCP server for AI agents (mounted at /mcp on the web app)
    enable_mcp: bool = True

    # Subscriptions
    default_poll_interval_minutes: int = 60

    # Behaviour
    default_language: str = ""  # empty => auto-detect (STT) / use video's main language
    # Tiebreaker when several native caption tracks exist; also the language a
    # mislabeled track is validated against before we trust it.
    preferred_language: str = "zh"
    track_api_calls: bool = True
    yt_dlp_cookies_file: str = ""

    # HTTP metadata for OpenRouter rankings (optional)
    openrouter_referer: str = "https://github.com/stream-reduce"
    openrouter_title: str = "stream-reduce"

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{self.data_dir / 'stream_reduce.db'}"

    @property
    def resolved_media_dir(self) -> Path:
        return self.media_dir or (self.data_dir / "media")

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.resolved_media_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
