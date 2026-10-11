-- The host backfill in 202610100001 runs before the suggested groups are seeded,
-- so ON CONFLICT DO NOTHING left the country code unset for suggested regions
-- that already existed as real hosts (for example E2 / 圣何塞). Fill them on
-- every deployment, including fresh installs that already had hosts.
UPDATE host_region_groups r
SET country_code = v.country_code
FROM (VALUES
  ('凤凰城', 'us'),
  ('圣何塞', 'us'),
  ('伦敦', 'gb'),
  ('首尔', 'kr')
) AS v(name, country_code)
WHERE r.name = v.name AND r.country_code IS NULL;
