/**
 * SAB Logging Layer — Entry Point (docs/SAB-LOGGING-LAYER-SPEC.md §2).
 *
 * The implementation lives in the @mmo-engine/logging workspace package so
 * that every server process can host the layer (the data plane's
 * dependency rule compiles world-server before engine-core and forbids
 * importing it back). This barrel keeps engine-core's imports stable.
 */
export * from "@mmo-engine/logging/dist/src/logging/index.js";
