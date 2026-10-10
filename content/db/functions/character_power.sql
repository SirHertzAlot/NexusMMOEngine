-- db: characters
-- description: Net combat score (recorded kills minus recorded deaths) for one character.
SELECT
  (SELECT COUNT(*) FROM deaths WHERE killer = :character_id)
  - (SELECT COUNT(*) FROM deaths WHERE character_id = :character_id)
  AS power;
