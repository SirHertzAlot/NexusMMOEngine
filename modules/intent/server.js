/**
 * Intent module server entry (complete-modularity slice 9).
 *
 * Exports createSystems(ctx) per the module contract. The IntentSystem
 * translates player input into sim actions with per-session budgets.
 * No configuration needed — it's a pure tick system.
 */
import { IntentSystem } from "../../packages/engine-core/dist/src/index.js";

export function createSystems(ctx) {
  const intent = new IntentSystem();
  return { intent };
}
