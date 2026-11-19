/**
 * 0x28 FX presentation messages — S→C JSON control-plane.
 * [PROPOSED, PR1] packages/protocol/src/fx.ts
 *
 * Self-contained wire types: ParamValue/EffectBinding shapes are duplicated
 * here (not imported from @mmo-engine/render-fx) so the protocol package
 * keeps zero new dependencies. Keep in sync with
 * packages/render-fx/src/types.ts (static-assert tests in PR1 cover both).
 *
 * Server owns ability validity, phase transitions, projectile paths,
 * damage/shield HP, and shared sequence state. The client owns cosmetic
 * age, particle seeds, and camera. Particles are never replicated.
 */

/** Closed parameter value union (mirrors render-fx ParamValue). */
export type FxParamValue = number | [number, number, number] | string | number[];

export type FxBindingKind = "local" | "world" | "entity" | "socket";

/** Wire binding: entityId is the protocol wire-id string (u64-as-string). */
export interface FxBinding {
  kind: FxBindingKind;
  entityId?: string;
  socket?: string;
  offset?: [number, number, number];
  pos?: [number, number, number];
  normal?: [number, number, number];
}

export type FxPhase = "charge" | "release" | "travel" | "impact" | "active" | "hit" | "shutdown";

/** S→C transient spawn (oneshots + persistent activation). */
export interface FxSpawn {
  kind: "fx-spawn";
  /** Dedupe key (uuid); ordering is by (tick, seq). */
  fxId: string;
  tick: number;
  seq: number;
  assetId: string;
  assetVersion: 1;
  seed: number;
  binding: FxBinding;
  /** Authoritative phase at spawn. */
  phase: FxPhase;
  params?: Record<string, FxParamValue>;
}

/** S→C phase advance / param set (e.g. charge01, hp01, hit slot). */
export interface FxUpdate {
  kind: "fx-update";
  fxId: string;
  tick: number;
  seq: number;
  phase?: FxPhase;
  params?: Record<string, FxParamValue>;
  /** Hit point in object space (client does worldToLocal); server also sends the normal. */
  hit?: { pos: [number, number, number]; normal?: [number, number, number] };
}

/** S→C interrupt/cancel. */
export interface FxKill {
  kind: "fx-kill";
  fxId: string;
  tick: number;
  seq: number;
  /** Seconds of fade; 0 = hard cut. */
  fade: number;
}

/** S→C persistent rows carried in snapshot/delta alongside Action. */
export interface FxState {
  entity: string;
  assetId: string;
  assetVersion: 1;
  startTick: number;
  seed: number;
  hp01?: number;
  active: boolean;
}

export type FxMessage = FxSpawn | FxUpdate | FxKill;

const FX_KINDS: readonly string[] = ["fx-spawn", "fx-update", "fx-kill"] as const;

/** Type guard for inbound 0x28 payloads. */
export function isFxMessage(msg: unknown): msg is FxMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const kind = (msg as { kind?: unknown }).kind;
  return typeof kind === "string" && (FX_KINDS as readonly string[]).includes(kind);
}

/**
 * Authoritative ordering: greater (tick, seq) supersedes. Returns <0/0/>0
 * like a comparator: negative when a sorts before b.
 */
export function compareFxOrder(a: { tick: number; seq: number }, b: { tick: number; seq: number }): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  return a.seq - b.seq;
}

/**
 * Cosmetic presentation age in seconds for a spawn tick at 30 Hz.
 * Late/duplicate arrivals seek oneshots to the authoritative phase.
 */
export function fxSpawnAgeSeconds(spawnTick: number, clientTick: number, tickHz = 30): number {
  return Math.max(0, (clientTick - spawnTick) / tickHz);
}

/**
 * Bounded dedupe set for fxId replay suppression (LRU, default cap 512).
 * Returns true when the id was already seen (duplicate), false when newly recorded.
 */
export class FxDedupe {
  private readonly seen = new Map<string, number>();
  constructor(private readonly cap = 512) {}

  /** Record an fxId; true = duplicate (already seen). */
  check(fxId: string, tick: number): boolean {
    const prev = this.seen.get(fxId);
    if (prev !== undefined) return true;
    this.seen.set(fxId, tick);
    if (this.seen.size > this.cap) {
      let oldestKey: string | null = null;
      let oldestTick = Infinity;
      for (const [key, value] of this.seen) {
        if (value < oldestTick) {
          oldestTick = value;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) this.seen.delete(oldestKey);
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}


