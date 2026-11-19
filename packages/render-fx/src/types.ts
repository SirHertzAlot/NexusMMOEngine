/**
 * Canonical FX types — packages/render-fx/src/types.ts [PROPOSED, PR1].
 *
 * Framework-independent: no three.js, no react imports allowed in this
 * package (CI greps for them). The client R3F adapter (a later PR) maps
 * these onto THREE objects; the authoritative spec lives in
 * docs/VFX-SHADER-POSTFX-BLUEPRINT.md sections 6-8.
 */

/** Engine quality tiers, verbatim from apps/client/src/render/quality.ts. */
export type FxTier = "low" | "medium" | "high" | "ultra";
export const FX_TIERS: readonly FxTier[] = ["low", "medium", "high", "ultra"] as const;

export type ParamType = "float" | "vec3" | "color" | "ramp" | "curve" | "enum" | "int";

export interface ParamDecl {
  type: ParamType;
  default: ParamValue;
  min?: number;
  max?: number;
  options?: string[];
  units?: "s" | "m" | "x" | "deg";
}

/**
 * Closed parameter value union. Writers validate before uniform upload.
 * - number: float/int/enum-index scalars
 * - [x,y,z]: vec3 offsets/positions (metres)
 * - string: color hex ("#rrggbb"), ramp/curve LUT id, enum option, or "$param" reference
 * - number[]: ramp/curve LUT stops
 */
export type ParamValue = number | [number, number, number] | string | number[];

export type BindingKind = "local" | "world" | "entity" | "socket";

export interface EffectBinding {
  kind: BindingKind;
  /** Protocol wire-id string (matches AbilityMessage.entity). */
  entityId?: string;
  /** Bone/socket name; resolved at most once per frame. */
  socket?: string;
  /** Metres, applied in the binding space. */
  offset?: [number, number, number];
  /** kind == "world": authoritative metres. */
  pos?: [number, number, number];
  /** Optional unit surface normal. */
  normal?: [number, number, number];
}

export type OrphanRule = "fade" | "detach" | "kill";

export type FxModuleName =
  | "ShellModule"
  | "RingBurstModule"
  | "PoolModule"
  | "TrailModule"
  | "MuzzleFlashModule"
  | "ShieldModule";

export interface EffectModuleDef {
  module: FxModuleName;
  params: Record<string, ParamValue>;
  /** LUT ids generated once at load. */
  ramp?: string;
  curve?: string;
}

export interface EffectTiming {
  /** Seconds; -1 = indefinite (persistent). */
  duration: number;
  loop: "once" | "loop" | "pingpong";
  seedable: boolean;
}

export interface EffectDefinition {
  /** Stable id, e.g. "fx.charged-shot". */
  assetId: string;
  /** PR1 ships version 1 only; migrateAsset rejects others. */
  version: 1;
  kind: "oneshot" | "persistent";
  params: Record<string, ParamDecl>;
  /** Bounded: 1..8 modules. */
  modules: EffectModuleDef[];
  /** At least one binding. */
  bindings: EffectBinding[];
  timing: EffectTiming;
  quality: {
    minTier: FxTier;
    slotCaps?: Partial<Record<FxTier, number>>;
  };
  onOrphan: OrphanRule;
}

export type InstanceState = "spawning" | "active" | "interrupting" | "finished";

/** Runtime-owned live instance: handle only, disposal goes through the runtime. */
export interface EffectInstance {
  handle: number;
  def: EffectDefinition;
  age: number;
  seed: number;
  state: InstanceState;
}

export interface EffectRuntime {
  registerAsset(def: EffectDefinition): void;
  /** Returns a handle, or null when budget-dropped. */
  spawn(assetId: string, binding: EffectBinding, opts?: { seed?: number; startAge?: number }): number | null;
  setParam(handle: number, name: string, v: ParamValue): void;
  rebind(handle: number, binding: EffectBinding): void;
  interrupt(handle: number, fade: number): void;
  disposeHandle(handle: number): void;
  update(dt: number, camera: unknown): void;
  setQuality(t: FxTier): void;
  dispose(): void;
}
