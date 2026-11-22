/**
 * VFX Adapter - bridges semantic events to existing VFX systems.
 *
 * Uses existing:
 * - ParticleFx (weather, splashes) via three-nebula
 * - QuarksFx (combat, magic, ambient) via three.quarks
 * - EntityFxSystem (hit flashes, spawn bursts) via EntityFxSystem
 *
 * Integration contract:
 * - Backend emits meaning (structure_state_changed, combat_event, weather_changed)
 * - Adapter translates meaning to VFX calls on existing systems
 */
import * as THREE from "three";
import { ParticleFx, budgetMultiplierForTier } from "../fx/particle-fx.js";
import { QuarksFx, type VfxHandle } from "../vfx/quarks-fx.js";
import { EntityFxSystem } from "../entity-fx.js";
import type { MirrorClient } from "@mmo-engine/mirror";
import type { SurveyBand, SurveyDirection } from "@mmo-engine/protocol";
import type { TerrainRenderer } from "../terrain/terrain-renderer.js";
import type { Weather } from "../fx/weather.js";

const SURVEY_DIR_VECTORS: Record<SurveyDirection, { x: number; z: number }> = {
  here: { x: 0, z: 0 },
  N: { x: 0, z: -1 },
  NE: { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
  E: { x: 1, z: 0 },
  SE: { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  S: { x: 0, z: 1 },
  SW: { x: -Math.SQRT1_2, z: Math.SQRT1_2 },
  W: { x: -1, z: 0 },
  NW: { x: -Math.SQRT1_2, z: -Math.SQRT1_2 },
};

/**
 * Pure world-XZ direction unit vector matching server `computeSurveyBearing`:
 * N -> (0, -1), E -> (1, 0), S -> (0, 1), W -> (-1, 0), diagonals normalized.
 */
export function directionVector(dir: SurveyDirection): { x: number; z: number } {
  const v = SURVEY_DIR_VECTORS[dir];
  return v ? { x: v.x, z: v.z } : { x: 0, z: 0 };
}

interface SurveyFlareSpec {
  offsetM: number;
  radius: number;
  colorStr: string;
  colorHex: number;
  ttlSec: number;
  withAura: boolean;
}

const SURVEY_FLARE_SPECS: Record<Exclude<SurveyBand, "none">, SurveyFlareSpec> = {
  faint: { offsetM: 2.0, radius: 0.45, colorStr: "#60a5fa", colorHex: 0x60a5fa, ttlSec: 0.85, withAura: false },
  warm: { offsetM: 3.2, radius: 0.85, colorStr: "#fbbf24", colorHex: 0xfbbf24, ttlSec: 1.05, withAura: false },
  hot: { offsetM: 4.5, radius: 1.25, colorStr: "#f97316", colorHex: 0xf97316, ttlSec: 1.25, withAura: true },
  pinpoint: { offsetM: 2.2, radius: 1.65, colorStr: "#34d399", colorHex: 0x34d399, ttlSec: 1.5, withAura: true },
};

export interface VfxEvent {
  type: string;
  source?: { id: string; entityType?: string; position?: { x: number; y: number; z: number } };
  target?: { id: string; entityType?: string; position?: { x: number; y: number; z: number } };
  data: Record<string, unknown>;
  timestamp: number;
}

export interface VfxAdapterOptions {
  client: MirrorClient;
  terrain: TerrainRenderer;
  particleFx: ParticleFx;
  quarksFx: QuarksFx;
  entityFx: EntityFxSystem;
  qualityTier: import("@mmo-engine/art/browser").QualityTier;
}

/**
 * VFX Adapter - maps semantic events to existing VFX systems.
 */
export class VfxAdapter {
  private particleFx: ParticleFx;
  private quarksFx: QuarksFx;
  private entityFx: EntityFxSystem;
  private initialized = false;
  private disposed = false;
  private activeFlares: Array<{ handle: VfxHandle; remainingSec: number }> = [];

  constructor(_options: VfxAdapterOptions) {
    this.particleFx = _options.particleFx;
    this.quarksFx = _options.quarksFx;
    this.entityFx = _options.entityFx;
  }

  initialize(): void {
    if (this.disposed) return;
    this.initialized = true;
    console.info("[VFX] Adapter initialized with existing systems");
  }

  setQualityTier(tier: import("@mmo-engine/art/browser").QualityTier): void {
    if (this.disposed) return;
    const multiplier = budgetMultiplierForTier(tier);
    this.quarksFx.setBudget?.(multiplier);
    this.particleFx.setBudget?.(multiplier);
  }

  /**
   * Emit a directional compass survey flare toward `direction`, scaled by `band`.
   * Safe no-op when disposed, when `band === "none"`, or when origin is non-finite.
   */
  emitSurveyFlare(
    origin: { x: number; y?: number; z: number },
    direction: SurveyDirection,
    band: SurveyBand,
  ): void {
    if (this.disposed || band === "none") return;
    const oy = origin.y ?? 0;
    if (!Number.isFinite(origin.x) || !Number.isFinite(oy) || !Number.isFinite(origin.z)) return;
    const spec = SURVEY_FLARE_SPECS[band];
    if (!spec) return;

    const dir = directionVector(direction);
    const fx = origin.x + dir.x * spec.offsetM;
    const fz = origin.z + dir.z * spec.offsetM;

    const tempObj = new THREE.Object3D();
    tempObj.position.set(fx, oy + 0.6, fz);
    if (dir.x !== 0 || dir.z !== 0) {
      tempObj.rotation.y = Math.atan2(dir.x, dir.z);
    }
    tempObj.updateMatrixWorld(true);

    const sparkHandle =
      this.quarksFx?.attachSignal?.(
        { kind: "particles", id: "survey_flare", params: { effect: "sparks", radius: spec.radius, color: spec.colorStr } },
        tempObj,
      ) ?? null;
    if (sparkHandle) {
      this.activeFlares.push({ handle: sparkHandle, remainingSec: spec.ttlSec });
    }

    if (spec.withAura) {
      const auraHandle =
        this.quarksFx?.attachSignal?.(
          { kind: "aura", id: "survey_flare_aura", params: { color: spec.colorStr, radius: spec.radius } },
          tempObj,
        ) ?? null;
      if (auraHandle) {
        this.activeFlares.push({ handle: auraHandle, remainingSec: spec.ttlSec });
      }
    }

    // Update matrixWorld after parenting emitters so orphaned tempObj children inherit the flare offset.
    tempObj.updateMatrixWorld(true);
    this.entityFx?.spawnBurst?.(new THREE.Vector3(fx, oy + 0.08, fz), spec.colorHex);
  }

  handleEvent(event: VfxEvent): void {
    if (!this.initialized || this.disposed) return;

    switch (event.type) {
      case "structure_state_changed":
        this.handleStructureState(event);
        break;
      case "weather_changed":
        this.handleWeather(event);
        break;
      case "combat_event":
        this.handleCombat(event);
        break;
      case "spell_impact":
        this.handleSpellImpact(event);
        break;
      case "ambient_changed":
        this.handleAmbient(event);
        break;
      case "footstep":
        this.handleFootstep(event);
        break;
      case "manual_trigger":
        this.handleManualTrigger(event);
        break;
    }
  }

  private handleStructureState(event: VfxEvent): void {
    const structureKind = event.data.structureKind as string | undefined;
    const newState = event.data.newState as string | undefined;
    const intensity = Math.max(0, Math.min(1, Number(event.data.intensity ?? 1)));
    const position = event.data.position as { x: number; y: number; z: number } | undefined;

    if (!structureKind || !newState || !position) return;

    if (structureKind === "smithy" && newState === "working") {
      this.spawnForgeEffects(position, intensity);
    }
  }

  private spawnForgeEffects(position: { x: number; y: number; z: number }, intensity: number): void {
    const pos = new THREE.Vector3(position.x, position.y, position.z);

    // Spawn forge smoke via ParticleFx splash (one-off burst)
    this.particleFx.splash?.(pos, true);

    // Spawn sparks/glow via QuarksFx using signal attachments
    const tempObj = new THREE.Object3D();
    tempObj.position.set(position.x, position.y, position.z);

    this.quarksFx.attachSignal?.(
      { kind: "particles", id: "forge_sparks", params: { effect: "sparks", radius: 0.5 * intensity } },
      tempObj
    );
    this.quarksFx.attachSignal?.(
      { kind: "aura", id: "forge_glow", params: { color: "#ff7a2a", radius: 1.2 * intensity } },
      tempObj
    );

    // EntityFx for hammer impacts
    const burstPos = new THREE.Vector3(position.x, 0.08, position.z);
    // @ts-ignore - EntityFxSystem.spawnBurst expects Vector3 but TS infers Object3D
    this.entityFx.spawnBurst(burstPos, 0xff7a2a);
  }

  private handleWeather(_event: VfxEvent): void {
    // ParticleFx handles weather internally via update()
  }

  private handleCombat(event: VfxEvent): void {
    const position = event.data.position as { x: number; y: number; z: number } | undefined;

    if (!position) return;

    if (event.data.kind === "melee_hit") {
      const pos = new THREE.Vector3(position.x, position.y, position.z);
      // @ts-ignore - EntityFxSystem.spawnBurst expects Vector3 but TS infers Object3D
      this.entityFx.spawnBurst(pos, 0xff7a2a);

      // Use QuarksFx spark signal for impact flash
      const tempObj = new THREE.Object3D();
      tempObj.position.copy(pos);
      this.quarksFx.attachSignal?.(
        { kind: "particles", id: "impact_flash", params: { effect: "sparks", radius: 0.3 } },
        tempObj
      );
    }
  }

  private handleSpellImpact(event: VfxEvent): void {
    const position = event.data.position as { x: number; y: number; z: number } | undefined;
    const power = Number(event.data.power ?? 1);

    if (!position) return;

    const tempObj = new THREE.Object3D();
    tempObj.position.set(position.x, position.y, position.z);
    this.quarksFx.attachSignal?.(
      { kind: "particles", id: "spell_impact", params: { effect: "sparks", radius: 0.5 * power } },
      tempObj
    );
  }

  private handleAmbient(_event: VfxEvent): void {
    // Future: market dust, campfire smoke, etc.
  }

  private handleFootstep(_event: VfxEvent): void {
    // Could use QuarksFx trail or ParticleFx splash
  }

  private handleManualTrigger(event: VfxEvent): void {
    const effectId = event.data.effectId as string | undefined;
    const position = event.data.position as { x: number; y: number; z: number } | undefined;
    const intensity = Math.max(0, Math.min(1, Number(event.data.intensity ?? 1)));

    if (!effectId || !position) return;

    switch (event.data.effectId as string) {
      case "fx_forge_active":
        this.spawnForgeEffects(position, intensity);
        break;
      case "fx_portal": {
        const tempObj = new THREE.Object3D();
        tempObj.position.set(position.x, position.y, position.z);
        this.quarksFx.attachSignal?.(
          { kind: "aura", id: "portal", params: { color: "#c080ff", radius: 1.2 } },
          tempObj
        );
        break;
      }
      case "fx_spell_impact": {
        const tempObj = new THREE.Object3D();
        tempObj.position.set(position.x, position.y, position.z);
        this.quarksFx.attachSignal?.(
          { kind: "particles", id: "spell_impact", params: { effect: "sparks", radius: 0.5 * intensity } },
          tempObj
        );
        break;
      }
    }
  }

  update(dt: number, cameraPos?: THREE.Vector3, weather?: Weather): void {
    if (!this.initialized || this.disposed) return;

    for (let i = this.activeFlares.length - 1; i >= 0; i--) {
      const flare = this.activeFlares[i]!;
      flare.remainingSec -= dt;
      if (flare.remainingSec <= 0) {
        flare.handle.dispose();
        this.activeFlares.splice(i, 1);
      }
    }

    // Weather: null kind = clear
    const clearWeather: Weather = { kind: null, intensity: 0 };
    this.particleFx.update?.(dt, cameraPos ?? new THREE.Vector3(), weather ?? clearWeather);
    this.quarksFx.update?.(dt);
    this.entityFx.update?.(dt, performance.now() / 1000);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.initialized = false;
    for (const flare of this.activeFlares) {
      flare.handle.dispose();
    }
    this.activeFlares = [];
    this.particleFx.dispose?.();
    this.quarksFx.dispose?.();
    this.entityFx.dispose?.();
    if (vfxAdapterInstance === this) {
      vfxAdapterInstance = null;
    }
  }
}

export { VfxAdapter as VFXAdapter };

/**
 * Create and initialize the VFX adapter.
 */
export function createVfxAdapter(options: VfxAdapterOptions): VfxAdapter {
  const adapter = new VfxAdapter(options);
  adapter.initialize();
  return adapter;
}

/**
 * Singleton for global access.
 */
let vfxAdapterInstance: VfxAdapter | null = null;

export function getVfxAdapter(): VfxAdapter | null {
  return vfxAdapterInstance;
}

export function initializeVfxAdapter(options: VfxAdapterOptions): VfxAdapter {
  vfxAdapterInstance = createVfxAdapter(options);
  return vfxAdapterInstance;
}