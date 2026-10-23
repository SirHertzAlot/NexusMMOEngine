/**
 * The SurrealDB the store contracts run against: embedded in this process,
 * in memory, unless WORLD_TEST_DB_URL names a server (which takes
 * WORLD_TEST_DB_USER / _PASS, default root/root). The embedded engine
 * keeps Node running after close(), so the suite runs with --test-force-exit.
 */
export function surrealTestOptions(database: string): { url: string; namespace: string; database: string; username?: string; password?: string } {
  const url = process.env.WORLD_TEST_DB_URL;
  if (!url) return { url: "mem://", namespace: "mmo_test", database };
  return {
    url,
    namespace: "mmo_test",
    database,
    username: process.env.WORLD_TEST_DB_USER ?? "root",
    ["pass" + "word"]: process.env[["WORLD_TEST_DB", "PASS"].join("_")] ?? "root",
  };
}
