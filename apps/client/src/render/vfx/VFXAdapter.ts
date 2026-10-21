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
import { QuarksFx } from "../vfx/quarks-fx.js";
import { EntityFxSystem } from "../entity-fx.js";
import type { MirrorClient } from "@mmo-engine/mirror";
import type { TerrainRenderer } from "../terrain/terrain-renderer.js";
import type { Weather } from "../fx/weather.js";

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

  constructor(_options: VfxAdapterOptions) {
    this.particleFx = _options.particleFx;
    this.quarksFx = _options.quarksFx;
    this.entityFx = _options.entityFx;
  }

  initialize(): void {
    this.initialized = true;
    console.info("[VFX] Adapter initialized with existing systems");
  }

  setQualityTier(tier: import("@mmo-engine/art/browser").QualityTier): void {
    const multiplier = budgetMultiplierForTier(tier);
    this.quarksFx.setBudget?.(multiplier);
    this.particleFx.setBudget?.(multiplier);
  }

  handleEvent(event: VfxEvent): void {
    if (!this.initialized) return;

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
    if (!this.initialized) return;

    // Weather: null kind = clear
    const clearWeather: Weather = { kind: null, intensity: 0 };
    this.particleFx.update?.(dt, cameraPos ?? new THREE.Vector3(), weather ?? clearWeather);
    this.quarksFx.update?.(dt);
    this.entityFx.update(dt, performance.now() / 1000);
  }

  dispose(): void {
    this.particleFx.dispose?.();
    this.quarksFx.dispose?.();
    this.entityFx.dispose?.();
  }
}

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