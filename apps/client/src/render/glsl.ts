/**
 * Shared GLSL chunks for client FX shaders.
 *
 * Small, dependency-free noise/fbm helpers. Imported by element-fx.ts,
 * entity-fx.ts and terrain-fx.ts so the FX family shares one noise
 * implementation (DRY).
 */

export const NOISE_GLSL = /* glsl */ `
  float fxHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float fxNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x),
      mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fxFbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * fxNoise(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return v;
  }
  float fxRidge(vec2 p) {
    float n = fxFbm(p);
    return 1.0 - abs(2.0 * n - 1.0);
  }
`;
