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

    # Embeddings: text-embedding-005 served by the same LiteLLM proxy. Vectors
    # are stored in a sqlite-vec virtual table for semantic search over chunked
    # transcripts + summaries. Falls back to the LLM proxy's base url / api key.
    enable_embeddings: bool = True
    embedding_model: str = "text-embedding-005"
    embedding_base_url: str = ""  # empty => reuse llm_base_url
    embedding_api_key: str = ""  # empty => reuse llm_api_key
    embedding_dim: int = 768
    # Target size of each embedded text chunk (characters). Small enough to keep
    # peak memory low on constrained hosts (e.g. a low-RAM NAS).
    embed_chunk_chars: int = 1500
    # Max texts per embedding request; bounds in-flight memory.
    embed_batch_size: int = 32

    # Knowledge graph: each node is a summary paragraph, edges link paragraphs by
    # cosine similarity of their embeddings, Louvain communities color the nodes.
    # All work runs in the worker, async/nightly.
    enable_graph: bool = True
    # Neighbors kept per paragraph when building the similarity (kNN) graph.
    graph_knn_k: int = 6
    # Minimum cosine similarity for an edge to count (prunes weak links).
    graph_sim_threshold: float = 0.6
    # Louvain resolution; >1 yields more, smaller communities.
    graph_louvain_resolution: float = 1.0
    # Safety cap on paragraph nodes (most-recent first beyond this).
    graph_max_chunks: int = 20000
    # Related-article recommendations kept per item.
    graph_related_top_k: int = 8
    # How often the scheduler triggers an automatic rebuild.
    graph_rebuild_hours: int = 24

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
    # Optional proxy for yt-dlp egress (http(s)://… or socks5://…), e.g. a WARP
    # or residential proxy to dodge datacenter-IP blocks. On the Cloudflare
    # stack PROXY_URLS (WARP rotation) takes precedence; this is the single-proxy
    # / self-hosted knob.
    yt_dlp_proxy: str = ""

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

    @property
    def resolved_embedding_base_url(self) -> str:
        return self.embedding_base_url or self.llm_base_url

    @property
    def resolved_embedding_api_key(self) -> str:
        return self.embedding_api_key or self.llm_api_key

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.resolved_media_dir.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_dirs()
    return settings
