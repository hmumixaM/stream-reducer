import { Hono } from "hono";
import type { AppContext } from "../auth";
import { resolveUser } from "../auth";
import { all, first, type ItemRow } from "../db";
import { toItemRead } from "../lib/serialize";

export const collectionRoutes = new Hono<AppContext>();

interface CollectionReadRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  source_url: string;
  item_count: number;
  ready_count: number;
  section_count: number;
  thumbnail: string | null;
}

interface SectionRow {
  id: number;
  slug: string;
  title: string;
  position: number;
  item_count: number;
}

interface TrackRow {
  id: number;
  section_id: number;
  title: string;
  position: number;
  item_count: number;
  ready_count: number;
}

const COLLECTION_SELECT = `
  SELECT c.id, c.slug, c.title, c.description, c.source_url,
         (SELECT COUNT(*)
            FROM collection_item ci
            JOIN item i ON i.id = ci.item_id
           WHERE ci.collection_id = c.id AND i.status != 'excluded') AS item_count,
         (SELECT COUNT(*)
            FROM collection_item ci
            JOIN item i ON i.id = ci.item_id
           WHERE ci.collection_id = c.id AND i.status = 'done') AS ready_count,
         (SELECT COUNT(*) FROM collection_section cs
           WHERE cs.collection_id = c.id) AS section_count,
         (SELECT i.thumbnail
            FROM collection_item ci
            JOIN item i ON i.id = ci.item_id
           WHERE ci.collection_id = c.id
             AND i.status != 'excluded'
             AND i.thumbnail IS NOT NULL
           ORDER BY ci.position
           LIMIT 1) AS thumbnail
    FROM collection c`;

collectionRoutes.get("/", async (c) => {
  const rows = await all<CollectionReadRow>(
    c.env.DB.prepare(
      `${COLLECTION_SELECT}
       WHERE c.is_public = 1
       ORDER BY c.created_at DESC, c.id DESC`,
    ),
  );
  return c.json(rows);
});

collectionRoutes.get("/:slug/tracks/:trackId/items", async (c) => {
  const slug = c.req.param("slug");
  const trackId = Number(c.req.param("trackId"));
  if (!Number.isInteger(trackId) || trackId <= 0) {
    return c.json({ error: "track not found" }, 404);
  }
  const track = await first<{ id: number }>(
    c.env.DB.prepare(
      `SELECT ct.id
         FROM collection_track ct
         JOIN collection_section cs ON cs.id = ct.section_id
         JOIN collection c ON c.id = cs.collection_id
        WHERE c.slug = ? AND c.is_public = 1 AND ct.id = ?`,
    ).bind(slug, trackId),
  );
  if (!track) return c.json({ error: "track not found" }, 404);

  const user = await resolveUser(c.env, c);
  const userId = user?.id ?? -1;
  const limit = boundedInt(c.req.query("limit"), 60, 1, 100);
  const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
  const rows = await all<
    ItemRow & {
      _ui_id: number | null;
      ui_folder_id: number | null;
      ui_is_favorite: number | null;
      ui_is_archived: number | null;
      ui_status: string | null;
      _interest_id: number | null;
    }
  >(
    c.env.DB.prepare(
      `SELECT i.*, ui.id AS _ui_id, ui.folder_id AS ui_folder_id,
              ui.is_favorite AS ui_is_favorite,
              ui.is_archived AS ui_is_archived,
              ui.personal_status AS ui_status,
              ii.id AS _interest_id
         FROM collection_track_item cti
         JOIN item i ON i.id = cti.item_id
         LEFT JOIN user_item ui ON ui.item_id = i.id AND ui.user_id = ?
         LEFT JOIN item_interest ii ON ii.item_id = i.id AND ii.user_id = ?
        WHERE cti.track_id = ? AND i.status != 'excluded'
        ORDER BY cti.position, i.id
        LIMIT ? OFFSET ?`,
    ).bind(userId, userId, trackId, limit, offset),
  );
  return c.json(
    rows.map((row) =>
      toItemRead(
        row,
        row._ui_id == null
          ? null
          : {
              folder_id: row.ui_folder_id,
              group_position: null,
              is_favorite: row.ui_is_favorite ?? 0,
              is_archived: row.ui_is_archived ?? 0,
              personal_status: row.ui_status ?? "waiting",
              subscription_id: null,
            },
        { is_interested: row._interest_id != null },
      ),
    ),
  );
});

collectionRoutes.get("/:slug", async (c) => {
  const collection = await first<CollectionReadRow>(
    c.env.DB.prepare(
      `${COLLECTION_SELECT}
       WHERE c.slug = ? AND c.is_public = 1`,
    ).bind(c.req.param("slug")),
  );
  if (!collection) return c.json({ error: "collection not found" }, 404);

  const sections = await all<SectionRow>(
    c.env.DB.prepare(
      `SELECT cs.id, cs.slug, cs.title, cs.position,
              COUNT(DISTINCT CASE WHEN i.status != 'excluded' THEN i.id END) AS item_count
         FROM collection_section cs
         LEFT JOIN collection_track ct ON ct.section_id = cs.id
         LEFT JOIN collection_track_item cti ON cti.track_id = ct.id
         LEFT JOIN item i ON i.id = cti.item_id
        WHERE cs.collection_id = ?
        GROUP BY cs.id
        ORDER BY cs.position, cs.id`,
    ).bind(collection.id),
  );
  const tracks = await all<TrackRow>(
    c.env.DB.prepare(
      `SELECT ct.id, ct.section_id, ct.title, ct.position,
              COUNT(CASE WHEN i.status != 'excluded' THEN 1 END) AS item_count,
              COUNT(CASE WHEN i.status = 'done' THEN 1 END) AS ready_count
         FROM collection_track ct
         JOIN collection_section cs ON cs.id = ct.section_id
         LEFT JOIN collection_track_item cti ON cti.track_id = ct.id
         LEFT JOIN item i ON i.id = cti.item_id
        WHERE cs.collection_id = ?
        GROUP BY ct.id
        ORDER BY ct.section_id, ct.position, ct.id`,
    ).bind(collection.id),
  );
  const tracksBySection = new Map<number, TrackRow[]>();
  for (const track of tracks) {
    const rows = tracksBySection.get(track.section_id) ?? [];
    rows.push(track);
    tracksBySection.set(track.section_id, rows);
  }
  return c.json({
    ...collection,
    sections: sections.map((section) => ({
      ...section,
      tracks: tracksBySection.get(section.id) ?? [],
    })),
  });
});

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
