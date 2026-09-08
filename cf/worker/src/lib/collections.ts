import type { Env } from "../env";
import { first, upsertItem, type ItemRow } from "../db";
import { normalizeUrl } from "./url";
import { isoNow } from "./crypto";

export interface CollectionManifestItem {
  youtube_id: string;
  title: string;
}

export interface CollectionManifestTrack {
  title: string;
  items: CollectionManifestItem[];
}

export interface CollectionManifestSection {
  slug: string;
  title: string;
  source_url: string;
  tracks: CollectionManifestTrack[];
}

export interface CollectionManifest {
  slug: string;
  title: string;
  description: string;
  source_url: string;
  cover_url?: string;
  auto_translate_langs?: string[];
  sections: CollectionManifestSection[];
}

interface VideoMembership {
  sectionSlug: string;
  trackTitle: string;
  position: number;
}

export interface ManifestVideo {
  youtubeId: string;
  title: string;
  position: number;
  memberships: VideoMembership[];
}

export function flattenManifestVideos(manifest: CollectionManifest): ManifestVideo[] {
  const videos = new Map<string, ManifestVideo>();
  for (const section of manifest.sections) {
    for (const track of section.tracks) {
      track.items.forEach((item, position) => {
        let video = videos.get(item.youtube_id);
        if (!video) {
          video = {
            youtubeId: item.youtube_id,
            title: item.title,
            position: videos.size,
            memberships: [],
          };
          videos.set(item.youtube_id, video);
        }
        video.memberships.push({
          sectionSlug: section.slug,
          trackTitle: track.title,
          position,
        });
      });
    }
  }
  return [...videos.values()];
}

async function upsertHierarchy(
  env: Env,
  manifest: CollectionManifest,
): Promise<{ collectionId: number; trackIds: Map<string, number> }> {
  const collection = await first<{ id: number }>(
    env.DB.prepare(
      `INSERT INTO collection
         (slug, title, description, source_url, cover_url, auto_translate_langs)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         source_url = excluded.source_url,
         cover_url = excluded.cover_url,
         auto_translate_langs = excluded.auto_translate_langs,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       RETURNING id`,
    ).bind(
      manifest.slug,
      manifest.title,
      manifest.description,
      manifest.source_url,
      manifest.cover_url ?? "",
      JSON.stringify(manifest.auto_translate_langs ?? []),
    ),
  );
  if (!collection) throw new Error("failed to upsert collection");

  const trackIds = new Map<string, number>();
  for (const [sectionPosition, section] of manifest.sections.entries()) {
    const sectionRow = await first<{ id: number }>(
      env.DB.prepare(
        `INSERT INTO collection_section (collection_id, slug, title, position)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(collection_id, slug) DO UPDATE SET
           title = excluded.title,
           position = excluded.position
         RETURNING id`,
      ).bind(collection.id, section.slug, section.title, sectionPosition),
    );
    if (!sectionRow) throw new Error(`failed to upsert section ${section.slug}`);

    for (const [trackPosition, track] of section.tracks.entries()) {
      const trackRow = await first<{ id: number }>(
        env.DB.prepare(
          `INSERT INTO collection_track (section_id, title, position)
           VALUES (?, ?, ?)
           ON CONFLICT(section_id, title) DO UPDATE SET
             position = excluded.position
           RETURNING id`,
        ).bind(sectionRow.id, track.title, trackPosition),
      );
      if (!trackRow) throw new Error(`failed to upsert track ${track.title}`);
      trackIds.set(`${section.slug}\0${track.title}`, trackRow.id);
    }
  }
  return { collectionId: collection.id, trackIds };
}

export interface CollectionImportResult {
  collection_id: number;
  imported: number;
  enqueued: number;
  offset: number;
  next_offset: number | null;
  total: number;
  done: boolean;
}

export async function importCollectionBatch(
  env: Env,
  manifest: CollectionManifest,
  offset: number,
  limit: number,
): Promise<CollectionImportResult> {
  const { collectionId, trackIds } = await upsertHierarchy(env, manifest);
  const videos = flattenManifestVideos(manifest);
  const batch = videos.slice(offset, offset + limit);
  let enqueued = 0;

  for (const video of batch) {
    const sourceUrl = normalizeUrl(
      `https://www.youtube.com/watch?v=${video.youtubeId}`,
    );
    const { item } = await upsertItem(env, {
      source_url: sourceUrl,
      platform: "youtube",
      title: video.title,
      external_id: video.youtubeId,
    });
    await env.DB.prepare(
      `UPDATE item SET
         title = COALESCE(title, ?),
         external_id = COALESCE(external_id, ?)
       WHERE id = ?`,
    ).bind(video.title || null, video.youtubeId, item.id).run();

    await env.DB.prepare(
      `INSERT INTO collection_item (collection_id, item_id, position)
       VALUES (?, ?, ?)
       ON CONFLICT(collection_id, item_id) DO UPDATE SET
         position = excluded.position`,
    ).bind(collectionId, item.id, video.position).run();

    for (const membership of video.memberships) {
      const trackId = trackIds.get(
        `${membership.sectionSlug}\0${membership.trackTitle}`,
      );
      if (trackId === undefined) {
        throw new Error(`missing track ${membership.trackTitle}`);
      }
      await env.DB.prepare(
        `INSERT INTO collection_track_item (track_id, item_id, position)
         VALUES (?, ?, ?)
         ON CONFLICT(track_id, item_id) DO UPDATE SET
           position = excluded.position`,
      ).bind(trackId, item.id, membership.position).run();
    }

    const importState = await first<{ import_enqueued_at: string | null }>(
      env.DB.prepare(
        `SELECT import_enqueued_at FROM collection_item
         WHERE collection_id = ? AND item_id = ?`,
      ).bind(collectionId, item.id),
    );
    if (!importState?.import_enqueued_at) {
      await enqueueCollectionItem(env, item);
      await env.DB.prepare(
        `UPDATE collection_item SET import_enqueued_at = ?
         WHERE collection_id = ? AND item_id = ?`,
      ).bind(isoNow(), collectionId, item.id).run();
      enqueued += item.status === "done" || item.status === "excluded" ? 0 : 1;
    }
  }

  const nextOffset = offset + batch.length;
  const done = nextOffset >= videos.length;
  return {
    collection_id: collectionId,
    imported: batch.length,
    enqueued,
    offset,
    next_offset: done ? null : nextOffset,
    total: videos.length,
    done,
  };
}

async function enqueueCollectionItem(env: Env, item: ItemRow): Promise<void> {
  if (item.status === "done" || item.status === "excluded") return;
  if (item.status === "error") {
    await env.DB.prepare(
      "UPDATE item SET status = 'queued', error = NULL WHERE id = ?",
    ).bind(item.id).run();
  }
  if (item.status === "queued" || item.status === "error") {
    await env.PIPELINE.send({ kind: "process", item_id: item.id });
  }
}
