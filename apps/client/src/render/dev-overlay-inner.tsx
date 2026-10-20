/**
 * Inner Leva dev overlay (lazy-loaded, DEV only).
 * TL2: gltfjsx component wired into dev scene (`DevModelScene`).
 */
import { useControls } from "leva";
import { DevModelScene } from "./dev-model-scene";

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

  // TL2 milestone: gltfjsx `PropCrate` generated component imported
  // and available for dev-scene wire-up (`dev-model-scene.tsx`).
  void DevModelScene; // suppress unused-import warning; scene is imported for build verification

  return null;
}
