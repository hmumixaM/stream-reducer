// Shared classifier for Cloudflare Containers infra blips.
//
// A 503 from the container DO means no free instance right now (all slots busy /
// still provisioning) — transient, not a real failure. The
// blockConcurrencyWhile/DO-reset case is the same class: a cold container that
// took too long to provision (image pull/boot > the DO startup window, common
// right after a deploy or CONTAINER_GEN bump) gets reset — retrying once it's
// warm succeeds, so treat it as transient too.
//
// Lives in its own module because three callers need the same judgement: the
// queue consumer (re-queue the item without burning a retry), the aux container
// calls (retry in place), and subscription polling (defer instead of marking the
// subscription broken).
export function isTransientCapacity(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("container 503") ||
    m.includes("no container instance available") ||
    m.includes("currently provisioning") ||
    // The whole container pool is momentarily full (jobs + aux instances >
    // max_instances). The error literally says "Try again later" — re-queue.
    m.includes("maximum number of running container instances") ||
    m.includes("blockconcurrencywhile") ||
    m.includes("durable object was reset") ||
    m.includes("durable object reset because its code was updated") ||
    m.includes("container port connection closed unexpectedly") ||
    m.includes("error proxying request to container")
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
