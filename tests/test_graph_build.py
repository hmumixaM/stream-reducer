"""End-to-end test for the paragraph-similarity knowledge graph.

Spins up an isolated sqlite-vec engine (skipped when the extension is
unavailable) and exercises the whole pipeline: summary paragraphs become nodes,
embedding similarity becomes edges, transcript chunks are excluded, and
related-article recommendations fall out of cross-article similarity.
"""

from __future__ import annotations

import pytest


def _vec_engine(tmp_path):
    sqlite_vec = pytest.importorskip("sqlite_vec")
    from sqlalchemy import create_engine, event
    from sqlmodel import SQLModel

    url = f"sqlite:///{tmp_path / 'graph_test.db'}"
    engine = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _load(dbapi_connection, _record):  # noqa: ANN001
        dbapi_connection.enable_load_extension(True)
        sqlite_vec.load(dbapi_connection)
        dbapi_connection.enable_load_extension(False)

    import app.models  # noqa: F401  register tables

    SQLModel.metadata.create_all(engine)
    return engine


def test_build_graph_end_to_end(tmp_path, monkeypatch):
    sqlite_vec = pytest.importorskip("sqlite_vec")
    np = pytest.importorskip("numpy")
    pytest.importorskip("networkx")

    from sqlalchemy import text as sql_text
    from sqlmodel import Session

    import app.db as db
    from app.config import get_settings
    from app.embedding import l2_normalize
    from app.graph import focus_node, get_graph, related_items
    from app.models import Chunk, ChunkSource, Item, Platform

    dim = 8
    settings = get_settings()
    monkeypatch.setattr(settings, "embedding_dim", dim)
    monkeypatch.setattr(settings, "graph_knn_k", 6)
    monkeypatch.setattr(settings, "graph_sim_threshold", 0.3)
    monkeypatch.setattr(settings, "graph_louvain_resolution", 1.0)
    monkeypatch.setattr(settings, "enable_graph", True)
    monkeypatch.setattr(settings, "enable_embeddings", True)

    engine = _vec_engine(tmp_path)
    monkeypatch.setattr(db, "engine", engine)
    monkeypatch.setattr(db, "VEC_AVAILABLE", True)

    with Session(engine) as s:
        s.exec(sql_text(f"CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[{dim}])"))
        s.commit()

    rng = np.random.default_rng(0)
    topics = {1: 0, 2: 0, 3: 1, 4: 1}

    with Session(engine) as s:
        for item_id in topics:
            s.add(Item(id=item_id, platform=Platform.youtube, source_url=f"http://x/{item_id}",
                       title=f"item{item_id}"))
        s.commit()
        for item_id, axis in topics.items():
            for _ in range(3):
                base = np.zeros(dim, dtype=np.float32)
                base[axis] = 1.0
                vec = base + rng.normal(0, 0.05, dim).astype(np.float32)
                chunk = Chunk(item_id=item_id, source=ChunkSource.summary, field="key_point",
                              text=f"summary paragraph for topic {axis}")
                s.add(chunk)
                s.flush()
                s.exec(
                    sql_text("INSERT INTO chunk_vec(rowid, embedding) VALUES (:r, :e)").bindparams(
                        r=chunk.id, e=sqlite_vec.serialize_float32(l2_normalize(vec.tolist()))
                    )
                )
            # A transcript chunk that must NOT become a graph node.
            tchunk = Chunk(item_id=item_id, source=ChunkSource.transcript, field="transcript",
                           text="transcript noise")
            s.add(tchunk)
            s.flush()
            s.exec(
                sql_text("INSERT INTO chunk_vec(rowid, embedding) VALUES (:r, :e)").bindparams(
                    r=tchunk.id,
                    e=sqlite_vec.serialize_float32(l2_normalize(rng.normal(0, 1, dim).tolist())),
                )
            )
        s.commit()

    from app.pipeline.graph_build import build_graph

    result = build_graph(force=True)
    # 4 items x 3 summary paragraphs; transcript chunks excluded.
    assert result["nodes"] == 12
    assert result["items"] == 4
    assert result["edges"] > 0
    assert result["communities"] >= 2

    with Session(engine) as s:
        graph = get_graph(s)
        assert len(graph["nodes"]) == 12
        covered = {n["item_id"] for n in graph["nodes"]}
        assert covered == {1, 2, 3, 4}
        # Every node is a summary paragraph (no transcript field present).
        assert all(n["field"] == "key_point" for n in graph["nodes"])

        rel1 = {r["item_id"] for r in related_items(s, 1)}
        assert 2 in rel1 and 3 not in rel1 and 4 not in rel1

        assert focus_node(s, 1) is not None
