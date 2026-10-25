/**
 * Authoring model layer — the pure core of the view-centered editor.
 *
 * facts → relevance (which widgets) + add shelf (what could be added)
 *       → widget view-models (anatomy + verb-call CRUD)
 * hierarchy (containment + references, role filters, saved views)
 * verbs (the 13 canonical verbs + the mandatory 5W1H envelope + history)
 *
 * No React, no stores, no I/O: the UI (ui/authoring-view.tsx) is a thin
 * renderer over these modules, and every rule here is unit-tested.
 */
export * from "./facts.js";
export * from "./relevance.js";
export * from "./verbs.js";
export * from "./add-shelf.js";
export * from "./hierarchy.js";
export * from "./widgets.js";
export * from "./templates.js";
export * from "./dispatch.js";
