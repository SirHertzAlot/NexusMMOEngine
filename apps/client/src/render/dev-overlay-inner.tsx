/**
 * Inner Leva dev overlay (lazy-loaded, DEV only).
 */
import { useControls } from "leva";

export function DevOverlay() {
  // Quality controls
  const quality = useControls("Quality", {
    tier: { value: "medium", options: ["low", "medium", "high", "ultra"] },
    particleMultiplier: { value: 1, min: 0.1, max: 2, step: 0.1 },
  });

  // Post-processing controls
  const post = useControls("Post", {
    bloom: false,
    vignette: true,
  });

  // Key light controls
  const keyLight = useControls("Key Light", {
    color: "#ffffff",
    intensity: { value: 1, min: 0, max: 3, step: 0.1 },
    position: { value: [5, 10, 5] as [number, number, number], step: 1 },
  });

  // Expose to window for debugging (DEV only)
  if (typeof window !== "undefined") {
    (window as any).__DEV_CONTROLS__ = { quality, post, keyLight };
  }

  return null;
}
