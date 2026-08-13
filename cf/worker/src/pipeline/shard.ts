// Feed enumeration used to share ONE container instance across every poll. A
// cron tick fans out up to `max_concurrency` polls at once, all of which piled
// onto that single instance until it dropped connections mid-request ("Container
// suddenly disconnected"), which marked healthy channels broken. Spreading the
// load over a few instances keeps each one within its concurrency budget while
// still routing a given channel to the same (warm) instance every time.
//
// Shard count is bounded by the container pool: queue max_concurrency (6) +
// FEED_SHARDS + the odd meta-* instance must stay under containers.max_instances
// (10), so three is the ceiling here.
export const FEED_SHARDS = 3;

export function feedShardKey(source_url: string, shards = FEED_SHARDS): string {
  let hash = 0;
  for (let i = 0; i < source_url.length; i++) {
    hash = (hash * 31 + source_url.charCodeAt(i)) | 0;
  }
  return `feed-${Math.abs(hash) % shards}`;
}
