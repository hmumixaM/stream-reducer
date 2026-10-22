import { useEffect, useState } from "react";
import { ReaderLink as Link } from "@/components/Reader";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { updateMetadata } from "@/lib/seo";
import { PageHeader, EmptyState, ErrorState, LoadingState } from "@/components/shell";
import { Button, Input } from "@/components/ui";
import { dateLabel } from "@/lib/bulletin";

export function PublicArticles() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
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
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Articles" subtitle="Read summaries and originals from RSS and Substack. No account required." />
      <nav aria-label="Browse content" className="mb-5 flex gap-2"><Link to="/browse" className="reader-control">Videos & podcasts</Link><Link to="/articles" aria-current="page" className="reader-control bg-accent font-medium">Articles</Link></nav>
      <form
        role="search"
        className="my-6 flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({
            q: search.trim(),
          });
        }}
      >
        <label className="sr-only" htmlFor="article-search">
          Search articles
        </label>
        <Input
          id="article-search"
          name="q"
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search titles and authors"
          className="min-h-11 min-w-0 flex-1"
        />
        <Button className="min-h-11">
          Search
        </Button>
      </form>
      {articles.isLoading && <LoadingState label="Loading articles…" />}
      {articles.error && <ErrorState message={articles.error.message} onRetry={() => articles.refetch()} />}
      {articles.data?.articles.map((a) => (
        <article className="border-b py-5" key={a.id}>
          <h2 className="text-lg font-semibold leading-snug">
            <Link className="hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to={`/rss/articles/${a.id}`}>{a.title}</Link>
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {a.author}
            {a.published_at ? ` · ${dateLabel(a.published_at, false)}` : ""}
          </p>
        </article>
      ))}
      {articles.data && !articles.data.articles.length && (
        <EmptyState title="No articles found" description="Try another title or author." />
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
    </div>
  );
}
