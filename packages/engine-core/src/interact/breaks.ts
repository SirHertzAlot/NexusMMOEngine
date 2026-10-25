/**
 * BreakSystem (IX4, IX5): props that break. An archetype with `breakable` spawns with
 * Health and the Breakable tag (scatter-spawn); a scene node registers with `register`.
 * Combat already hurts anything with Health and DeathSystem skips the tag, so at zero it
 * is this system's turn:
 *
 * - "remove": the entity goes.
 * - "variant": it stays, broken: its AssetRef variant becomes BROKEN_VARIANT (the
 *   client draws it lowered), its collider and health go, and it is no longer breakable.
 * - "debris": it goes and the `debris` archetype stands in its place.
 *
 * In every case the archetype's `loot` table is rolled at the spot for whoever dealt the
 * last blow. With `respawnS` the prop comes back that many seconds later (a removed one
 * is spawned again from what it was, a broken one is whole again); without it, it stays
 * broken, and with `repair` (a building: `minStrength` keeps weak players from hurting it) it can be mended: E on the ruin
 * spends pouch materials over a cast and makes it whole. A keyed prop (a scene node: `places/P0001`) is saved to the places store when
 * it breaks, and `register` applies the record after a restart, so a break survives it.
 */

import { addComponent, defineQuery, hasComponent, removeComponent } from "bitecs";
import { fnv1a32 } from "@mmo-engine/scatter";
import type { Breakable as BreakableDef, SpawnTable } from "@mmo-engine/scatter";
import { BROKEN_VARIANT } from "@mmo-engine/protocol";
import { AssetRef, BodyConfig, Breakable, Health, Transform, Velocity } from "../components.js";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import type { PlacesStore } from "./places-store.js";
import type { ChestView } from "@mmo-engine/protocol";

/** What a break tells the host: where, what it was, what it breaks into, and who dealt the last blow. */
export interface BreakEvent {
  eid: number;
  x: number;
  z: number;
  /** The archetype's loot table, if it has one. */
  loot?: string;
  killer?: number;
}

export interface BreakSystemOptions {
  /** The entity that dealt `e`'s last blow, if known. */
  killerOf?: (e: number) => number | undefined;
  /** A prop broke: roll its loot, count it, tell the run. Called before the entity changes. Not called when a record is re-applied on boot. */
  onBreak?: (sim: SimWorld, ev: BreakEvent) => void;
  /** Stand the `debris` archetype where a prop was; returns the debris entity so a respawn can clear it. */
  spawnDebris?: (sim: SimWorld, debris: string, x: number, y: number, z: number, yaw: number) => number | void;
  /** Where breaks of keyed props are kept (IX5). */
  store?: PlacesStore;
  /** The pouch materials a repair spends (IX6). */
  materials?: { count(holder: number, material: string): number; spend(holder: number, material: string, n: number): boolean };
  /** How close to a ruin's edge a mender must stand, metres. Default 3. */
  repairReachM?: number;
  now?: () => number;
}

/** The breakable archetypes of spawn tables, by the hash of the asset id an entity's AssetRef carries. */
export function breakDefsOf(...tables: Array<SpawnTable | undefined>): Map<number, BreakableDef> {
  const out = new Map<number, BreakableDef>();
  for (const t of tables) {
    if (!t) continue;
    for (const [id, a] of Object.entries(t.archetypes)) {
      if (!a.breakable) continue;
      out.set(fnv1a32(id) >>> 0, a.breakable);
      out.set(fnv1a32(a.asset) >>> 0, a.breakable);
    }
  }
  return out;
}

const TF = ["px", "py", "pz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"] as const;
const BODY = ["shapeKind", "halfX", "halfY", "halfZ", "radius", "mass", "motionType", "layer", "friction", "restitution"] as const;

/** Everything needed to put a prop back as it was. */
interface Snap {
  tf: number[];
  assetHash: number;
  variant: number;
  body: number[] | null;
  hp: number;
}

