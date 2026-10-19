import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, BookOpen, ExternalLink, Languages } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Input } from "@/components/ui";
import { ErrorState } from "@/components/shell";

export function PublicHome() {
  const navigate = useNavigate();
  const recent = useQuery({
    queryKey: ["home-summaries"],
    queryFn: () =>
      api.browseItems({
        status: "done",
        sort: "completed",
        order: "desc",
        limit: 8,
      }),
  });
  return (
    <div className="mx-auto max-w-5xl py-6 md:py-12">
      <section className="max-w-3xl">
        <p className="mb-5 text-lg font-semibold text-primary">
          Stream Reducer
        </p>
        <h1 className="mb-6 text-4xl font-semibold leading-tight tracking-tight md:text-6xl">
          Less watching.
          <br />
          More understanding.
        </h1>
        <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
          Turn long videos and podcasts into clear, source-linked reading. Start
          with the key ideas, go deeper with detailed notes, and return to the
          exact moment in the original.
        </p>
        <form
          role="search"
          className="mt-8"
          onSubmit={(event) => {
            event.preventDefault();
            const q = String(
              new FormData(event.currentTarget).get("q") || "",
            ).trim();
            navigate(`/browse${q ? `?${new URLSearchParams({ q })}` : ""}`);
          }}
        >
          <label
            className="mb-3 block text-sm font-medium"
            htmlFor="home-search"
          >
            Search public summaries
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              id="home-search"
              name="q"
              type="search"
              placeholder="Search videos, podcasts, ideas…"
              className="h-12 flex-1 text-base"
            />
            <Button type="submit" className="h-12 px-6">
              <Search className="h-4 w-4" />
              Search
            </Button>
          </div>
        </form>
        <p className="mt-3 text-sm text-muted-foreground">
          Search titles, headlines, descriptions and creators. No account needed
          to read public summaries.
        </p>
        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <Link className="underline underline-offset-4" to="/browse">
            Browse all summaries
          </Link>
          <Link className="underline underline-offset-4" to="/collections">
            Explore collections
          </Link>
          <Link className="underline underline-offset-4" to="/login">
            Sign in to save and follow
          </Link>
        </div>
      </section>
      <section
        aria-label="How Stream Reducer works"
        className="my-12 grid gap-8 border-y py-7 md:grid-cols-3"
      >
        {[
          {
            Icon: BookOpen,
            title: "Read at your own depth",
            text: "A quick bulletin, a concise summary, or full notes. Choose how far to go.",
          },
          {
            Icon: ExternalLink,
            title: "Keep the source in view",
            text: "Original links and timestamped references help you check claims in context.",
          },
          {
            Icon: Languages,
            title: "Cross the language barrier",
            text: "Read in English or Chinese. Explore YouTube, Bilibili, Apple Podcasts and Xiaoyuzhou.",
          },
        ].map(({ Icon, title, text }) => (
          <div key={title}>
            <Icon className="mb-3 h-5 w-5 text-primary" />
            <h2 className="mb-2 font-semibold">{title}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {text}
            </p>
          </div>
        ))}
      </section>
      <section aria-labelledby="recent-heading">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 id="recent-heading" className="text-2xl font-semibold">
            Recently summarized
          </h2>
          <Link
            to="/browse"
            className="shrink-0 text-sm underline underline-offset-4"
          >
            View all
          </Link>
        </div>
        {recent.isLoading && (
          <p role="status" className="py-6 text-muted-foreground">
            Loading recent summaries…
          </p>
        )}
        {recent.isError && (
          <ErrorState
            message="Recent summaries could not load."
            onRetry={() => recent.refetch()}
          />
        )}
        {recent.data?.map((item) => (
          <article key={item.id} className="border-b py-5">
            <p className="mb-2 text-xs text-muted-foreground">
              {item.author || item.platform}
            </p>
            <h3 className="text-lg font-semibold leading-snug">
              <Link
                className="hover:underline"
                to={`/bulletin/${item.id}?from=%2Fbrowse`}
              >
                {item.headline || item.title}
              </Link>
            </h3>
            {item.subhead && (
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {item.subhead}
              </p>
            )}
          </article>
        ))}
        {recent.data?.length === 0 && (
          <p className="py-6 text-muted-foreground">
            New summaries will appear here as they are ready.
          </p>
        )}
      </section>
      <p className="mt-10 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Summaries are generated with AI assistance and can contain errors.
        Follow the original source for full context. Sign in to build a personal
        library, follow sources, and keep highlights and notes.
      </p>
    </div>
  );
}
