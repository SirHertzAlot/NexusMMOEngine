/**
 * The bundled emitter content: the shrine VfxEffect documents inlined
 * at build/dev time by vite (virtual:vfx-effects, from content/vfx/),
 * validated and keyed by template hash for EmitterFxLayer.
 */

import { buildEmitterRegistry } from "./emitter-fx.js";
import docs from "virtual:vfx-effects";

/** Template hash -> VfxEffect for every bundled emitter effect. */
export const EMITTER_REGISTRY = buildEmitterRegistry(
  Object.values(docs as Record<string, unknown>),
);
