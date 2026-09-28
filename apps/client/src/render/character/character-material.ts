/**
 * The modular character material: the pack's atlas, recoloured per
 * character through its four mask textures (see @mmo-engine/art
 * colour-slots). Each mask channel marks one region dark on white; the
 * shader paints that region with the character's colour for it.
 *
 * One material per character (its colours), sharing the textures.
 */

import * as THREE from "three";
import { COLOUR_SLOTS, DEFAULT_COLOURS, MASK_CHANNELS, type ColourSlot } from "@mmo-engine/art/browser";

export interface CharacterTextures {
  base: THREE.Texture;
  /** Mask_01..04, loaded as data (no colour space), same UV convention as `base`. */
  masks: readonly THREE.Texture[];
}

const CHANNEL = ["r", "g", "b"] as const;

// One mix per colour slot, generated from the channel table.
const RECOLOUR_GLSL = COLOUR_SLOTS.map((slot, i) => {
  const [mask, channel] = MASK_CHANNELS[slot];
  return `  diffuseColor.rgb = mix(diffuseColor.rgb, uCharColours[${i}], 1.0 - chrMask${mask}.${CHANNEL[channel]});`;
}).join("\n");

export class CharacterMaterial extends THREE.MeshStandardMaterial {
  private readonly colourUniform: { value: THREE.Color[] };

  constructor(textures: CharacterTextures, colours: Partial<Record<ColourSlot, string>> = {}) {
    super({ map: textures.base, roughness: 0.85, metalness: 0 });
    if (textures.masks.length !== 4) throw new Error("character material: want 4 mask textures");
    this.name = "ModularCharacter";
    this.colourUniform = { value: COLOUR_SLOTS.map(() => new THREE.Color()) };
    this.setColours(colours);
    const masks = textures.masks;
    this.onBeforeCompile = (shader) => {
      shader.uniforms.uCharColours = this.colourUniform;
      masks.forEach((m, i) => (shader.uniforms[`uCharMask${i}`] = { value: m }));
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform vec3 uCharColours[${COLOUR_SLOTS.length}];
${masks.map((_, i) => `uniform sampler2D uCharMask${i};`).join("\n")}`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
#ifdef USE_MAP
${masks.map((_, i) => `  vec3 chrMask${i} = texture2D(uCharMask${i}, vMapUv).rgb;`).join("\n")}
${RECOLOUR_GLSL}
#endif`,
        );
    };
    this.customProgramCacheKey = () => "mmo-modular-character";
  }

  /**
   * Set colours (sRGB hex); slots not given go back to the pack's own
   * colour. A look's colours go through effectiveColours first, so the
   * regions its player didn't choose follow the skin.
   */
  setColours(colours: Partial<Record<ColourSlot, string>>): void {
    COLOUR_SLOTS.forEach((slot, i) => this.colourUniform.value[i].setStyle(colours[slot] ?? DEFAULT_COLOURS[slot]));
  }

  /** The current colour of a slot (sRGB hex), for UIs. */
  colourOf(slot: ColourSlot): string {
    return `#${this.colourUniform.value[COLOUR_SLOTS.indexOf(slot)].getHexString()}`;
  }
}
