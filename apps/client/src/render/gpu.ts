import type * as THREE from "three";

/** Which WebGL implementation the browser actually gave us. */
export interface GpuInfo {
  renderer: string;
  /**
   * Software rasterizer (SwiftShader / llvmpipe / Microsoft Basic Render
   * Driver): hardware acceleration is off or the GPU is blocklisted, and
   * single-digit fps is expected regardless of scene cost.
   */
  software: boolean;
}

export function detectGpu(renderer: THREE.WebGLRenderer): GpuInfo {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  return {
    renderer: name,
    software: /swiftshader|llvmpipe|software|basic render/i.test(name),
  };
}
