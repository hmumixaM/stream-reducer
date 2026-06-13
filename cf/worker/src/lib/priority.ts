// Processing-priority score for an item, combining the three demand signals
// from the plan:
//   1. view_count          (popularity of the source video)
//   2. subscriber_demand   (# users subscribed to the feed/channel it came from)
//   3. request_count       (# users who added it to their library / want it)
//
// The queue consumer / container always drains the highest-scoring `waiting`
// item first.
const W_VIEWS = 1.0;
const W_SUBSCRIBERS = 3.0;
const W_REQUESTS = 5.0;

export function priorityScore(opts: {
  view_count?: number | null;
  subscriber_demand?: number | null;
  request_count?: number | null;
}): number {
  const views = Math.max(0, opts.view_count ?? 0);
  const subs = Math.max(0, opts.subscriber_demand ?? 0);
  const reqs = Math.max(0, opts.request_count ?? 0);
  return (
    W_VIEWS * Math.log10(views + 1) +
    W_SUBSCRIBERS * subs +
    W_REQUESTS * reqs
  );
}
