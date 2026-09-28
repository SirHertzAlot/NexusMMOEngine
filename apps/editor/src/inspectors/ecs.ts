/**
 * EcsInspector — read-only view-model over the authoritative server's entities.
 *
 * WHY THIS INSPECTOR IS READ-ONLY (and must stay that way):
 *
 * The simulation is authoritative on the server: every entity exists because a
 * validated server tick produced it, and every change to it passes through the
 * server's validation, ownership checks, event ordering, and deterministic
 * tick loop. Editing an entity from the editor would bypass all of that — the
 * server would keep simulating the *real* entity while the editor pretended a
 * different one existed, desynchronizing every connected client, the physics
 * pipeline, and the tick history. The only legal upstream channel for
 * influencing entities is the intent protocol (player inputs), which the
 * server validates and applies on its own schedule. This class therefore
 * exposes no mutation methods by construction: it projects a read-only
 * snapshot into display rows, and the UI layer must not add setters behind
 * its back.
 *
 * Pure TypeScript, no React, no DOM. The constructor takes a
 * `() => EntitySnapshot` provider so the class never depends on the live
 * {@link MirrorState} from `@mmo-engine/client` (a separate app); the React
 * shell adapts the mirror into this shape, and tests inject fakes.
 */

/** Component kinds the inspector can display, in canonical order. */
export type ComponentKind =
  | "transform"
  | "velocity"
  | "intent"
  | "chunk"
  | "health"
  | "body";

/** Field shapes mirror the @mmo-engine/protocol row types, trimmed to what
 * the inspector displays. wireId lives on the parent EntityView. */
export interface TransformView {
  px: number; py: number; pz: number;
  qx: number; qy: number; qz: number; qw: number;
  sx: number; sy: number; sz: number;
}

export interface VelocityView {
  lx: number; ly: number; lz: number;
  ax: number; ay: number; az: number;
}

export interface IntentView {
  mx: number; my: number; mz: number;
  lookYaw: number; lookPitch: number;
  jump: boolean; buttons: number;
}

export interface ChunkView {
  chunkId: bigint; seed: bigint; lod: number;
}

export interface HealthView {
  current: number; max: number;
}

export interface BodyView {
  shapeKind: number;
  halfX: number; halfY: number; halfZ: number;
  radius: number;
  mass: number;
  motionType: number;
  layer: number;
  friction: number;
  restitution: number;
}

/** One entity as seen by the inspector: its wire id plus optional rows. */
export interface EntityView {
  wireId: bigint;
  transform?: TransformView;
  velocity?: VelocityView;
  intent?: IntentView;
  chunk?: ChunkView;
  health?: HealthView;
  body?: BodyView;
}

/** One authoritative tick's worth of entities, as handed to the inspector. */
export interface EntitySnapshot {
  tick: number;
  entities: ReadonlyMap<bigint, EntityView>;
}

/** Filter for the entity list. */
export interface EntityFilter {
  /** Matches the wire-id decimal string (case-insensitive substring). */
  text?: string;
  /** Entity must carry ALL of these components. */
  components?: ComponentKind[];
}

/** One row of the entity list. */
export interface EntityRow {
  /** Wire id as a decimal string (bigints don't survive JSON/UI directly). */
  wireId: string;
  /** Components present on the entity, in canonical order. */
  components: ComponentKind[];
  /** Short human summary, e.g. `E42 · T(1.235,2,3) · HP 80/100`. */
  label: string;
}

/** One displayable key/value pair inside a component. */
export interface FieldEntry {
  key: string;
  value: string;
}

/** One component of a selected entity, projected for display. */
export interface ComponentView {
  component: ComponentKind;
  fields: FieldEntry[];
}

/** Canonical component order, used for `components` lists and projections. */
const COMPONENT_ORDER: readonly ComponentKind[] = [
  "transform",
  "velocity",
  "intent",
  "chunk",
  "health",
  "body",
];

