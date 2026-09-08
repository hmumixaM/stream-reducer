import { Hono } from "hono";
import type { AppContext } from "../auth";
import ai4ManifestJson from "../manifests/ai4-2026.json";
import {
  importCollectionBatch,
  type CollectionManifest,
} from "../lib/collections";

export const adminCollectionRoutes = new Hono<AppContext>();

const ai4Manifest = ai4ManifestJson as CollectionManifest;

adminCollectionRoutes.post("/collections/ai4-2026/import", async (c) => {
  const offset = boundedInt(c.req.query("offset"), 0, 0, 1_000_000);
  const limit = boundedInt(c.req.query("limit"), 25, 1, 50);
  return c.json(
    await importCollectionBatch(c.env, ai4Manifest, offset, limit),
  );
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
