import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Search as SearchIcon } from "lucide-react";
import { api, type SearchHit } from "@/lib/api";
import { Badge, Button, Card, Input, Select, Spinner } from "@/components/ui";
import { PlatformBadge } from "@/components/badges";

function fmtTimestamp(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return "";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function HitCard({ hit }: { hit: SearchHit }) {
  const itemHref = `/items/${hit.item_id}`;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <PlatformBadge platform={hit.platform} />
        <Badge className="bg-accent text-accent-foreground">{hit.source}</Badge>
        {hit.field && hit.field !== hit.source && (
          <Badge className="bg-accent/60 text-accent-foreground">{hit.field}</Badge>
        )}
        <span className="ml-auto font-mono">score {hit.score.toFixed(3)}</span>
      </div>
      <Link to={itemHref} className="font-medium hover:underline">
        {hit.title || hit.source_url}
      </Link>
      <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">{hit.text}</p>
      <div className="mt-3 flex items-center gap-3 text-xs">
        {hit.start_s !== null && hit.start_s !== undefined && (
          <span className="font-mono text-muted-foreground">{fmtTimestamp(hit.start_s)}</span>
        )}
        {hit.deep_link && (
          <a
            href={hit.deep_link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> Jump to source
          </a>
        )}
        <Link to={itemHref} className="ml-auto text-muted-foreground hover:underline">
          Open item →
        </Link>
      </div>
    </Card>
  );
}

export function Search() {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const search = useMutation({
    mutationFn: (q: string) => api.search({ q, k: 20, source: source || undefined }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (q) search.mutate(q);
  };

  const hits = search.data ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="text-sm text-muted-foreground">
          Semantic search across every transcript and summary. Finds passages by
          meaning, not keywords, and links back to the exact moment in the source.
        </p>
      </div>

      <form onSubmit={submit} className="mb-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Input
          autoFocus
          placeholder="e.g. what did they say about interest rates?"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-full sm:w-40">
          <option value="">All content</option>
          <option value="transcript">Transcript</option>
          <option value="summary">Summary</option>
        </Select>
        <Button type="submit" disabled={search.isPending || !text.trim()} className="w-full sm:w-auto">
          {search.isPending ? <Spinner /> : <SearchIcon className="h-4 w-4" />}
          Search
        </Button>
      </form>

      {search.isError && (
        <Card className="p-6 text-center text-sm text-red-400">
          {String(search.error)}
        </Card>
      )}

      {search.isSuccess && hits.length === 0 && (
        <Card className="p-10 text-center text-muted-foreground">
          No matches. Try a different phrasing, or run the embedding backfill if you
          have older content.
        </Card>
      )}

      <div className="space-y-3">
        {hits.map((hit) => (
          <HitCard key={hit.chunk_id} hit={hit} />
        ))}
      </div>
    </div>
  );
}
