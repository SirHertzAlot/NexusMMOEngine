/**
 * PostFx — the screen effects over the mirror world (pmndrs
 * postprocessing through @react-three/postprocessing).
 *
 * - Antialiasing: the composer's multisampling (the canvas's own MSAA no
 *   longer reaches the screen once a composer renders the scene).
 * - Bloom: only light above the threshold glows (the FX orbs and beams,
 *   emissive lava), not the sky or sunlit ground.
 * - Underwater: tint, murk by distance, and wobble, faded in by
 *   `screen.underwater` (WorldCanvas writes it every frame).
 * - Tone mapping: the Gran Turismo curve (see GTToneMapEffect). The
 *   composer turns the renderer's own tone mapping off, so without it
 *   bright light clips at white.
 * - A light vignette.
 *
 * `enabled={false}` renders the scene straight to the screen, as before
 * the composer existed (for weak GPUs).
 */

import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo } from "react";
import { UnderwaterEffect } from "./effects/underwater-effect.js";
import { GTToneMapEffect } from "./effects/gt-tonemap-effect.js";

/** Per-frame screen state the world writes and the effects read (no React state). */
export interface ScreenState {
  /** 0 above water .. 1 fully under (see underwaterAmount). */
  underwater: number;
}

export interface PostFxProps {
  enabled: boolean;
  screen: { readonly current: ScreenState };
}

export function PostFx({ enabled, screen }: PostFxProps): React.ReactElement {
  const underwater = useMemo(() => new UnderwaterEffect(), []);
  const toneMap = useMemo(() => new GTToneMapEffect(), []);

  useFrame(() => {
    underwater.amount = screen.current.underwater;
  });

  return (
    <EffectComposer enabled={enabled} multisampling={4}>
      <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={0.8} />
      <primitive object={underwater} />
      <primitive object={toneMap} />
      <Vignette offset={0.3} darkness={0.35} />
    </EffectComposer>
  );
}
