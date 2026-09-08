import { Hono } from "hono";
import type { AppContext } from "../auth";
import ai4ManifestJson from "../manifests/ai4-2026.json";
import { all, first } from "../db";
import {
  flattenManifestVideos,
  importCollectionBatch,
  type CollectionManifest,
} from "../lib/collections";
import { includeSummaryDescription } from "../lib/summaryDescription";

export const adminCollectionRoutes = new Hono<AppContext>();

const ai4Manifest = ai4ManifestJson as CollectionManifest;

adminCollectionRoutes.post("/collections/ai4-2026/import", async (c) => {
  const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
  const limit = boundedInt(c.req.query("limit"), 25, 1, 50);
  return c.json(
    await importCollectionBatch(c.env, ai4Manifest, offset, limit),
  );
});

adminCollectionRoutes.post(
  "/collections/ai4-2026/backfill-descriptions",
  async (c) => {
    const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
    const limit = boundedInt(c.req.query("limit"), 50, 1, 100);
    const collection = await first<{ id: number }>(
      c.env.DB.prepare("SELECT id FROM collection WHERE slug = ?").bind(
        ai4Manifest.slug,
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
    const total = flattenManifestVideos(ai4Manifest).length;
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
