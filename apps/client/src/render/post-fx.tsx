/**
 * PostFx — the screen effects over the mirror world (pmndrs
 * postprocessing through @react-three/postprocessing).
 *
 * - Antialiasing: the composer's multisampling (the canvas's own MSAA no
 *   longer reaches the screen once a composer renders the scene).
 * - Ambient occlusion (N8AO): soft contact shadows in corners, creases
 *   and where things meet the ground, in metres of world space.
 * - Bloom: only light above the threshold glows (the FX orbs and beams,
 *   emissive lava), not the sky or sunlit ground.
 * - Underwater: tint, murk by distance, and wobble, faded in by
 *   `screen.underwater` (WorldCanvas writes it every frame).
 * - Tone mapping: the Gran Turismo curve (see GTToneMapEffect). The
 *   composer turns the renderer's own tone mapping off, so without it
 *   bright light clips at white.
 * - A light vignette.
 *
 * The quality preset (quality.ts) says which of these run: the low
 * preset renders the scene straight to the screen, as before the
 * composer existed.
 */

import { useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, Vignette } from "@react-three/postprocessing";
import { useMemo } from "react";
import { UnderwaterEffect } from "./effects/underwater-effect.js";
import { GTToneMapEffect } from "./effects/gt-tonemap-effect.js";
import type { QualitySettings } from "./quality.js";

/** Per-frame screen state the world writes and the effects read (no React state). */
export interface ScreenState {
  /** 0 above water .. 1 fully under (see underwaterAmount). */
  underwater: number;
}

export interface PostFxProps {
  quality: QualitySettings;
  screen: { readonly current: ScreenState };
  /** Effects drawn first, on the scene (the physical sky's aerial perspective). */
  children?: React.ReactNode;
}

export function PostFx({ quality, screen, children }: PostFxProps): React.ReactElement {
  const underwater = useMemo(() => new UnderwaterEffect(), []);
  const toneMap = useMemo(() => new GTToneMapEffect(), []);

  useFrame(() => {
    underwater.amount = screen.current.underwater;
  });

  return (
    <EffectComposer enabled={quality.effects} multisampling={quality.msaa}>
      {quality.ao ? (
        <N8AO aoRadius={1.6} distanceFalloff={0.6} intensity={2.2} quality={quality.ao.quality} halfRes={quality.ao.halfRes} depthAwareUpsampling />
      ) : (
        <></>
      )}
      <>{children}</>
      {quality.bloom ? <Bloom mipmapBlur luminanceThreshold={0.9} luminanceSmoothing={0.2} intensity={0.8} /> : <></>}
      <primitive object={underwater} />
      <primitive object={toneMap} />
      <Vignette offset={0.3} darkness={0.35} />
    </EffectComposer>
  );
}
