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

Design complete. Builds on EA16's PersistenceCore.
