// Keep the homepage API and initial HTML on the same bounded, high-view pool.
export const POPULAR_POOL_SQL = `SELECT p.id FROM item p
  JOIN summary ps ON ps.item_id=p.id
  WHERE p.status='done' AND length(trim(ps.markdown))>0 AND p.view_count>0
    AND EXISTS(SELECT 1 FROM transcript t WHERE t.item_id=p.id
      AND (lower(t.language) IN ('en','english') OR lower(replace(t.language,'_','-')) LIKE 'en-%'))
  ORDER BY p.view_count DESC,p.id DESC LIMIT 100`;
