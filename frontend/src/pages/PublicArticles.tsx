import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { updateMetadata } from "@/lib/seo";
export function PublicArticles() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const offset = Math.max(0, Math.floor(Number(params.get("offset")) || 0));
  const page = Math.floor(offset / 24);
  const articles = useQuery({
    queryKey: ["public-articles", q, page],
    queryFn: async () => {
      const r = await fetch(
        `/api/public/articles?q=${encodeURIComponent(q)}&page=${page}`,
      );
      if (!r.ok) throw new Error("Could not load articles");
      return r.json() as Promise<{
        articles: {
          id: number;
          title: string;
          author: string | null;
          published_at: string | null;
        }[];
        has_more: boolean;
      }>;
    },
  });
  useEffect(
    () =>
      updateMetadata(
        "RSS & Substack Article Summaries | Stream Reducer",
        "Explore source-linked article summaries and saved originals without an account.",
        `https://reducer.xgoose.org/articles${offset ? `?offset=${offset}` : ""}`,
        !q,
      ),
    [q, offset],
  );
  return (
    <main className="mx-auto max-w-4xl py-8">
      <h1 className="text-3xl font-semibold">RSS &amp; Substack articles</h1>
      <p className="my-4 text-muted-foreground">
        Read bulletins, summaries and original articles. No account required.
      </p>
      <form
        role="search"
        className="my-6 flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({
            q: String(new FormData(e.currentTarget).get("q") || ""),
          });
        }}
      >
        <label className="sr-only" htmlFor="article-search">
          Search articles
        </label>
        <input
          id="article-search"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search titles and authors"
          className="min-w-0 flex-1 rounded border bg-background p-3"
        />
        <button className="rounded bg-primary px-5 text-primary-foreground">
          Search
        </button>
      </form>
      {articles.isLoading && <p>Loading articles…</p>}
      {articles.error && <p role="alert">{articles.error.message}</p>}
      {articles.data?.articles.map((a) => (
        <article className="border-b py-5" key={a.id}>
          <h2 className="text-xl font-semibold">
            <Link to={`/rss/articles/${a.id}`}>{a.title}</Link>
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {a.author}
            {a.published_at ? ` · ${a.published_at.slice(0, 10)}` : ""}
          </p>
        </article>
      ))}
      {articles.data && !articles.data.articles.length && (
        <p>No articles found.</p>
      )}
      <nav className="my-6 flex gap-6">
        {offset > 0 && (
          <Link
            to={`/articles?offset=${Math.max(0, offset - 24)}&q=${encodeURIComponent(q)}`}
          >
            Previous
          </Link>
        )}
        {articles.data?.has_more && (
          <Link
            to={`/articles?offset=${offset + 24}&q=${encodeURIComponent(q)}`}
          >
            More articles
          </Link>
        )}
      </nav>
    </main>
  );
}
