/**
 * What is picked in the views that read the real project (a quest, a
 * playtest scenario): one store each, so the panel, its tree, the Details
 * dock and the URL hash all see the same pick.
 */

import { createStore } from "../store.js";

export const selectedQuest = createStore<string | null>(null);
export const selectedScenario = createStore<string | null>(null);
