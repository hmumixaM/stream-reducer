import { Hono } from "hono";
import type { AppContext } from "../auth";
import ai42025ManifestJson from "../manifests/ai4-2025.json";
import ai42026ManifestJson from "../manifests/ai4-2026.json";
import { all, first } from "../db";
import {
  flattenManifestVideos,
  importCollectionBatch,
  type CollectionManifest,
} from "../lib/collections";
import { enqueueTranslationLanguages } from "../lib/autoTranslate";
import { includeSummaryDescription } from "../lib/summaryDescription";

export const adminCollectionRoutes = new Hono<AppContext>();

const manifests = new Map(
  [ai42025ManifestJson, ai42026ManifestJson].map((value) => {
    const manifest = value as CollectionManifest;
    return [manifest.slug, manifest] as const;
  }),
);

adminCollectionRoutes.post("/collections/:slug/import", async (c) => {
  const manifest = manifests.get(c.req.param("slug"));
  if (!manifest) return c.json({ error: "collection manifest not found" }, 404);
  const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
  const limit = boundedInt(c.req.query("limit"), 25, 1, 50);
  return c.json(
    await importCollectionBatch(c.env, manifest, offset, limit),
  );
});

adminCollectionRoutes.post(
  "/collections/:slug/backfill-descriptions",
  async (c) => {
    const manifest = manifests.get(c.req.param("slug"));
    if (!manifest) return c.json({ error: "collection manifest not found" }, 404);
    const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
    const limit = boundedInt(c.req.query("limit"), 50, 1, 100);
    const collection = await first<{ id: number }>(
      c.env.DB.prepare("SELECT id FROM collection WHERE slug = ?").bind(
        manifest.slug,
      ),
    );
    if (!collection) return c.json({ error: "collection not found" }, 404);
    const rows = await all<{
      description: string | null;
      item_id: number;
      markdown: string | null;
      source_url: string;
      structured: string | null;
    }>(
      c.env.DB.prepare(
        `SELECT i.id AS item_id, i.description, i.source_url,
                s.markdown, s.structured
           FROM collection_item ci
           JOIN item i ON i.id = ci.item_id
           LEFT JOIN summary s ON s.item_id = i.id
          WHERE ci.collection_id = ?
          ORDER BY ci.position
          LIMIT ? OFFSET ?`,
      ).bind(collection.id, limit, offset),
    );
    let patched = 0;
    for (const row of rows) {
      if (row.markdown == null || row.structured == null) continue;
      const originalStructured = JSON.parse(row.structured) as Record<string, unknown>;
      const content = includeSummaryDescription(
        row.markdown,
        originalStructured,
        row.description,
        row.source_url,
      );
      if (
        content.markdown === row.markdown &&
        content.structured.description === originalStructured.description
      ) {
        continue;
      }
      await c.env.DB.prepare(
        "UPDATE summary SET markdown = ?, structured = ? WHERE item_id = ?",
      ).bind(
        content.markdown,
        JSON.stringify(content.structured),
        row.item_id,
      ).run();
      patched += 1;
    }
    const total = flattenManifestVideos(manifest).length;
    const nextOffset = offset + rows.length;
    const done = nextOffset >= total;
    return c.json({
      scanned: rows.length,
      patched,
      offset,
      next_offset: done ? null : nextOffset,
      total,
      done,
    });
  },
);

adminCollectionRoutes.post(
  "/collections/:slug/translations/:lang/backfill",
  async (c) => {
    const manifest = manifests.get(c.req.param("slug"));
    if (!manifest) return c.json({ error: "collection manifest not found" }, 404);
    const language = c.req.param("lang");
    if (!(manifest.auto_translate_langs ?? []).includes(language)) {
      return c.json({ error: "language is not enabled for this collection" }, 400);
    }
    const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
    const limit = boundedInt(c.req.query("limit"), 50, 1, 100);
    const collection = await first<{ id: number }>(
      c.env.DB.prepare("SELECT id FROM collection WHERE slug = ?").bind(
        manifest.slug,
      ),
    );
    if (!collection) return c.json({ error: "collection not found" }, 404);
    const rows = await all<{
      item_id: number;
      status: string;
      summary_id: number | null;
      transcript_id: number | null;
    }>(
      c.env.DB.prepare(
        `SELECT i.id AS item_id, i.status,
                s.id AS summary_id, t.id AS transcript_id
           FROM collection_item ci
           JOIN item i ON i.id = ci.item_id
           LEFT JOIN summary s ON s.item_id = i.id
           LEFT JOIN transcript t ON t.item_id = i.id
          WHERE ci.collection_id = ?
          ORDER BY ci.position
          LIMIT ? OFFSET ?`,
      ).bind(collection.id, limit, offset),
    );
    let eligible = 0;
    let enqueued = 0;
    for (const row of rows) {
      if (
        row.status !== "done" ||
        row.summary_id == null ||
        row.transcript_id == null
      ) {
        continue;
      }
      eligible += 1;
      enqueued += (
        await enqueueTranslationLanguages(c.env, row.item_id, [language])
      ).length;
    }
    const total = flattenManifestVideos(manifest).length;
    const nextOffset = offset + rows.length;
    const done = nextOffset >= total;
    return c.json({
      scanned: rows.length,
      eligible,
      enqueued,
      offset,
      next_offset: done ? null : nextOffset,
      total,
      done,
    });
  },
);

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
