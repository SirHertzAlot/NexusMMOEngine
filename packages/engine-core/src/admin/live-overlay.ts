/**
 * Selection-scoped Graphify H4 live overlay (`patches/GRAPHIFY-HARVESTER-SPEC.md §9`).
 *
 * Tracks per-field last-writers (`{ system, tick }`) exclusively for explicitly
 * watched entities (LRU-capped at `MAX_WATCHED_ENTITIES` and auto-expired after
 * `WATCH_TTL_TICKS`). When no entity is watched, `hasWatches` is false and the
 * simulation loop pays a single branch with zero allocations and zero scans.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hasComponent } from "bitecs";
import * as C from "../components.js";
import { Body, Injury } from "../body.js";
import { Mana } from "../magic.js";
import type { SystemAccess } from "../system-access.js";
import type { SimWorld } from "../world.js";
import { projectEntityComponents } from "./inspect.js";

export const MAX_WATCHED_ENTITIES = 16;
export const WATCH_TTL_TICKS = 300;

export interface LiveWriterRecord {
  system: string;
  tick: number;
}

export interface LiveOverlayField {
  name: string;
  value: unknown;
  lastWriter?: LiveWriterRecord;
}

export interface LiveOverlayComponent {
  component: string;
  tag?: boolean;
  fields: LiveOverlayField[];
}

export interface LiveEntityOverlay {
  wireId: string;
  slot: number;
  tick: number;
  buildCommit: string | null;
  components: LiveOverlayComponent[];
}

type ComponentStore = Record<string, Record<number, number>>;

const SCALAR_STORES: Readonly<Record<string, { store: object; fields: readonly string[] }>> = {
  Transform: { store: C.Transform, fields: ["px", "py", "pz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"] },
  Velocity: { store: C.Velocity, fields: ["lx", "ly", "lz", "ax", "ay", "az"] },
  PlayerIntent: { store: C.PlayerIntent, fields: ["mx", "my", "mz", "lookYaw", "lookPitch", "jump", "buttons"] },
  Chunk: { store: C.Chunk, fields: ["chunkIdHi", "chunkIdLo", "seedHi", "seedLo", "lod"] },
  Health: { store: C.Health, fields: ["current", "max"] },
  Stamina: { store: C.Stamina, fields: ["current", "max"] },
  Needs: { store: C.Needs, fields: ["hunger", "hungerMax", "thirst", "thirstMax"] },
  CharacterRef: { store: C.CharacterRef, fields: ["idHi", "idLo"] },
  FlowRef: { store: C.FlowRef, fields: ["graph", "enabled"] },
  VfxEmitter: { store: C.VfxEmitter, fields: ["template", "intensity"] },
  AudioEmitter: { store: C.AudioEmitter, fields: ["clip", "radius"] },
  BodyConfig: { store: C.BodyConfig, fields: ["shapeKind", "halfX", "halfY", "halfZ", "radius", "mass", "motionType", "layer", "friction", "restitution"] },
  PathRequest: { store: C.PathRequest, fields: ["x", "z", "profile", "token"] },
  PathState: { store: C.PathState, fields: ["status", "token", "waypointOffset", "waypointCount"] },
  NavAgent: { store: C.NavAgent, fields: ["tx", "ty", "tz", "seq", "speed", "state"] },
  AssetRef: { store: C.AssetRef, fields: ["assetHash", "variant"] },
  Locomotion: { store: C.Locomotion, fields: ["mode", "abilities", "breath"] },
  Appearance: { store: C.Appearance, fields: ["look"] },
  Action: { store: C.Action, fields: ["move", "started", "seq", "yaw"] },
  WorldItem: { store: C.WorldItem, fields: ["item", "owner", "ownedUntil", "despawnAt"] },
  Animation: { store: C.Animation, fields: ["clipId", "startTick", "rate", "layerMask"] },
  Body: { store: Body, fields: ["blood", "bloodMax", "seen", "lost"] },
  Injury: { store: Injury, fields: ["bits", "move", "stamina", "flags"] },
  Mana: { store: Mana, fields: ["current", "max"] },
  God: { store: C.God, fields: [] },
  Breakable: { store: C.Breakable, fields: [] },
  Noclip: { store: C.Noclip, fields: [] },
  FarVisible: { store: C.FarVisible, fields: [] },
};

interface WatchEntry {
  wireId: bigint;
  expiresTick: number;
  writers: Map<string, LiveWriterRecord>;
  /** Reusable before-step snapshot keyed by `"Comp"` presence (`0`/`1`) and `"Comp.field"`. */
  scratch: Map<string, number>;
}

/**
 * Lightweight `.git/HEAD` reader for boot-time `buildCommit` metadata.
 * Avoids spawning `git` on server startup; env `MMO_BUILD_COMMIT` wins when set.
 */
