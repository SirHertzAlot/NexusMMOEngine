/**
 * The Database workspace's selected table, shared by the left schema tree
 * and the Data grid so picking a table in either opens it in the grid.
 */

import { createStore } from "../store.js";

export interface DbSelection {
  db: string;
  table: string;
}

const store = createStore<DbSelection | null>(null, (a, b) => a?.db === b?.db && a?.table === b?.table);

export const getDbSelection = store.get;
export const setDbSelection = store.set;
export const subscribeDbSelection = store.subscribe;
