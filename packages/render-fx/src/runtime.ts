/**
 * Framework-independent VFX runtime (docs/VFX-SHADER-POSTFX-BLUEPRINT.md §4, §6, §8).
 *
 * Zero `react` and zero `three` imports. Owns asset definitions, quality-tier
 * slot caps, parameter validation and `$param` indirection, `(tick, seq)`
 * ordering + `fxId` deduplication for authoritative `0x28` messages, orphan
 * rules (`fade | detach | kill`), and instance lifecycles.
 *
 * A renderer adapter (such as the client's Three.js `SpellFxLayer`) attaches
 * optional `EffectRendererHooks` to mirror handle creation, parameter updates,
 * shield hit rings, and frame ticks onto GPU objects.
 */

import { resolveModuleParams, validateAsset } from "./asset-schema.js";
import {
  FX_TIERS,
  type EffectBinding,
  type EffectDefinition,
  type EffectInstance,
  type EffectRuntime,
  type FxTier,
  type InstanceState,
  type ParamValue,
} from "./types.js";

export interface FxWireSpawn {
  kind: "fx-spawn";
  fxId: string;
  tick: number;
  seq: number;
  assetId: string;
  assetVersion: 1;
  seed: number;
  binding: EffectBinding;
  phase: string;
  params?: Record<string, ParamValue>;
}

export interface FxWireUpdate {
  kind: "fx-update";
  fxId: string;
  tick: number;
  seq: number;
  phase?: string;
  params?: Record<string, ParamValue>;
  hit?: { pos: [number, number, number]; normal?: [number, number, number] };
}

export interface FxWireKill {
  kind: "fx-kill";
  fxId: string;
  tick: number;
  seq: number;
  fade: number;
}

export type FxWireMessage = FxWireSpawn | FxWireUpdate | FxWireKill;

export interface LiveEffectState extends EffectInstance {
  binding: EffectBinding;
  phase: string;
  params: Record<string, ParamValue>;
  moduleParams: Array<Record<string, ParamValue>>;
  fadeRemaining: number;
  fadeDuration: number;
  fxId?: string;
}

export interface EffectRendererHooks {
  onSpawn?(instance: Readonly<LiveEffectState>): void;
  onParam?(instance: Readonly<LiveEffectState>, name: string, value: ParamValue): void;
  onPhase?(instance: Readonly<LiveEffectState>, phase: string): void;
  onRebind?(instance: Readonly<LiveEffectState>): void;
  onHit?(instance: Readonly<LiveEffectState>, hit: { pos: [number, number, number]; normal?: [number, number, number] }): void;
  onInterrupt?(instance: Readonly<LiveEffectState>, fade: number): void;
  onUpdate?(instance: Readonly<LiveEffectState>, dt: number, camera: unknown): void;
  onDispose?(instance: Readonly<LiveEffectState>): void;
}

export interface EffectRuntimeOptions {
  initialTier?: FxTier;
  /** Optional per-asset per-tier slot caps from `content/vfx/budgets.json` (`fxSlots`). */
  fxSlots?: Record<string, Partial<Record<FxTier, number>>>;
  dedupeCap?: number;
  hooks?: EffectRendererHooks;
}

function tierIndex(t: FxTier): number {
  return FX_TIERS.indexOf(t);
}

function clampParam(def: EffectDefinition, name: string, value: ParamValue): ParamValue {
  const decl = def.params[name];
  if (!decl) return value;
  if ((decl.type === "float" || decl.type === "int") && typeof value === "number") {
    let v = decl.type === "int" ? Math.round(value) : value;
    if (decl.min !== undefined && v < decl.min) v = decl.min;
    if (decl.max !== undefined && v > decl.max) v = decl.max;
    return v;
  }
  if (decl.type === "enum" && typeof value === "string" && decl.options && !decl.options.includes(value)) {
    return decl.default;
  }
  return value;
}

function computeAllModuleParams(def: EffectDefinition, params: Record<string, ParamValue>): Array<Record<string, ParamValue>> {
  return def.modules.map((_, i) => resolveModuleParams(def, i, params));
}

export class ManagedEffectRuntime implements EffectRuntime {
  private readonly assets = new Map<string, EffectDefinition>();
  private readonly instances = new Map<number, LiveEffectState>();
  private readonly byFxId = new Map<string, number>();
  private readonly lastOrderByFxId = new Map<string, { tick: number; seq: number }>();
  private readonly dedupe = new Map<string, number>();
  private readonly dedupeCap: number;
  private readonly fxSlots: Record<string, Partial<Record<FxTier, number>>>;
  private readonly hooks?: EffectRendererHooks;
  private tier: FxTier;
  private nextHandle = 1;
  private dropped = 0;

