-- db: characters
-- description: Top 100 characters by net combat score (kills minus deaths).
SELECT
  c.id,
  c.name,
  COALESCE(k.kills, 0) AS kills,
  COALESCE(d.deaths, 0) AS deaths,
  COALESCE(k.kills, 0) - COALESCE(d.deaths, 0) AS power
FROM characters c
LEFT JOIN (SELECT killer AS id, COUNT(*) AS kills FROM deaths WHERE killer IS NOT NULL GROUP BY killer) k ON k.id = c.id
LEFT JOIN (SELECT character_id AS id, COUNT(*) AS deaths FROM deaths GROUP BY character_id) d ON d.id = c.id
ORDER BY power DESC, c.name ASC
LIMIT 100;