function hasComponent(view: EntityView, kind: ComponentKind): boolean {
  return view[kind] !== undefined;
}

function presentComponents(view: EntityView): ComponentKind[] {
  return COMPONENT_ORDER.filter((kind) => hasComponent(view, kind));
}

/** Round to 3 decimals for display fields. Normalizes -0 to 0. */
function fmtNum(n: number): string {
  if (n === 0) return "0.000";
  return n.toFixed(3);
}

/** 3-decimal rounding, trailing zeros trimmed — for compact labels. */
function fmtShort(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded === 0 ? 0 : rounded);
}

function projectTransform(t: TransformView): FieldEntry[] {
  return [
    { key: "px", value: fmtNum(t.px) },
    { key: "py", value: fmtNum(t.py) },
    { key: "pz", value: fmtNum(t.pz) },
    { key: "qx", value: fmtNum(t.qx) },
    { key: "qy", value: fmtNum(t.qy) },
    { key: "qz", value: fmtNum(t.qz) },
    { key: "qw", value: fmtNum(t.qw) },
    { key: "sx", value: fmtNum(t.sx) },
    { key: "sy", value: fmtNum(t.sy) },
    { key: "sz", value: fmtNum(t.sz) },
  ];
}

function projectVelocity(v: VelocityView): FieldEntry[] {
  return [
    { key: "lx", value: fmtNum(v.lx) },
    { key: "ly", value: fmtNum(v.ly) },
    { key: "lz", value: fmtNum(v.lz) },
    { key: "ax", value: fmtNum(v.ax) },
    { key: "ay", value: fmtNum(v.ay) },
    { key: "az", value: fmtNum(v.az) },
  ];
}

function projectIntent(i: IntentView): FieldEntry[] {
  return [
    { key: "mx", value: fmtNum(i.mx) },
    { key: "my", value: fmtNum(i.my) },
    { key: "mz", value: fmtNum(i.mz) },
    { key: "lookYaw", value: fmtNum(i.lookYaw) },
    { key: "lookPitch", value: fmtNum(i.lookPitch) },
    { key: "jump", value: String(i.jump) },
    { key: "buttons", value: String(i.buttons) },
  ];
}

function projectChunk(c: ChunkView): FieldEntry[] {
  return [
    { key: "chunkId", value: c.chunkId.toString() },
    { key: "seed", value: c.seed.toString() },
    { key: "lod", value: fmtNum(c.lod) },
  ];
}

function projectHealth(h: HealthView): FieldEntry[] {
  return [
    { key: "current", value: fmtNum(h.current) },
    { key: "max", value: fmtNum(h.max) },
  ];
}

function projectBody(b: BodyView): FieldEntry[] {
  return [
    { key: "shapeKind", value: String(b.shapeKind) },
    { key: "halfX", value: fmtNum(b.halfX) },
    { key: "halfY", value: fmtNum(b.halfY) },
    { key: "halfZ", value: fmtNum(b.halfZ) },
    { key: "radius", value: fmtNum(b.radius) },
    { key: "mass", value: fmtNum(b.mass) },
    { key: "motionType", value: String(b.motionType) },
    { key: "layer", value: String(b.layer) },
    { key: "friction", value: fmtNum(b.friction) },
    { key: "restitution", value: fmtNum(b.restitution) },
  ];
}

/**
 * Read-only ECS entity browser over one authoritative snapshot.
 *
 * The snapshot provider is called fresh on every method, so the inspector
 * always reflects the latest tick the shell has handed it. There are no
 * mutation methods on purpose — see the file header for why.
 */
export class EcsInspector {
  /**
   * One-paragraph explanation the UI shows in the inspector, so users know
   * why they can look but not touch.
   */
  readonly readonlyNotice: string =
    "This inspector is read-only by design. Entities belong to the " +
    "authoritative server simulation: mutating one here would bypass server " +
    "validation, ownership checks, event ordering, and the deterministic " +
    "tick, desynchronizing every client and the physics pipeline. The only " +
    "legal way to influence an entity is the intent protocol (player " +
    "inputs), which the server validates and applies on its own schedule. " +
    "Use this view to observe and debug the world — never to change it.";

