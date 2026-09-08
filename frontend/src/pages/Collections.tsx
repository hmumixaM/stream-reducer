import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderKanban, Film } from "lucide-react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonGrid,
} from "@/components/shell";

export function Collections() {
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: api.listCollections,
  });

  return (
    <div>
      <PageHeader
        title="Collections"
        subtitle="Curated event libraries, organized by their original categories and tracks."
      />

      {collections.isLoading ? (
        <SkeletonGrid count={4} />
      ) : collections.isError ? (
        <ErrorState
          message={collections.error.message}
          onRetry={() => collections.refetch()}
        />
      ) : collections.data?.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {collections.data.map((collection) => (
            <Link key={collection.id} to={`/collections/${collection.slug}`}>
              <Card
                interactive
                className="group flex h-full flex-col overflow-hidden"
              >
                <div className="aspect-video overflow-hidden bg-muted">
                  {collection.cover_url || collection.thumbnail ? (
                    <img
                      src={collection.cover_url || collection.thumbnail || ""}
                      alt={`${collection.title} conference`}
                      width={640}
                      height={360}
                      decoding="async"
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <FolderKanban className="h-10 w-10" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <h2 className="text-lg font-semibold group-hover:text-primary group-hover:underline">
                    {collection.title}
                  </h2>
                  <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                    {collection.description}
                  </p>
                  <div className="mt-auto flex flex-wrap gap-3 pt-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Film className="h-3.5 w-3.5" aria-hidden="true" />
                      {collection.item_count} videos
                    </span>
                    <span>{collection.ready_count} summarized</span>
                    <span>{collection.section_count} categories</span>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No collections yet"
          description="Curated collections will appear here."
        />
      )}
    </div>
  );
}
