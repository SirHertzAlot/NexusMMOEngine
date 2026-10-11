/**
 * Leva dev overlay (TL3).
 *
 * DEV-only live tweak panel for the R3F client. Three seeded control groups:
 * - Quality: tier selection, particle multiplier
 * - Post: bloom, vignette toggles
 * - Key light: color, intensity, position
 *
 * DEV-gated via React.lazy: in production, the import is never triggered
 * and bundlers tree-shake leva entirely from the prod bundle.
 */
import { lazy, Suspense } from "react";

const DevOverlayInner = lazy(() =>
  import("./dev-overlay-inner.js").then((m) => ({ default: m.DevOverlay }))
);

/**
 * Render the dev overlay only in development.
 * In production, returns null without importing leva.
 */
export function MaybeDevOverlay() {
  // @ts-expect-error - import.meta.env is vite-specific
  if (!import.meta.env.DEV) return null;
  return (
    <Suspense fallback={null}>
      <DevOverlayInner />
    </Suspense>
  );
}
