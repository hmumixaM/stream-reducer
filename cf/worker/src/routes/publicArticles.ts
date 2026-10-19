import { Hono } from "hono";
import type { AppContext } from "../auth";
import {
  publicArticle,
  publicArticleBody,
  publicArticleList,
} from "../lib/publicArticles";
export const publicArticlesRoutes = new Hono<AppContext>();
publicArticlesRoutes.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 200);
  const page = Math.max(
    0,
    Math.min(100000, Math.floor(Number(c.req.query("page")) || 0)),
  );
  const rows = await publicArticleList(c.env, q, page * 24, 25);
  return c.json({
    articles: rows.results.slice(0, 24),
    has_more: rows.results.length > 24,
    page,
  });
});
publicArticlesRoutes.get("/:id", async (c) => {
  const result = await publicArticle(c.env, Number(c.req.param("id")));
  if (!result) return c.json({ error: "Article unavailable" }, 404);
  const { body_key: _key, body_hash: _hash, ...article } = result.article;
  return c.json({
    ...article,
    status: "done",
    editions: result.editions,
    read: { read_at: null, saved: 0 },
    sources: [],
  });
});
publicArticlesRoutes.get("/:id/body", async (c) => {
  const result = await publicArticle(c.env, Number(c.req.param("id")));
  const body = result ? await publicArticleBody(c.env, result.article) : null;
  return body
    ? c.json(body)
    : c.json({ error: "Article body unavailable" }, 404);
});
