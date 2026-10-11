# EA17: Database Functions and Caches

## Design

Extends EA16 (PersistenceCore) with stored functions and materialized caches.

### Functions

```sql
-- Example: compute character power level
CREATE FUNCTION character_power(char_id INT) RETURNS INT AS $$
  SELECT attack + defense + magic FROM characters WHERE id = char_id;
$$ LANGUAGE SQL IMMUTABLE;
```

Registered in `content/db/functions/*.sql`, validated on load.

### Caches

Materialized views for expensive queries:

```sql
CREATE MATERIALIZED VIEW leaderboard AS
  SELECT name, level, xp FROM characters ORDER BY xp DESC LIMIT 100;
```

Refreshed on a schedule or on demand via the Database workspace.

### API

- `GET /api/editor/db/functions` — list
- `POST /api/editor/db/functions` — create (validated)
- `POST /api/editor/db/cache/refresh` — refresh materialized views

## Status

Implemented 2026-10-10 (branch `arlo/ea17-db-functions`): SQLite adaptation —
functions are named parameterized read-only SELECTs in `content/db/functions/*.sql`
(`:name` placeholders, validated at load, bound at run time through the
read-only query child process); caches are `_cache_<name>` snapshot tables
built from `content/db/caches/*.sql`, refreshed as DELETE + re-INSERT in one
transaction with freshness tracked in `_cache_meta`. Editor routes under
`/api/editor/database/`: `GET functions`, `POST functions`, `POST functions/run`,
`GET caches`, `POST cache/refresh`. Seeded with `character_power` (net kills
minus deaths — the real schema has no attack/defense/magic columns) and the
`leaderboard` cache. Design doc above retained for reference.