  constructor(opts: EffectRuntimeOptions = {}) {
    this.tier = opts.initialTier ?? "high";
    this.fxSlots = opts.fxSlots ?? {};
    this.dedupeCap = opts.dedupeCap ?? 512;
    this.hooks = opts.hooks;
  }

  get currentTier(): FxTier {
    return this.tier;
  }

  get activeCount(): number {
    return this.instances.size;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  getInstance(handle: number): Readonly<LiveEffectState> | undefined {
    return this.instances.get(handle);
  }

  getHandleByFxId(fxId: string): number | undefined {
    return this.byFxId.get(fxId);
  }

  registerAsset(def: EffectDefinition): void {
    const res = validateAsset(def);
    if (!res.ok) {
      throw new Error(`registerAsset(${def.assetId}): ${res.issues.join("; ")}`);
    }
    this.assets.set(res.def.assetId, Object.freeze(res.def));
  }

  private slotCapFor(def: EffectDefinition, tier: FxTier): number {
    const budgetCap = this.fxSlots[def.assetId]?.[tier];
    if (budgetCap !== undefined) return budgetCap;
    const assetCap = def.quality.slotCaps?.[tier];
    if (assetCap !== undefined) return assetCap;
    return 32;
  }

  private allowedOnTier(def: EffectDefinition, tier: FxTier): boolean {
    if (tierIndex(tier) < tierIndex(def.quality.minTier)) return false;
    return this.slotCapFor(def, tier) > 0;
  }

  private countForAsset(assetId: string): number {
    let n = 0;
    for (const inst of this.instances.values()) {
      if (inst.def.assetId === assetId) n++;
    }
    return n;
  }

  spawn(
    assetId: string,
    binding: EffectBinding,
    opts?: { seed?: number; startAge?: number; phase?: string; params?: Record<string, ParamValue>; fxId?: string },
  ): number | null {
    const def = this.assets.get(assetId);
    if (!def) {
      this.dropped++;
      return null;
    }
    if (!this.allowedOnTier(def, this.tier)) {
      this.dropped++;
      return null;
    }
    const cap = this.slotCapFor(def, this.tier);
    if (this.countForAsset(assetId) >= cap) {
      this.dropped++;
      return null;
    }

    const params: Record<string, ParamValue> = {};
    for (const [k, decl] of Object.entries(def.params)) {
      params[k] = decl.default;
    }
    if (opts?.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        params[k] = clampParam(def, k, v);
      }
    }

    const startAge = Math.max(0, opts?.startAge ?? 0);
    if (def.kind === "oneshot" && def.timing.loop === "once" && def.timing.duration > 0 && startAge >= def.timing.duration) {
      return null;
    }

    const handle = this.nextHandle++;
    const state: InstanceState = startAge > 0 ? "active" : "spawning";
    const instance: LiveEffectState = {
      handle,
      def,
      age: startAge,
      seed: opts?.seed ?? 1,
      state,
      binding: { ...binding },
      phase: opts?.phase ?? "active",
      params,
      moduleParams: computeAllModuleParams(def, params),
      fadeRemaining: 0,
      fadeDuration: 0,
      ...(opts?.fxId ? { fxId: opts.fxId } : {}),
    };

    this.instances.set(handle, instance);
    if (opts?.fxId) this.byFxId.set(opts.fxId, handle);
    this.hooks?.onSpawn?.(instance);
    return handle;
  }

  setParam(handle: number, name: string, v: ParamValue): void {
    const inst = this.instances.get(handle);
    if (!inst || inst.state === "finished") return;
    const clamped = clampParam(inst.def, name, v);
    inst.params[name] = clamped;
    inst.moduleParams = computeAllModuleParams(inst.def, inst.params);
    this.hooks?.onParam?.(inst, name, clamped);
  }

  setPhase(handle: number, phase: string): void {
    const inst = this.instances.get(handle);
    if (!inst || inst.state === "finished") return;
    inst.phase = phase;
    this.hooks?.onPhase?.(inst, phase);
  }

  recordHit(handle: number, hit: { pos: [number, number, number]; normal?: [number, number, number] }): void {
    const inst = this.instances.get(handle);
    if (!inst || inst.state === "finished") return;
    this.hooks?.onHit?.(inst, hit);
  }

  rebind(handle: number, binding: EffectBinding): void {
    const inst = this.instances.get(handle);
    if (!inst || inst.state === "finished") return;
    inst.binding = { ...binding };
    this.hooks?.onRebind?.(inst);
  }

  interrupt(handle: number, fade: number): void {
    const inst = this.instances.get(handle);
    if (!inst || inst.state === "finished") return;
    if (fade <= 0) {
      this.disposeHandle(handle);
      return;
    }
    inst.state = "interrupting";
    inst.fadeDuration = fade;
    inst.fadeRemaining = fade;
    this.hooks?.onInterrupt?.(inst, fade);
  }