export function resolveBuildCommit(startDir: string = process.cwd()): string | null {
  const fromEnv = process.env.MMO_BUILD_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  let dir = resolve(startDir);
  for (;;) {
    const headPath = join(dir, ".git", "HEAD");
    if (existsSync(headPath)) {
      try {
        const raw = readFileSync(headPath, "utf8").trim();
        if (raw.startsWith("ref:")) {
          const refRel = raw.slice(4).trim();
          const refPath = join(dir, ".git", ...refRel.split("/"));
          if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim() || null;
          const packed = join(dir, ".git", "packed-refs");
          if (existsSync(packed)) {
            for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
              if (!line || line.startsWith("#") || line.startsWith("^")) continue;
              const [sha, name] = line.split(" ");
              if (name === refRel && sha) return sha.trim();
            }
          }
          return null;
        }
        return raw || null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Selection-scoped tracker recording per-field last writers only for watched wire ids. */
export class EntityFieldTracker {
  private readonly watches = new Map<bigint, WatchEntry>();

  get hasWatches(): boolean {
    return this.watches.size > 0;
  }

  get watchedCount(): number {
    return this.watches.size;
  }

  /** Register or refresh a wire id watch (bounded LRU). */
  watch(wireId: bigint, currentTick: number): void {
    const existing = this.watches.get(wireId);
    if (existing) {
      existing.expiresTick = currentTick + WATCH_TTL_TICKS;
      this.watches.delete(wireId);
      this.watches.set(wireId, existing);
      return;
    }
    if (this.watches.size >= MAX_WATCHED_ENTITIES) {
      const oldest = this.watches.keys().next().value;
      if (oldest !== undefined) this.watches.delete(oldest);
    }
    this.watches.set(wireId, {
      wireId,
      expiresTick: currentTick + WATCH_TTL_TICKS,
      writers: new Map(),
      scratch: new Map(),
    });
  }

  /** Capture written component/field values before `system.step` for watched entities only. */
  beforeSystem(world: SimWorld, access: SystemAccess | undefined): void {
    if (this.watches.size === 0 || !access || access.writes.length === 0) return;
    for (const entry of this.watches.values()) {
      entry.scratch.clear();
      const eid = world.resolveWireId(entry.wireId);
      if (eid < 0) continue;
      for (const w of access.writes) {
        const compName = typeof w === "string" ? w : w.component;
        const meta = SCALAR_STORES[compName];
        if (!meta) continue;
        const present = hasComponent(world.ecs, meta.store as Parameters<typeof hasComponent>[1], eid);
        entry.scratch.set(compName, present ? 1 : 0);
        if (!present) continue;
        const fields = typeof w === "string" ? meta.fields : w.fields;
        const store = meta.store as ComponentStore;
        for (const f of fields) {
          const arr = store[f];
          if (arr) entry.scratch.set(`${compName}.${f}`, arr[eid] as number);
        }
      }
    }
  }

  /** Record `lastWriter` for any watched field whose value or membership changed during `system.step`. */
  afterSystem(world: SimWorld, systemName: string, access: SystemAccess | undefined): void {
    if (this.watches.size === 0 || !access || access.writes.length === 0) return;
    const tick = world.currentTick;
    for (const entry of this.watches.values()) {
      const eid = world.resolveWireId(entry.wireId);
      if (eid < 0) continue;
      for (const w of access.writes) {
        const compName = typeof w === "string" ? w : w.component;
        const meta = SCALAR_STORES[compName];
        if (!meta) continue;
        const presentNow = hasComponent(world.ecs, meta.store as Parameters<typeof hasComponent>[1], eid);
        const wasPresent = (entry.scratch.get(compName) ?? 0) === 1;
        const fields = typeof w === "string" ? meta.fields : w.fields;
        if (fields.length === 0) {
          if (presentNow !== wasPresent) {
            entry.writers.set(compName, { system: systemName, tick });
          }
          continue;
        }
        if (!presentNow) {
          if (wasPresent) {
            for (const f of fields) entry.writers.set(`${compName}.${f}`, { system: systemName, tick });
          }
          continue;
        }
        const store = meta.store as ComponentStore;
        for (const f of fields) {
          const arr = store[f];
          if (!arr) continue;
          const afterVal = arr[eid] as number;
          const key = `${compName}.${f}`;
          const beforeVal = entry.scratch.get(key);
          if (!wasPresent || (beforeVal !== undefined && !Object.is(beforeVal, afterVal))) {
            entry.writers.set(key, { system: systemName, tick });
          }
        }
      }
    }
  }

  /** Drop watches whose TTL has elapsed so steady-state overhead stays zero. */
  pruneExpired(currentTick: number): void {
    for (const [wireId, entry] of this.watches) {
      if (currentTick > entry.expiresTick) this.watches.delete(wireId);
    }
  }

  lastWriterOf(wireId: bigint, component: string, field?: string): LiveWriterRecord | undefined {
    const entry = this.watches.get(wireId);
    if (!entry) return undefined;
    if (field !== undefined) return entry.writers.get(`${component}.${field}`);
    return entry.writers.get(component);
  }
}

/**
 * Selection-scoped Graphify H4 live overlay for one wire entity id.
 * Reuses `projectEntityComponents` so field values match `inspect` output.
 */
export function projectEntityOverlay(
  world: SimWorld,
  wireId: bigint,
  buildCommit: string | null = null,
  tracker?: EntityFieldTracker,
): LiveEntityOverlay | null {
  const eid = world.resolveWireId(wireId);
  if (eid < 0) return null;
  tracker?.watch(wireId, world.currentTick);
  const projected = projectEntityComponents(world, eid);
  return {
    wireId: wireId.toString(),
    slot: eid,
    tick: world.currentTick,
    buildCommit,
    components: projected.map((c) => ({
      component: c.component,
      ...(c.tag ? { tag: true } : {}),
      fields: c.fields.map((f) => {
        const lw = tracker?.lastWriterOf(wireId, c.component, f.name);
        return lw ? { name: f.name, value: f.value, lastWriter: lw } : { name: f.name, value: f.value };
      }),
    })),
  };
}
