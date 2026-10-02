import { Hono } from "hono";
import type { AppContext } from "../auth";
import { requireAuth } from "../auth";
import { all, first } from "../db";
import { isoNow, randomToken } from "../lib/crypto";

export const feedbackRoutes = new Hono<AppContext>();
export const feedbackAdminRoutes = new Hono<AppContext>();

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BODY = 4000;
const KINDS = new Set(["bug", "suggestion"]);
const IMAGE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface Upload {
  size: number;
  type: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

interface FeedbackRow {
  id: number;
  email: string;
  kind: "bug" | "suggestion";
  body: string;
  page_url: string | null;
  created_at: string;
}

interface FeedbackImageRow {
  id: number;
  feedback_id: number;
  image_key: string;
  mime_type: string;
}

feedbackRoutes.post("/", requireAuth, async (c) => {
  const form = await c.req.formData();
  const kind = String(form.get("kind") || "");
  const body = String(form.get("body") || "").trim();
  const pageUrl = String(form.get("page_url") || "").trim().slice(0, 500);
  if (!KINDS.has(kind)) return c.json({ error: "invalid kind" }, 400);
  if (!body || body.length > MAX_BODY) return c.json({ error: "invalid body" }, 400);

  const images = (form.getAll("images") as unknown as Upload[]).filter((value) => value?.size > 0);
  if (images.length > MAX_IMAGES) return c.json({ error: "too many images" }, 400);
  for (const image of images) {
    if (image.size > MAX_IMAGE_BYTES || !IMAGE_EXTENSION[image.type]) return c.json({ error: "invalid image" }, 400);
  }

  const user = c.get("user");
  const inserted = await c.env.DB.prepare(
    `INSERT INTO feedback (user_id, email, kind, body, page_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(user.id, user.email, kind, body, pageUrl || null, isoNow()).run();
  const feedbackId = inserted.meta.last_row_id;

  for (const image of images) {
    const key = `feedback/${feedbackId}/${randomToken()}.${IMAGE_EXTENSION[image.type]}`;
    await c.env.MEDIA.put(key, await image.arrayBuffer(), { httpMetadata: { contentType: image.type } });
    await c.env.DB.prepare(
      `INSERT INTO feedback_image (feedback_id, image_key, mime_type) VALUES (?, ?, ?)`,
    ).bind(feedbackId, key, image.type).run();
  }

  return c.json({ id: feedbackId, email: user.email });
});

feedbackAdminRoutes.get("/feedback", async (c) => {
  const rows = await all<FeedbackRow>(c.env.DB.prepare(
    `SELECT id, email, kind, body, page_url, created_at FROM feedback ORDER BY created_at DESC LIMIT 50`,
  ));
  const images = rows.length
    ? await all<Pick<FeedbackImageRow, "id" | "feedback_id">>(c.env.DB.prepare(
      `SELECT id, feedback_id FROM feedback_image WHERE feedback_id IN (${rows.map(() => "?").join(",")})`,
    ).bind(...rows.map((row) => row.id)))
    : [];
  const imageIds = new Map<number, number[]>();
  for (const image of images) {
    const list = imageIds.get(image.feedback_id) ?? [];
    list.push(image.id);
    imageIds.set(image.feedback_id, list);
  }
  return c.json(rows.map((row) => ({ ...row, image_ids: imageIds.get(row.id) ?? [] })));
});

feedbackAdminRoutes.get("/feedback/:id/images/:imageId", async (c) => {
  const row = await first<Pick<FeedbackImageRow, "image_key" | "mime_type">>(c.env.DB.prepare(
    `SELECT image_key, mime_type FROM feedback_image WHERE id = ? AND feedback_id = ?`,
  ).bind(c.req.param("imageId"), c.req.param("id")));
  if (!row) return c.json({ error: "not found" }, 404);
  const object = await c.env.MEDIA.get(row.image_key);
  if (!object) return c.json({ error: "not found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", row.mime_type);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
});
