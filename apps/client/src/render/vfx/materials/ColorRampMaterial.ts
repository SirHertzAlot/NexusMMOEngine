/**
 * ColorRampMaterial - scalar-to-gradient mapping materials.
 *
 * For: fire, smoke, magic, portal, dust, healing, poison, rain
 */
import * as THREE from "three";

/**
 * Base ColorRampMaterial - scalar-to-gradient mapping.
 */
class ColorRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "ColorRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uRamp;
        uniform float uValue;
        varying vec2 vUv;
        void main() {
          float clamped = clamp(uValue, 0.0, 1.0);
          vec3 color = texture2D(uRamp, vec2(clamped, 0.5)).rgb;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
      uniforms: {
        uRamp: { value: null },
        uValue: { value: 0.5 },
      },
    });
  }

  setRamp(t: THREE.Texture | null) { this.uniforms.uRamp.value = t; }
  setValue(v: number) { this.uniforms.uValue.value = THREE.MathUtils.clamp(v, 0, 1); }
}

/**
 * FireRampMaterial - rising flame effect.
 */
class FireRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "FireRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uFireRamp;
        uniform sampler2D uNoiseMap;
        uniform float uTime;
        uniform float uRiseSpeed;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          float noise = texture2D(uNoiseMap, vUv).r;
          float upwardScroll = fract(vUv.y - uTime * uRiseSpeed);
          float flame = noise * (1.0 - upwardScroll);
          vec3 color = texture2D(uFireRamp, vec2(clamp(flame, 0.0, 1.0), 0.5)).rgb;
          float alpha = clamp(flame * 1.25, 0.0, 1.0);
          gl_FragColor = vec4(color * uBaseColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uFireRamp: { value: null },
        uNoiseMap: { value: null },
        uTime: { value: 0 },
        uRiseSpeed: { value: 0.45 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  update(time: number) { this.uniforms.uTime.value = time; }
  setFireRamp(t: THREE.Texture | null) { this.uniforms.uFireRamp.value = t; }
  setNoiseMap(t: THREE.Texture | null) { this.uniforms.uNoiseMap.value = t; }
  setRiseSpeed(v: number) { this.uniforms.uRiseSpeed.value = v; }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * SmokeRampMaterial.
 */
class SmokeRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "SmokeRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uSmokeRamp;
        uniform float uSmokeDensity;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uSmokeRamp, vec2(clamp(uSmokeDensity, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uSmokeDensity, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uSmokeRamp: { value: null },
        uSmokeDensity: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setSmokeRamp(t: THREE.Texture | null) { this.uniforms.uSmokeRamp.value = t; }
  setSmokeDensity(v: number) { this.uniforms.uSmokeDensity.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * MagicRampMaterial - violet → cyan → white.
 */
class MagicRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "MagicRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMagicRamp;
        uniform float uEnergy;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uMagicRamp, vec2(clamp(uEnergy, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uEnergy, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uMagicRamp: { value: null },
        uEnergy: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setMagicRamp(t: THREE.Texture | null) { this.uniforms.uMagicRamp.value = t; }
  setEnergy(v: number) { this.uniforms.uEnergy.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * PortalRampMaterial.
 */
class PortalRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "PortalRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uPortalRamp;
        uniform float uEnergy;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uPortalRamp, vec2(clamp(uEnergy, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uEnergy, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPortalRamp: { value: null },
        uEnergy: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setPortalRamp(t: THREE.Texture | null) { this.uniforms.uPortalRamp.value = t; }
  setEnergy(v: number) { this.uniforms.uEnergy.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * DustRampMaterial - warm brown → pale tan.
 */
class DustRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "DustRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uDustRamp;
        uniform float uDustAmount;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uDustRamp, vec2(clamp(uDustAmount, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uDustAmount, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uDustRamp: { value: null },
        uDustAmount: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setDustRamp(t: THREE.Texture | null) { this.uniforms.uDustRamp.value = t; }
  setDustAmount(v: number) { this.uniforms.uDustAmount.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * HealingRampMaterial - soft green → pale gold.
 */
class HealingRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "HealingRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uHealingRamp;
        uniform float uHealth;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uHealingRamp, vec2(clamp(uHealth, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uHealth, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uHealingRamp: { value: null },
        uHealth: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setHealingRamp(t: THREE.Texture | null) { this.uniforms.uHealingRamp.value = t; }
  setHealth(v: number) { this.uniforms.uHealth.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * PoisonRampMaterial - sickly green → dark violet.
 */
class PoisonRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "PoisonRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uPoisonRamp;
        uniform float uPoison;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uPoisonRamp, vec2(clamp(uPoison, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uPoison, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPoisonRamp: { value: null },
        uPoison: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setPoisonRamp(t: THREE.Texture | null) { this.uniforms.uPoisonRamp.value = t; }
  setPoison(v: number) { this.uniforms.uPoison.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

/**
 * RainRampMaterial - blue-gray → transparent.
 */
class RainRampMaterial extends THREE.ShaderMaterial {
  constructor() {
    super({
      name: "RainRampMaterial",
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uRainRamp;
        uniform float uRainAmount;
        uniform vec3 uBaseColor;
        varying vec2 vUv;
        void main() {
          vec3 color = texture2D(uRainRamp, vec2(clamp(uRainAmount, 0.0, 1.0), 0.5)).rgb;
          gl_FragColor = vec4(color * uBaseColor, clamp(uRainAmount, 0.0, 1.0));
        }
      `,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uRainRamp: { value: null },
        uRainAmount: { value: 0.5 },
        uBaseColor: { value: new THREE.Color(1, 1, 1) },
      },
    });
  }

  setRainRamp(t: THREE.Texture | null) { this.uniforms.uRainRamp.value = t; }
  setRainAmount(v: number) { this.uniforms.uRainAmount.value = THREE.MathUtils.clamp(v, 0, 1); }
  setBaseColor(c: THREE.Color) { this.uniforms.uBaseColor.value = c; }
}

export { ColorRampMaterial, FireRampMaterial, SmokeRampMaterial, MagicRampMaterial, PortalRampMaterial, DustRampMaterial, HealingRampMaterial, PoisonRampMaterial, RainRampMaterial };