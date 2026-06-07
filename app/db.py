"""Database engine and session management."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings

logger = logging.getLogger(__name__)

_settings = get_settings()

# Set False once if the sqlite-vec extension cannot be loaded, so the rest of
# the app degrades gracefully (ingest still works; semantic search is disabled).
VEC_AVAILABLE = False

connect_args = {"check_same_thread": False} if _settings.resolved_database_url.startswith(
    "sqlite"
) else {}

engine: Engine = create_engine(
    _settings.resolved_database_url,
    echo=False,
    connect_args=connect_args,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_connection, _connection_record):
    # WAL improves concurrency between web + worker processes on SQLite.
    if not _settings.resolved_database_url.startswith("sqlite"):
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    # Generous busy timeout: the web, the RQ worker, and one-off jobs (e.g. the
    # embedding backfill) all write to the same SQLite file. WAL allows a single
    # writer, so a second writer must wait out the first; 30s comfortably rides
    # over the short write bursts instead of raising "database is locked".
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()
    # Load sqlite-vec on every connection so both the web and worker processes
    # can run KNN queries. The flag mirrors success/failure for callers.
    if _settings.enable_embeddings:
        _load_sqlite_vec(dbapi_connection)


def _load_sqlite_vec(dbapi_connection) -> None:
    global VEC_AVAILABLE
    try:
        import sqlite_vec

        dbapi_connection.enable_load_extension(True)
        sqlite_vec.load(dbapi_connection)
        dbapi_connection.enable_load_extension(False)
        VEC_AVAILABLE = True
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never break ingest
        if VEC_AVAILABLE:
            # Was working before; surface the regression but keep serving.
            logger.warning("sqlite-vec failed to load on a new connection: %s", exc)
        else:
            logger.warning(
                "sqlite-vec unavailable (%s); semantic search disabled. "
                "Install it (`uv sync`) and ensure your Python supports loadable "
                "SQLite extensions.",
                exc,
            )


def init_db() -> None:
    import app.models  # noqa: F401  ensure tables are registered

    SQLModel.metadata.create_all(engine)
    _ensure_columns()
    _ensure_vec_table()


def _ensure_vec_table() -> None:
    """Create the sqlite-vec virtual table that holds chunk embeddings.

    Keyed by rowid == chunk.id so KNN hits join straight back to the ``chunk``
    table. No-op (with a warning) when the extension is unavailable.
    """
    if not _settings.enable_embeddings:
        return
    if not _settings.resolved_database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.begin() as conn:
        if not VEC_AVAILABLE:
            return
        dim = _settings.embedding_dim
        conn.execute(
            text(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec "
                f"USING vec0(embedding float[{dim}])"
            )
        )


# Columns added after the initial schema; create_all won't ALTER existing tables,
# so add them idempotently for SQLite databases created before the feature landed.
_ADDED_COLUMNS = {
    # The knowledge graph was reshaped from topic clusters to a paragraph graph;
    # graphcache gained node_count (the old cluster_count column is left unused).
    "graphcache": {
        "node_count": "INTEGER NOT NULL DEFAULT 0",
    },
    "item": {
        "is_favorite": "BOOLEAN NOT NULL DEFAULT 0",
        "is_archived": "BOOLEAN NOT NULL DEFAULT 0",
        "media_bytes": "INTEGER NOT NULL DEFAULT 0",
        "audio_duration_s": "FLOAT",
        "media_path": "VARCHAR",
        "view_count": "INTEGER",
        "like_count": "INTEGER",
        "dislike_count": "INTEGER",
        "group_id": "INTEGER",
        "group_position": "INTEGER",
    },
}


def _ensure_columns() -> None:
    if not _settings.resolved_database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {
                row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))
            }
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


@contextmanager
def session_scope() -> Iterator[Session]:
    session = Session(engine)
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