  constructor(private readonly snapshotProvider: () => EntitySnapshot) {}

  /**
   * List entities matching the filter, sorted by wire id ascending.
   * Text matches the wire-id decimal substring (case-insensitive);
   * `components` requires ALL listed components to be present.
   * Single pass over the snapshot: O(n log n) for the sort, no O(n²).
   */
  listEntities(filter: EntityFilter): EntityRow[] {
    const snapshot = this.snapshotProvider();
    const text = (filter.text ?? "").trim().toLowerCase();
    const required = filter.components ?? [];

    const matched: EntityView[] = [];
    for (const view of snapshot.entities.values()) {
      let ok = true;
      for (const kind of required) {
        if (!hasComponent(view, kind)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (
        text !== "" &&
        !view.wireId.toString().toLowerCase().includes(text)
      ) {
        continue;
      }
      matched.push(view);
    }

    matched.sort((a, b) => (a.wireId < b.wireId ? -1 : a.wireId > b.wireId ? 1 : 0));

    return matched.map((view) => ({
      wireId: view.wireId.toString(),
      components: presentComponents(view),
      label: this.buildLabel(view),
    }));
  }

  /**
   * Project one entity's present components into displayable field lists.
   * Numbers are rounded to 3 decimals; bigints are decimal strings.
   * Returns undefined when no entity has that wire id (or it isn't a
   * valid decimal id).
   */
  getEntity(wireId: string): ComponentView[] | undefined {
    let wid: bigint;
    try {
      wid = BigInt(wireId);
    } catch {
      return undefined;
    }
    const view = this.snapshotProvider().entities.get(wid);
    if (!view) return undefined;

    const out: ComponentView[] = [];
    if (view.transform) {
      out.push({ component: "transform", fields: projectTransform(view.transform) });
    }
    if (view.velocity) {
      out.push({ component: "velocity", fields: projectVelocity(view.velocity) });
    }
    if (view.intent) {
      out.push({ component: "intent", fields: projectIntent(view.intent) });
    }
    if (view.chunk) {
      out.push({ component: "chunk", fields: projectChunk(view.chunk) });
    }
    if (view.health) {
      out.push({ component: "health", fields: projectHealth(view.health) });
    }
    if (view.body) {
      out.push({ component: "body", fields: projectBody(view.body) });
    }
    return out;
  }

  /** Last authoritative tick the provider's snapshot was taken at. */
  getTick(): number {
    return this.snapshotProvider().tick;
  }

  /** Number of entities in the provider's current snapshot. */
  getEntityCount(): number {
    return this.snapshotProvider().entities.size;
  }

  private buildLabel(view: EntityView): string {
    const parts: string[] = [`E${view.wireId.toString()}`];
    if (view.transform) {
      const t = view.transform;
      parts.push(`T(${fmtShort(t.px)},${fmtShort(t.py)},${fmtShort(t.pz)})`);
    }
    if (view.velocity) {
      const v = view.velocity;
      parts.push(`V(${fmtShort(v.lx)},${fmtShort(v.ly)},${fmtShort(v.lz)})`);
    }
    if (view.intent) {
      const i = view.intent;
      parts.push(`I(${fmtShort(i.mx)},${fmtShort(i.my)},${fmtShort(i.mz)})`);
    }
    if (view.chunk) {
      parts.push(`Chunk(${view.chunk.chunkId.toString()})`);
    }
    if (view.health) {
      parts.push(`HP ${fmtShort(view.health.current)}/${fmtShort(view.health.max)}`);
    }
    if (view.body) {
      parts.push(`Body(shape=${view.body.shapeKind},mass=${fmtShort(view.body.mass)})`);
    }
    return parts.join(" · ");
  }
}
