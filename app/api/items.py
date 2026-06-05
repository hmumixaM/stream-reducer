"""Item endpoints: add, list, detail, retry, regenerate, delete."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.db import get_session
from app.models import (
    Comment,
    Item,
    ItemGroup,
    ItemStatus,
    Platform,
    StageRun,
    Summary,
    Transcript,
)
from app.pipeline.ingest import create_group_from_url, create_item_from_url
from app.queue import enqueue_item, enqueue_resummarize
from app.schemas import (
    AddItemRequest,
    CommentCreate,
    CommentRead,
    GroupCreate,
    GroupRead,
    GroupUpdate,
    ItemDetail,
    ItemGroupAssign,
    ItemRead,
    StageRunRead,
    SummaryRead,
    TranscriptRead,
)

router = APIRouter(prefix="/api/items", tags=["items"])


@router.post("", response_model=list[ItemRead])
def add_items(payload: AddItemRequest, session: Session = Depends(get_session)) -> list[Item]:
    raw = list(payload.urls or [])
    if payload.url:
        raw.append(payload.url)
    # Each entry may hold several URLs separated by whitespace/newlines/commas.
    urls = [u for entry in raw for u in re.split(r"[\s,]+", entry.strip()) if u]
    if not urls:
        raise HTTPException(status_code=400, detail="no urls provided")

    created: list[Item] = []
    seen_ids: set[int] = set()

    def _add(item: Item) -> None:
        if item.id in seen_ids:
            return
        seen_ids.add(item.id)
        enqueue_item(item.id)
        created.append(item)

    for url in urls:
        # A playlist/collection URL expands into many grouped items; a plain
        # URL becomes a single item.
        group = create_group_from_url(session, url)
        if group is not None:
            for item in group[1]:
                _add(item)
            continue
        _add(create_item_from_url(session, url))  # normalizes + dedups vs DB
    return created


@router.get("/groups", response_model=list[GroupRead])
def list_groups(
    session: Session = Depends(get_session),
    archived: bool | None = None,
) -> list[GroupRead]:
    """List folders.

    `archived` unset: all folders with their stored total `item_count`.
    `archived` true/false: only folders that have >=1 member with that archived
    flag, and `item_count` reflects that filtered count (folder-first views show
    just the relevant folders without persisting the filtered count).
    """
    groups = session.exec(
        select(ItemGroup).order_by(col(ItemGroup.created_at).desc())
    ).all()
    if archived is None:
        return [GroupRead.model_validate(g, from_attributes=True) for g in groups]

    out: list[GroupRead] = []
    for g in groups:
        count = session.exec(
            select(func.count())
            .select_from(Item)
            .where(Item.group_id == g.id, Item.is_archived == archived)
        ).one()
        if count:
            read = GroupRead.model_validate(g, from_attributes=True)
            read.item_count = count
            out.append(read)
    return out


@router.post("/groups", response_model=GroupRead)
def create_group(payload: GroupCreate, session: Session = Depends(get_session)) -> ItemGroup:
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="empty folder name")
    group = ItemGroup(platform=Platform.unknown, source_url="", title=title, item_count=0)
    session.add(group)
    session.commit()
    session.refresh(group)
    return group


@router.patch("/groups/{group_id}", response_model=GroupRead)
def rename_group(
    group_id: int, payload: GroupUpdate, session: Session = Depends(get_session)
) -> ItemGroup:
    group = session.get(ItemGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="folder not found")
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="empty folder name")
    group.title = title
    session.add(group)
    session.commit()
    session.refresh(group)
    return group


@router.delete("/groups/{group_id}")
def delete_group(group_id: int, session: Session = Depends(get_session)) -> dict:
    """Delete a folder. Its items are kept and simply detached from the folder."""
    group = session.get(ItemGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="folder not found")
    for item in session.exec(select(Item).where(Item.group_id == group_id)).all():
        item.group_id = None
        item.group_position = None
        session.add(item)
    session.delete(group)
    session.commit()
    return {"ok": True}


_SORT_COLUMNS = {
    "added": Item.created_at,
    "published": Item.published_at,
    "views": Item.view_count,
    "likes": Item.like_count,
    "duration": Item.duration_s,
    "position": Item.group_position,
}


@router.get("", response_model=list[ItemRead])
def list_items(
    session: Session = Depends(get_session),
    status: ItemStatus | None = None,
    platform: Platform | None = None,
    q: str | None = None,
    favorite: bool | None = None,
    archived: bool | None = None,
    group_id: int | None = None,
    ungrouped: bool | None = None,
    sort: str = "added",
    order: str = "desc",
    limit: int = Query(default=100, le=500),
    offset: int = 0,
) -> list[Item]:
    stmt = select(Item)
    if status is not None:
        stmt = stmt.where(Item.status == status)
    if platform is not None:
        stmt = stmt.where(Item.platform == platform)
    if favorite is not None:
        stmt = stmt.where(Item.is_favorite == favorite)
    if archived is not None:
        stmt = stmt.where(Item.is_archived == archived)
    if group_id is not None:
        stmt = stmt.where(Item.group_id == group_id)
    if ungrouped:
        stmt = stmt.where(col(Item.group_id).is_(None))
    if q:
        stmt = stmt.where(col(Item.title).ilike(f"%{q}%"))

    sort_col = col(_SORT_COLUMNS.get(sort, Item.created_at))
    ordering = sort_col.asc() if order == "asc" else sort_col.desc()
    # Keep a stable secondary key so rows with NULL/equal sort values stay deterministic.
    stmt = stmt.order_by(ordering, col(Item.created_at).desc()).offset(offset).limit(limit)
    return list(session.exec(stmt).all())


@router.get("/{item_id}", response_model=ItemDetail)
def get_item(item_id: int, session: Session = Depends(get_session)) -> ItemDetail:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    summary = session.exec(select(Summary).where(Summary.item_id == item_id)).first()
    transcript = session.exec(
        select(Transcript).where(Transcript.item_id == item_id)
    ).first()
    stages = session.exec(
        select(StageRun).where(StageRun.item_id == item_id).order_by(col(StageRun.id))
    ).all()
    comments = session.exec(
        select(Comment).where(Comment.item_id == item_id).order_by(col(Comment.created_at))
    ).all()
    detail = ItemDetail.model_validate(item, from_attributes=True)
    detail.summary = SummaryRead.model_validate(summary, from_attributes=True) if summary else None
    detail.transcript = (
        TranscriptRead.model_validate(transcript, from_attributes=True) if transcript else None
    )
    detail.stages = [StageRunRead.model_validate(s, from_attributes=True) for s in stages]
    detail.comments = [CommentRead.model_validate(c, from_attributes=True) for c in comments]
    return detail


@router.post("/{item_id}/retry", response_model=ItemRead)
def retry_item(item_id: int, session: Session = Depends(get_session)) -> Item:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    item.status = ItemStatus.queued
    item.error = None
    session.add(item)
    session.commit()
    session.refresh(item)
    enqueue_item(item.id)
    return item


@router.post("/{item_id}/group", response_model=ItemRead)
def set_item_group(
    item_id: int, payload: ItemGroupAssign, session: Session = Depends(get_session)
) -> Item:
    """Move an item into a folder (group_id) or detach it (group_id=null)."""
    item = _get_or_404(session, item_id)
    old_group_id = item.group_id
    new_group_id = payload.group_id
    if new_group_id is not None:
        group = session.get(ItemGroup, new_group_id)
        if group is None:
            raise HTTPException(status_code=404, detail="folder not found")
        # Append to the end of the destination folder.
        members = session.exec(select(Item).where(Item.group_id == new_group_id)).all()
        item.group_position = len(members)
    else:
        item.group_position = None
    item.group_id = new_group_id
    session.add(item)
    session.commit()
    if old_group_id is not None and old_group_id != new_group_id:
        _refresh_group(session, old_group_id)
    if new_group_id is not None:
        _refresh_group(session, new_group_id)
    session.refresh(item)
    return ItemRead.model_validate(item, from_attributes=True)


@router.post("/{item_id}/regenerate", response_model=ItemRead)
def regenerate_summary(item_id: int, session: Session = Depends(get_session)) -> Item:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    transcript = session.exec(
        select(Transcript).where(Transcript.item_id == item_id)
    ).first()
    if transcript is None:
        # No transcript yet: run the full pipeline instead.
        item.status = ItemStatus.queued
        session.add(item)
        session.commit()
        enqueue_item(item.id)
    else:
        # Flip status synchronously so the client immediately sees it is
        # reprocessing and resumes polling for the new summary.
        item.status = ItemStatus.summarizing
        item.error = None
        session.add(item)
        session.commit()
        enqueue_resummarize(item.id)
    session.refresh(item)
    return item


@router.post("/{item_id}/favorite", response_model=ItemRead)
def toggle_favorite(item_id: int, session: Session = Depends(get_session)) -> Item:
    item = _get_or_404(session, item_id)
    item.is_favorite = not item.is_favorite
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.post("/{item_id}/archive", response_model=ItemRead)
def toggle_archive(item_id: int, session: Session = Depends(get_session)) -> Item:
    item = _get_or_404(session, item_id)
    item.is_archived = not item.is_archived
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.post("/{item_id}/comments", response_model=CommentRead)
def add_comment(
    item_id: int, payload: CommentCreate, session: Session = Depends(get_session)
) -> Comment:
    _get_or_404(session, item_id)
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="empty comment")
    comment = Comment(item_id=item_id, body=body)
    session.add(comment)
    session.commit()
    session.refresh(comment)
    return comment


@router.delete("/{item_id}/comments/{comment_id}")
def delete_comment(
    item_id: int, comment_id: int, session: Session = Depends(get_session)
) -> dict:
    comment = session.get(Comment, comment_id)
    if comment is None or comment.item_id != item_id:
        raise HTTPException(status_code=404, detail="comment not found")
    session.delete(comment)
    session.commit()
    return {"ok": True}


@router.delete("/{item_id}/media")
def delete_media(item_id: int, session: Session = Depends(get_session)) -> ItemRead:
    """Delete only the retained downloaded audio file (keeps the item + summary).

    Handy for debugging a bad download: removing the file lets a single Retry
    re-download a clean copy.
    """
    item = _get_or_404(session, item_id)
    _delete_media_file(item)
    item.media_path = None
    item.media_bytes = 0
    item.audio_duration_s = None
    session.add(item)
    session.commit()
    session.refresh(item)
    return ItemRead.model_validate(item, from_attributes=True)


@router.delete("/{item_id}")
def delete_item(item_id: int, session: Session = Depends(get_session)) -> dict:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    group_id = item.group_id
    _delete_media_file(item)
    for model in (Summary, Transcript, StageRun, Comment):
        for row in session.exec(select(model).where(model.item_id == item_id)).all():
            session.delete(row)
    session.delete(item)
    session.commit()
    if group_id is not None:
        _refresh_group(session, group_id)
    return {"ok": True}


def _delete_media_file(item: Item) -> None:
    """Remove the item's retained audio file from disk, if present."""
    if not item.media_path:
        return
    from app.config import get_settings

    path = (get_settings().resolved_media_dir / item.media_path).resolve()
    media_root = get_settings().resolved_media_dir.resolve()
    # Guard against path traversal: only delete inside the media dir.
    if media_root in path.parents:
        path.unlink(missing_ok=True)


def _refresh_group(session: Session, group_id: int) -> None:
    """Keep a folder's item_count fresh. Empty folders are kept (the user may
    have just created one, or emptied a playlist intentionally)."""
    group = session.get(ItemGroup, group_id)
    if group is None:
        return
    remaining = list(session.exec(select(Item).where(Item.group_id == group_id)).all())
    group.item_count = len(remaining)
    session.add(group)
    session.commit()


def _get_or_404(session: Session, item_id: int) -> Item:
    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return item
