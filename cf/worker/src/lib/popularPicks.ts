// Sample creators equally, then randomize among each creator's five most-viewed
// English summaries. A prolific channel must not crowd the homepage's eight slots.
// Shared by the public API and initial HTML; unknown attribution shares one slot.
export const POPULAR_POOL_SQL = `WITH eligible AS (
  SELECT p.id,p.view_count,
    COALESCE(NULLIF(lower(trim(p.author)),''),
      (SELECT 'channel:'||min(ci.channel_id) FROM channel_item ci WHERE ci.item_id=p.id),
      'unknown') AS creator
  FROM item p JOIN summary ps ON ps.item_id=p.id
  WHERE p.status='done' AND length(trim(ps.markdown))>0 AND p.view_count>0
    AND EXISTS(SELECT 1 FROM transcript t WHERE t.item_id=p.id
      AND (lower(t.language) IN ('en','english') OR lower(replace(t.language,'_','-')) LIKE 'en-%'))
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY creator ORDER BY view_count DESC,id DESC) AS popularity_rank
  FROM eligible
), creators AS (
  SELECT creator FROM eligible GROUP BY creator ORDER BY max(view_count) DESC,creator LIMIT 100
), sampled AS (
  SELECT id,row_number() OVER(PARTITION BY creator ORDER BY RANDOM()) AS pick
  FROM ranked WHERE popularity_rank<=5 AND creator IN (SELECT creator FROM creators)
)
SELECT id FROM sampled WHERE pick=1`;
