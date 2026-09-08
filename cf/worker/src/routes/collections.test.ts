import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../auth";
import type { Env } from "../env";
import ai42025ManifestJson from "../manifests/ai4-2025.json";
import ai42026ManifestJson from "../manifests/ai4-2026.json";
import {
  flattenManifestVideos,
  importCollectionBatch,
  type CollectionManifest,
} from "../lib/collections";

vi.mock("../auth", () => ({
  resolveUser: async () => null,
}));

import { collectionRoutes } from "./collections";

describe("AI4 collection manifest", () => {
  it("preserves the 2026 source hierarchy and multi-track membership", () => {
    const manifest = ai42026ManifestJson as CollectionManifest;
    const videos = flattenManifestVideos(manifest);

    expect(manifest.sections).toHaveLength(6);
    expect(
      manifest.sections.reduce((count, section) => count + section.tracks.length, 0),
    ).toBe(76);
    expect(videos).toHaveLength(422);
    expect(videos.filter((video) => video.memberships.length > 1)).toHaveLength(28);
    expect(manifest.cover_url).toBe("/collection-covers/ai4-2026.svg");
    expect(manifest.auto_translate_langs).toEqual(["zh"]);
  });

  it("preserves all 2025 source videos and track memberships", () => {
    const manifest = ai42025ManifestJson as CollectionManifest;
    const videos = flattenManifestVideos(manifest);

    expect(manifest.sections).toHaveLength(7);
    expect(
      manifest.sections.reduce((count, section) => count + section.tracks.length, 0),
    ).toBe(64);
    expect(videos).toHaveLength(356);
    expect(videos.filter((video) => video.memberships.length > 1)).toHaveLength(35);
    expect(manifest.cover_url).toBe("/collection-covers/ai4-2025.svg");
    expect(manifest.auto_translate_langs).toEqual(["zh"]);
  });
});

describe("public collection routes", () => {
  it("lists collections without requiring a session", async () => {
    const app = new Hono<AppContext>();
    app.route("/collections", collectionRoutes);
    const { env } = queryRecordingEnv();

    const response = await app.request("/collections", undefined, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("keeps track order stable and excludes gated items", async () => {
    const app = new Hono<AppContext>();
    app.route("/collections", collectionRoutes);
    const { env, queries } = queryRecordingEnv({ id: 4 });

    const response = await app.request(
      "/collections/ai4-2026/tracks/4/items?limit=20&offset=40",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    const itemQuery = queries.find((query) =>
      query.sql.includes("FROM collection_track_item cti"),
    )!;
    expect(itemQuery.sql).toContain("i.status != 'excluded'");
    expect(itemQuery.sql).toContain("ORDER BY cti.position, i.id");
    expect(itemQuery.bindings.slice(-2)).toEqual([20, 40]);
  });
});

describe("collection import", () => {
  it("is idempotent and enqueues a video only once", async () => {
    const manifest: CollectionManifest = {
      slug: "test",
      title: "Test",
      description: "",
      source_url: "https://example.com",
      sections: [
        {
          slug: "section",
          title: "Section",
          source_url: "https://example.com/section",
          tracks: [
            {
              title: "Track",
              items: [{ youtube_id: "abc123", title: "Talk" }],
            },
          ],
        },
      ],
    };
    const { env, sends } = importEnv();

    await importCollectionBatch(env, manifest, 0, 25);
    await importCollectionBatch(env, manifest, 0, 25);

    expect(sends).toEqual([{ kind: "process", item_id: 10 }]);
  });
});

function queryRecordingEnv(firstResult: unknown = null) {
  const queries: { sql: string; bindings: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const query = { sql, bindings: [] as unknown[] };
        queries.push(query);
        const statement = {
          bind(...bindings: unknown[]) {
            query.bindings = bindings;
            return statement;
          },
          async first() {
            return firstResult;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true };
          },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, queries };
}

function importEnv() {
  let item:
    | {
        id: number;
        platform: string;
        source_url: string;
        external_id: string;
        status: string;
      }
    | undefined;
  let importEnqueuedAt: string | null | undefined;
  const sends: unknown[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let bindings: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            bindings = values;
            return statement;
          },
          async first() {
            if (sql.includes("INSERT INTO collection\n")) return { id: 1 };
            if (sql.includes("INSERT INTO collection_section")) return { id: 2 };
            if (sql.includes("INSERT INTO collection_track ")) return { id: 3 };
            if (sql.includes("platform = ? AND external_id = ?")) return item ?? null;
            if (sql.includes("SELECT * FROM item WHERE source_url = ?")) {
              return item ?? null;
            }
            if (sql.includes("SELECT import_enqueued_at")) {
              return { import_enqueued_at: importEnqueuedAt ?? null };
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO item (")) {
              item = {
                id: 10,
                platform: "youtube",
                source_url: String(bindings[0]),
                external_id: String(bindings[3]),
                status: "queued",
              };
            }
            if (sql.includes("UPDATE collection_item SET import_enqueued_at")) {
              importEnqueuedAt = String(bindings[0]);
            }
            return { success: true };
          },
        };
        return statement;
      },
    },
    PIPELINE: {
      async send(message: unknown) {
        sends.push(message);
      },
    },
  } as unknown as Env;
  return { env, sends };
}