interface Ruin {
  key: string | null;
  def: BreakableDef;
  snap: Snap;
}

export type RepairCheck = { ok: true; castSeconds: number; spell: string } | { ok: false; error: string };
export type RepairResult = { ok: true } | { ok: false; error: string };

interface Pending {
  key: string | null;
  def: BreakableDef;
  snap: Snap;
  respawnAt: number;
  /** "variant": the broken entity itself. */
  eid: number | null;
  /** "debris": the debris that stands there meanwhile. */
  debris: number | null;
}

export class BreakSystem implements SimSystem {
  readonly name = "breaks";
  private readonly bodies = defineQuery([Transform, Health, Breakable]);
  private readonly keys = new Map<number, string>();
  private readonly eidDefs = new Map<number, BreakableDef>();
  private pending: Pending[] = [];
  /** Buildings that stand broken and can be mended, by entity. */
  private readonly ruins = new Map<number, Ruin>();
  private changed = new Set<number>();
  private readonly now: () => number;
  /** Props broken so far (a run's or the world's tally). */
  broken = 0;

  constructor(
    private readonly defs: ReadonlyMap<number, BreakableDef>,
    private readonly opts: BreakSystemOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Make a spawned entity (a scene node) breakable under `key`, with `def`, and apply what the places
   * store remembers of it: broken and not yet back, it breaks again now, silently; back by now, it is whole.
   */
  register(sim: SimWorld, eid: number, key: string, def: BreakableDef): void {
    if (!hasComponent(sim.ecs, Health, eid)) addComponent(sim.ecs, Health, eid);
    Health.current[eid] = Health.max[eid] = def.health;
    addComponent(sim.ecs, Breakable, eid);
    this.keys.set(eid, key);
    this.eidDefs.set(eid, def);
    const rec = this.opts.store?.load("break", key);
    if (!rec) return;
    if (rec.respawnAt !== null && this.now() >= rec.respawnAt) {
      this.opts.store!.clear("break", key); // it came back while the server was down
      return;
    }
    this.breakIt(sim, eid, def, { at: rec.at, respawnAt: rec.respawnAt });
  }

  private recovered = false;

  /** Once after a boot: scatter props that broke before the restart are put back on their timers (their def is found by asset). */
  private recover(sim: SimWorld): void {
    this.recovered = true;
    for (const rec of this.opts.store?.all?.() ?? []) {
      if (rec.kind !== "break" || !rec.state.startsWith("scatter:") || rec.respawnAt === null) continue;
      let snap: Snap;
      try {
        snap = JSON.parse(rec.state.slice("scatter:".length)) as Snap;
      } catch {
        this.opts.store!.clear("break", rec.key);
        continue;
      }
      const def = this.defs.get(snap.assetHash >>> 0);
      if (!def) continue;
      this.pending.push({ key: rec.key, def, snap, respawnAt: rec.respawnAt, eid: null, debris: null });
    }
  }

  step(sim: SimWorld): void {
    if (!this.recovered) this.recover(sim);
    this.respawns(sim);
    for (const eid of this.bodies(sim.ecs)) {
      if (Health.current[eid]! > 0) continue;
      const def = this.eidDefs.get(eid) ?? this.defs.get(AssetRef.assetHash[eid]! >>> 0);
      if (!def) {
        removeComponent(sim.ecs, Breakable, eid); // no data for it: leave it be
        continue;
      }
      this.breakIt(sim, eid, def);
    }
  }

  /** `again`: a record being re-applied on boot (no loot, no event, the recorded times). */
  private breakIt(sim: SimWorld, eid: number, def: BreakableDef, again?: { at: number; respawnAt: number | null }): void {
    const x = Transform.px[eid]!;
    const y = Transform.py[eid]!;
    const z = Transform.pz[eid]!;
    const key = this.keys.get(eid) ?? null;
    const at = again?.at ?? this.now();
    const respawnAt = again ? again.respawnAt : def.respawnS !== null ? at + def.respawnS * 1000 : null;
    this.broken++;
    if (!again) this.opts.onBreak?.(sim, { eid, x, z, ...(def.loot !== undefined ? { loot: def.loot } : {}), killer: this.opts.killerOf?.(eid) });
    if (key !== null) this.opts.store?.save({ kind: "break", key, state: "broken", at, respawnAt });
    const snap = respawnAt !== null || def.repair ? capture(sim, eid) : null;
    // A world scatter prop has no scene key: it is found again after a restart by what it was and where it stood.
    const scatterKey = key === null && snap && respawnAt !== null && def.into !== "variant" ? `scatter/${snap.assetHash}/${x.toFixed(1)},${z.toFixed(1)}` : null;
    if (scatterKey !== null && !again) this.opts.store?.save({ kind: "break", key: scatterKey, state: `scatter:${JSON.stringify(snap)}`, at, respawnAt });
    let debris: number | null = null;
    this.keys.delete(eid);
    this.eidDefs.delete(eid);
    if (def.into === "variant") {
      AssetRef.variant[eid] = BROKEN_VARIANT;
      removeComponent(sim.ecs, BodyConfig, eid);
      removeComponent(sim.ecs, Health, eid);
      removeComponent(sim.ecs, Breakable, eid);
    } else {
      sim.despawn(eid);
      if (def.into === "debris" && def.debris) {
        const made = this.opts.spawnDebris?.(sim, def.debris, x, y, z, 2 * Math.atan2(Transform.qy[eid]!, Transform.qw[eid]!));
        debris = typeof made === "number" ? made : null;
      }
    }
    if (snap && def.repair && def.into === "variant") {
      this.ruins.set(eid, { key, def, snap });
      this.changed.add(eid);
    }
    if (snap && respawnAt !== null) this.pending.push({ key: key ?? scatterKey, def, snap, respawnAt, eid: def.into === "variant" ? eid : null, debris });
  }

  /** Whether a blow from `attacker` can hurt `target`: a building holds out against anyone below its `minStrength` (bodies with no stats pass). */
  canHit(sim: SimWorld, attacker: number, target: number): boolean {
    const need = this.eidDefs.get(target)?.minStrength;
    if (!need) return true;
    const str = sim.stats.get(attacker, "strength");
    return str === undefined || str >= need;
  }

  /** What a blow of `kind` does to `target`, as a multiple: its `damageMultipliers` entry (1 when it has none, or is not breakable). */
  kindScale(target: number, kind: string): number {
    return this.eidDefs.get(target)?.damageMultipliers?.[kind] ?? this.defs.get(AssetRef.assetHash[target]! >>> 0)?.damageMultipliers?.[kind] ?? 1;
  }

  hasRuin(eid: number): boolean {
    return this.ruins.has(eid);
  }

  /** Whether `holder` at `avatar` may mend ruin `eid` now, and how long it takes. Changes nothing. */
  checkRepair(holder: number, avatar: number, eid: number): RepairCheck {
    const r = this.ruins.get(eid);
    if (!r) return { ok: false, error: "nothing to repair there" };
    const body = r.snap.body;
    const dx = Math.max(0, Math.abs(Transform.px[eid]! - Transform.px[avatar]!) - (body ? body[1]! : 0));
    const dz = Math.max(0, Math.abs(Transform.pz[eid]! - Transform.pz[avatar]!) - (body ? body[3]! : 0));
    const reach = this.opts.repairReachM ?? 3;
    if (dx * dx + dz * dz > reach * reach) return { ok: false, error: "too far away" };
    const need = r.def.repair!;
    if ((this.opts.materials?.count(holder, need.material) ?? 0) < need.count) return { ok: false, error: `mending it takes ${need.count} ${need.material}` };
    return { ok: true, castSeconds: need.castSeconds, spell: "repair" };
  }

  /** Mend ruin `eid`: the same checks again, then the materials go and the building stands whole. */
  repair(sim: SimWorld, holder: number, avatar: number, eid: number): RepairResult {
    const ok = this.checkRepair(holder, avatar, eid);
    if (!ok.ok) return ok;
    const r = this.ruins.get(eid)!;
    const need = r.def.repair!;
    if (!(this.opts.materials?.spend(holder, need.material, need.count) ?? false)) return { ok: false, error: `mending it takes ${need.count} ${need.material}` };
    restore(sim, eid, r.snap, true);
    this.eidDefs.set(eid, r.def);
    if (r.key !== null) {
      this.keys.set(eid, r.key);
      this.opts.store?.clear("break", r.key);
    }
    // A respawn timer, if it had one, no longer applies.
    this.pending = this.pending.filter((p) => p.eid !== eid);
    this.ruins.delete(eid);
    this.changed.add(eid);
    return { ok: true };
  }

  private view(eid: number, sim: SimWorld): ChestView {
    return { entity: String(sim.wireId(eid)), x: Transform.px[eid]!, z: Transform.pz[eid]!, open: !this.ruins.has(eid), kind: "ruin" };
  }

  /** Every ruin, for a player joining. */
  views(sim: SimWorld): ChestView[] {
    return [...this.ruins.keys()].map((e) => this.view(e, sim));
  }

  /** The ruins that appeared or were mended since the last drain (a mended one comes back `open`: no longer a target). */
  drainChanges(sim: SimWorld): ChestView[] {
    if (this.changed.size === 0) return [];
    const out = [...this.changed].map((e) => this.view(e, sim));
    this.changed = new Set();
    return out;
  }

  /** Props whose time has come are back. */
  private respawns(sim: SimWorld): void {
    if (this.pending.length === 0) return;
    const now = this.now();
    const later: Pending[] = [];
    for (const p of this.pending) {
      if (now < p.respawnAt) {
        later.push(p);
        continue;
      }
      if (p.debris !== null) sim.despawn(p.debris);
      if (p.eid !== null && this.ruins.delete(p.eid)) this.changed.add(p.eid);
      const eid = p.eid !== null ? p.eid : sim.spawn();
      restore(sim, eid, p.snap, p.eid !== null);
      this.eidDefs.set(eid, p.def);
      if (p.key !== null) {
        if (!p.key.startsWith("scatter/")) this.keys.set(eid, p.key);
        this.opts.store?.clear("break", p.key);
      }
    }
    this.pending = later;
  }
}

function capture(sim: SimWorld, eid: number): Snap {
  return {
    tf: TF.map((f) => Transform[f][eid]!),
    assetHash: AssetRef.assetHash[eid]!,
    variant: AssetRef.variant[eid]!,
    body: hasComponent(sim.ecs, BodyConfig, eid) ? BODY.map((f) => BodyConfig[f][eid]!) : null,
    hp: Health.max[eid]!,
  };
}

/** Put a prop back: onto its own entity (`existing`: it was left standing broken) or a new one. */
function restore(sim: SimWorld, eid: number, s: Snap, existing: boolean): void {
  if (!existing) {
    addComponent(sim.ecs, Transform, eid);
    TF.forEach((f, i) => (Transform[f][eid] = s.tf[i]!));
    addComponent(sim.ecs, AssetRef, eid);
    AssetRef.assetHash[eid] = s.assetHash;
  }
  AssetRef.variant[eid] = s.variant;
  if (s.body && !hasComponent(sim.ecs, BodyConfig, eid)) {
    addComponent(sim.ecs, Velocity, eid);
    Velocity.lx[eid] = Velocity.ly[eid] = Velocity.lz[eid] = Velocity.ax[eid] = Velocity.ay[eid] = Velocity.az[eid] = 0;
    addComponent(sim.ecs, BodyConfig, eid);
    BODY.forEach((f, i) => (BodyConfig[f][eid] = s.body![i]!));
  }
  if (!hasComponent(sim.ecs, Health, eid)) addComponent(sim.ecs, Health, eid);
  Health.current[eid] = Health.max[eid] = s.hp;
  addComponent(sim.ecs, Breakable, eid);
}
