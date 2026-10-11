/**
 * TL5: Animation bake pipeline interface (ozz-animation + acl).
 *
 * This module defines the TypeScript interface for the native animation
 * bake pipeline. The actual ozz/acl implementation lives in a native
 * N-API addon (see docs/ANIMATION-BAKE-PIPELINE.md).
 *
 * For now, these are stubs that throw. They document the contract
 * that the native addon must fulfill.
 */

export interface SkeletonDef {
  /** Bone names in hierarchy order. */
  bones: string[];
  /** Parent indices (-1 for root). */
  parents: number[];
}

export interface RetargetResult {
  /** ozz runtime format clip data. */
  data: ArrayBuffer;
  /** Bones that couldn't be mapped. */
  unmappedBones: string[];
}

export interface CompressStats {
  rawBytes: number;
  compressedBytes: number;
  /** Max position error in centimeters. */
  maxError: number;
}

export interface ClipCompressResult {
  data: ArrayBuffer;
  stats: CompressStats;
}

export interface ValidationResult {
  /** Whether the clip loops seamlessly. */
  loopContinuous: boolean;
  /** Max foot displacement during contact phases (meters). */
  footSlide: number;
  boneCount: number;
  issues: string[];
}

/**
 * Retarget a clip from source to target skeleton.
 * @throws Always (native addon not yet implemented).
 */
export function retargetClip(
  _sourceClip: ArrayBuffer,
  _sourceSkeleton: SkeletonDef,
  _targetSkeleton: SkeletonDef
): RetargetResult {
  throw new Error(
    "retargetClip: native ozz addon not implemented (see docs/ANIMATION-BAKE-PIPELINE.md)"
  );
}

/**
 * Compress a clip with acl.
 * @throws Always (native addon not yet implemented).
 */
export function compressClip(
  _clip: ArrayBuffer,
  _errorThreshold: number
): ClipCompressResult {
  throw new Error(
    "compressClip: native acl addon not implemented (see docs/ANIMATION-BAKE-PIPELINE.md)"
  );
}

/**
 * Validate a clip (loop continuity, foot-slide, bone budget).
 * @throws Always (native addon not yet implemented).
 */
export function validateClip(_clip: ArrayBuffer): ValidationResult {
  throw new Error(
    "validateClip: native ozz addon not implemented (see docs/ANIMATION-BAKE-PIPELINE.md)"
  );
}

/**
 * Check if the native animation addon is available.
 */
export function hasAnimationAddon(): boolean {
  return false;
}
