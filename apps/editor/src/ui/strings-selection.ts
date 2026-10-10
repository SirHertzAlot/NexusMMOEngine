/** The Strings panel's picked string id, shared with the deep-selection keys (`string:<id>`, see previews.tsx). */
import { createStore } from "../store.js";

export const stringsStore = createStore<{ row: string | null }>({ row: null });
