"""Build a paragraph-similarity knowledge graph from the summary embeddings.

Each **node is a summary paragraph** (an overview / key point / walkthrough span,
etc.) and each **edge links two paragraphs by the cosine similarity of their
embeddings** — never word frequency. Louvain communities only color the nodes.

We deliberately use *only the main summary paragraphs* (transcript chunks, raw
markdown, danmaku, single-word entities, etc. are excluded), so an article
contributes ~10 meaningful nodes. That keeps the set small enough to load the
vectors into a numpy matrix and compute an exact kNN graph in one pass — fast,
and free of the "a summary paragraph's nearest neighbors are just its own
transcript chunks" pollution.

All derived tables (``graphparagraph``, ``graphlink``, ``itemrecommendation``)
plus the pre-serialized ``graphcache`` blob are wiped and rewritten on each
build. Runs on the worker, async/nightly. An unchanged chunk fingerprint skips
the whole build.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from sqlalchemy import text as sql_text
from sqlmodel import Session, col, func, select

from app.config import get_settings
from app.db import session_scope
from app.models import (
    Chunk,
    ChunkSource,
    GraphCache,
    GraphLink,
    GraphParagraph,
    ItemRecommendation,
)

logger = logging.getLogger(__name__)

# Summary fields that count as "main paragraphs". Excludes quotes (too short /
# not topical), danmaku, atmosphere, single-word entities, the raw markdown
# dump, and all transcript chunks.
SUMMARY_FIELDS = {"tldr", "walkthrough", "background", "key_point", "outline"}

# Drop paragraphs shorter than this (chars) — one-liners add noise, not topics.
MIN_PARAGRAPH_CHARS = 50

# Cap the paragraph text carried in each node payload (full text lives in the DB
# row; summary paragraphs are short, but walkthrough windows can be long).
NODE_TEXT_CAP = 600


def _fingerprint(session: Session) -> str:
    """Content fingerprint of the chunk table; identical => nothing to rebuild."""
    count = int(session.exec(select(func.count()).select_from(Chunk)).one() or 0)
    max_id = int(session.exec(select(func.coalesce(func.max(Chunk.id), 0))).one() or 0)
    max_created = session.exec(select(func.max(Chunk.created_at))).one()
    return f"{count}:{max_id}:{max_created}"


def _to_vector(blob):
    import numpy as np

    if isinstance(blob, (bytes, bytearray, memoryview)):
        return np.frombuffer(bytes(blob), dtype=np.float32)
    if isinstance(blob, str):
        import json

        return np.asarray(json.loads(blob), dtype=np.float32)
    return np.asarray(blob, dtype=np.float32)


def _select_paragraphs(session: Session, cap: int) -> list[tuple[int, int, str, str]]:
    """The summary main-paragraph chunks that become graph nodes, as plain
    ``(chunk_id, item_id, field, text)`` tuples (detached from the session).

    Excludes quotes and short one-liners (< ``MIN_PARAGRAPH_CHARS``)."""
    rows = session.exec(
        select(Chunk.id, Chunk.item_id, Chunk.field, Chunk.text)
        .where(
            Chunk.source == ChunkSource.summary,
            col(Chunk.field).in_(SUMMARY_FIELDS),
            func.length(Chunk.text) >= MIN_PARAGRAPH_CHARS,
        )
        .order_by(col(Chunk.id).desc())
        .limit(cap)
    ).all()
    return [(int(r[0]), int(r[1]), r[2] or "", r[3] or "") for r in reversed(rows)]


def _load_matrix(session: Session, chunk_ids: list[int], dim: int):
    """Stack the paragraph vectors into a single (n, dim) float32 matrix.

    Small by construction (summary paragraphs only), so this fits comfortably in
    RAM and lets us compute an exact cosine kNN with one matmul.
    """
    import numpy as np

    mat = np.zeros((len(chunk_ids), dim), dtype=np.float32)
    index = {cid: i for i, cid in enumerate(chunk_ids)}
    found = np.zeros(len(chunk_ids), dtype=bool)
    rows = session.exec(sql_text("SELECT rowid, embedding FROM chunk_vec"))
    for rowid, blob in rows:
        i = index.get(int(rowid))
        if i is None:
            continue
        vec = _to_vector(blob)
        if vec.shape[0] == dim:
            mat[i] = vec
            found[i] = True
    return mat, found


def _knn_graph(mat, found, item_ids: list[int], k: int, threshold: float):
    """Exact cosine kNN over the (already unit-normalized) paragraph matrix.

    Edges only ever link paragraphs from *different* articles (intra-article
    similarity is masked out before the top-k), so the graph shows how separate
    articles relate. Returns the sparse undirected edge weights (keyed by matrix
    index) plus the cross-article weights used for related-article recs.
    """
    import numpy as np

    n = mat.shape[0]
    edges: dict[tuple[int, int], float] = {}
    item_pairs: dict[tuple[int, int], float] = defaultdict(float)
    if n < 2:
        return edges, item_pairs

    items = np.asarray(item_ids)
    # Cosine == dot product for unit vectors; mask self + missing rows.
    sim = mat @ mat.T
    np.fill_diagonal(sim, -1.0)
    sim[~found, :] = -1.0
    sim[:, ~found] = -1.0
    # Mask same-article pairs so neighbors are always cross-article.
    for i in range(n):
        sim[i, items == items[i]] = -1.0

    keep = min(k, n - 1)
    # Top-k neighbors per node (unsorted partition is enough to threshold).
    nbr_idx = np.argpartition(-sim, keep, axis=1)[:, :keep]
    for i in range(n):
        if not found[i]:
            continue
        for j in nbr_idx[i]:
            j = int(j)
            w = float(sim[i, j])
            if w < threshold:
                continue
            a, b = (i, j) if i < j else (j, i)
            if a == b:
                continue
            cur = edges.get((a, b))
            if cur is None or w > cur:
                edges[(a, b)] = w
            ia, ib = item_ids[a], item_ids[b]
            key = (ia, ib) if ia < ib else (ib, ia)
            item_pairs[key] += w
    return edges, item_pairs


def _communities(edges: dict[tuple[int, int], float], n: int) -> dict[int, int]:
    """Louvain community per node index (singletons get their own community)."""
    import networkx as nx
    from networkx.algorithms.community import louvain_communities

    graph = nx.Graph()
    graph.add_nodes_from(range(n))
    for (a, b), w in edges.items():
        graph.add_edge(a, b, weight=w)
    comms = louvain_communities(graph, weight="weight", resolution=get_settings()
                                .graph_louvain_resolution, seed=42)
    comms = sorted(comms, key=len, reverse=True)
    node_community: dict[int, int] = {}
    for idx, comm in enumerate(comms):
        for node in comm:
            node_community[node] = idx
    return node_community


def _recommendations(
    item_pairs: dict[tuple[int, int], float], top_k: int
) -> dict[int, list[tuple[int, float]]]:
    neighbors: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for (a, b), w in item_pairs.items():
        neighbors[a].append((b, w))
        neighbors[b].append((a, w))
    return {
        item: sorted(rel, key=lambda t: t[1], reverse=True)[:top_k]
        for item, rel in neighbors.items()
    }


def _wipe(session: Session) -> None:
    for table in ("graphparagraph", "graphlink", "itemrecommendation"):
        session.exec(sql_text(f"DELETE FROM {table}"))


def build_graph(force: bool = False) -> dict:
    """(Re)build the paragraph-similarity knowledge graph. Returns a summary."""
    settings = get_settings()
    from app import db

    if not settings.enable_graph or not settings.enable_embeddings or not db.VEC_AVAILABLE:
        logger.info("graph build skipped (disabled or sqlite-vec unavailable)")
        return {"skipped": True, "reason": "disabled"}

    with session_scope() as session:
        fingerprint = _fingerprint(session)
        cache = session.get(GraphCache, 1)
        if (
            not force
            and cache is not None
            and cache.fingerprint == fingerprint
            and cache.node_count > 0
        ):
            logger.info("graph build skipped (fingerprint unchanged: %s)", fingerprint)
            return {"skipped": True, "reason": "unchanged", "fingerprint": fingerprint}
        build_id = (cache.build_id + 1) if cache is not None else 1
        paragraphs = _select_paragraphs(session, settings.graph_max_chunks)

    if not paragraphs:
        logger.info("graph build: no summary paragraphs to graph")
        return {"skipped": True, "reason": "no_paragraphs"}

    chunk_ids = [p[0] for p in paragraphs]
    item_ids = [p[1] for p in paragraphs]

    with session_scope() as session:
        mat, found = _load_matrix(session, chunk_ids, settings.embedding_dim)

    edges, item_pairs = _knn_graph(
        mat, found, item_ids, settings.graph_knn_k, settings.graph_sim_threshold
    )
    node_community = _communities(edges, len(chunk_ids))
    recs = _recommendations(item_pairs, settings.graph_related_top_k)

    degree: dict[int, int] = defaultdict(int)
    for a, b in edges:
        degree[a] += 1
        degree[b] += 1

    # Only keep paragraphs that connect to another article — the point of the
    # graph is relatedness, so isolated nodes are dropped.
    kept = [i for i in range(len(chunk_ids)) if degree.get(i, 0) >= 1]

    with session_scope() as session:
        _wipe(session)
        for i in kept:
            cid, iid, fld, txt = paragraphs[i]
            session.add(
                GraphParagraph(
                    build_id=build_id,
                    chunk_id=cid,
                    item_id=iid,
                    field=fld,
                    text=txt[:NODE_TEXT_CAP],
                    community=node_community.get(i, 0),
                    degree=degree.get(i, 0),
                )
            )
        for (a, b), w in edges.items():
            sa, sb = chunk_ids[a], chunk_ids[b]
            src, dst = (sa, sb) if sa < sb else (sb, sa)
            session.add(GraphLink(src_chunk_id=src, dst_chunk_id=dst, weight=round(w, 4)))
        for item_id, rel in recs.items():
            for other, score in rel:
                session.add(
                    ItemRecommendation(
                        item_id=item_id, related_item_id=other, score=round(score, 4)
                    )
                )
        session.flush()

        from app.graph import aggregate_graph

        blob = aggregate_graph(session, allowed_item_ids=None, build_id=build_id)
        import json

        cache = session.get(GraphCache, 1) or GraphCache(id=1)
        cache.build_id = build_id
        cache.blob = json.dumps(blob, ensure_ascii=False)
        cache.fingerprint = fingerprint
        cache.node_count = len(kept)
        cache.item_count = len({item_ids[i] for i in kept})
        from app.models import utcnow

        cache.built_at = utcnow()
        session.add(cache)

    result = {
        "build_id": build_id,
        "nodes": len(kept),
        "candidates": len(chunk_ids),
        "edges": len(edges),
        "items": len({item_ids[i] for i in kept}),
        "communities": len({node_community.get(i, 0) for i in kept}),
        "recommendations": sum(len(r) for r in recs.values()),
        "fingerprint": fingerprint,
    }
    logger.info("graph build complete: %s", result)
    return result


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    import argparse

    from app.db import init_db

    parser = argparse.ArgumentParser(description="Build the paragraph knowledge graph.")
    parser.add_argument("--force", action="store_true", help="rebuild even if unchanged")
    args = parser.parse_args()
    init_db()
    result = build_graph(force=args.force)
    print(result)


if __name__ == "__main__":
    main()