  disposeHandle(handle: number): void {
    const inst = this.instances.get(handle);
    if (!inst) return;
    inst.state = "finished";
    if (inst.fxId) this.byFxId.delete(inst.fxId);
    this.instances.delete(handle);
    this.hooks?.onDispose?.(inst);
  }

  /**
   * Handle entity despawn / interest exit according to each asset's `onOrphan` rule.
   */
  orphanEntity(entityId: string, lastKnownPos?: [number, number, number]): void {
    for (const [handle, inst] of [...this.instances]) {
      if ((inst.binding.kind === "entity" || inst.binding.kind === "socket") && inst.binding.entityId === entityId) {
        switch (inst.def.onOrphan) {
          case "kill":
            this.disposeHandle(handle);
            break;
          case "fade":
            this.interrupt(handle, 0.35);
            break;
          case "detach":
            this.rebind(handle, {
              kind: "world",
              pos: lastKnownPos ?? inst.binding.pos ?? [0, 0, 0],
              ...(inst.binding.offset ? { offset: inst.binding.offset } : {}),
            });
            break;
        }
      }
    }
  }

  /**
   * Authoritative 0x28 `FxMessage` intake with `(tick, seq)` supersession and `fxId` deduplication.
   */
  applyFxMessage(msg: FxWireMessage, clientTick: number, tickHz = 30): number | null {
    const prevOrder = this.lastOrderByFxId.get(msg.fxId);
    if (prevOrder && (msg.tick < prevOrder.tick || (msg.tick === prevOrder.tick && msg.seq <= prevOrder.seq))) {
      return null;
    }

    if (msg.kind === "fx-spawn") {
      if (this.dedupe.has(msg.fxId)) return null;
      this.dedupe.set(msg.fxId, msg.tick);
      if (this.dedupe.size > this.dedupeCap) {
        let oldestKey: string | null = null;
        let oldestTick = Infinity;
        for (const [k, t] of this.dedupe) {
          if (t < oldestTick) {
            oldestTick = t;
            oldestKey = k;
          }
        }
        if (oldestKey !== null) this.dedupe.delete(oldestKey);
      }
      this.lastOrderByFxId.set(msg.fxId, { tick: msg.tick, seq: msg.seq });
      const startAge = Math.max(0, (clientTick - msg.tick) / (tickHz || 30));
      return this.spawn(msg.assetId, msg.binding, {
        seed: msg.seed,
        startAge,
        phase: msg.phase,
        params: msg.params,
        fxId: msg.fxId,
      });
    }

    const handle = this.byFxId.get(msg.fxId);
    this.lastOrderByFxId.set(msg.fxId, { tick: msg.tick, seq: msg.seq });
    if (handle === undefined) return null;

    if (msg.kind === "fx-update") {
      if (msg.phase !== undefined) this.setPhase(handle, msg.phase);
      if (msg.params) {
        for (const [k, v] of Object.entries(msg.params)) {
          this.setParam(handle, k, v);
        }
      }
      if (msg.hit) this.recordHit(handle, msg.hit);
      return handle;
    }

    if (msg.kind === "fx-kill") {
      this.interrupt(handle, msg.fade);
      return handle;
    }

    return null;
  }

  update(dt: number, camera: unknown): void {
    if (dt <= 0) return;
    for (const [handle, inst] of [...this.instances]) {
      inst.age += dt;
      if (inst.state === "spawning") {
        inst.state = "active";
      } else if (inst.state === "interrupting") {
        inst.fadeRemaining -= dt;
        if (inst.fadeRemaining <= 0) {
          this.disposeHandle(handle);
          continue;
        }
      }
      if (
        inst.def.kind === "oneshot" &&
        inst.def.timing.loop === "once" &&
        inst.def.timing.duration > 0 &&
        inst.age >= inst.def.timing.duration
      ) {
        this.disposeHandle(handle);
        continue;
      }
      this.hooks?.onUpdate?.(inst, dt, camera);
    }
  }

  setQuality(t: FxTier): void {
    this.tier = t;
    for (const [handle, inst] of [...this.instances]) {
      if (!this.allowedOnTier(inst.def, t)) {
        this.disposeHandle(handle);
      }
    }
  }

  dispose(): void {
    for (const handle of [...this.instances.keys()]) {
      this.disposeHandle(handle);
    }
    this.byFxId.clear();
    this.lastOrderByFxId.clear();
    this.dedupe.clear();
  }
}

export function createEffectRuntime(opts?: EffectRuntimeOptions): ManagedEffectRuntime {
  return new ManagedEffectRuntime(opts);
}
