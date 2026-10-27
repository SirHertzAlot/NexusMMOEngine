/**
 * SAB Logging Layer — package barrel.
 *
 * The lockless ring substrate (AtomicMPSCQueue family) ships here too: the
 * logging ring is a payload ON those queues, and every process that hosts a
 * log ring needs them. They are re-exported unchanged for engine-core's
 * data plane through the same file (engine-core keeps a one-line re-export
 * of this module at src/lockless-ring.ts so its imports stay stable).
 */
export * from "./lockless-ring.js";
export * from "./logging/index.js";
