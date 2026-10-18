/**
 * CrowdSystem — DetourCrowd steering for characters.
 *
 * Every character (Transform + Locomotion: players, bots, creatures) is an
 * agent in the navigation crowd, keyed by its wire id, so anything that
 * steers keeps clear of all of them. Characters with a NavAgent steer:
 * each tick the crowd plans their way to NavAgent's target along the
 * navmesh, round walls and each other (path following, corridor
 * optimisation, separation, velocity-obstacle avoidance), and this system
 * writes the result into their PlayerIntent. From there it's the same
 * road a player's input takes (IntentSystem, locomotion, grounding,
 * combat), so the simulation stays the authority on where everyone is:
 * the crowd is snapped to the simulation's positions before every update.
 *
 * Runs after the brains that set targets (BotSystem) and before
 * IntentSystem. Bulk only: one add, one target, one step call per tick at
 * most, over reused SoA scratch.
 */

import { defineQuery, hasComponent } from "bitecs";
import type { SimWorld } from "../world.js";
import type { SimSystem } from "../systems.js";
import { moveSpeedFactor, CHARACTER_CAPSULE } from "../systems.js";
import { Locomotion, NavAgent, NavAgentState, PlayerIntent, Transform } from "../components.js";
import type { CrowdBackend } from "./backend.js";

const characters = defineQuery([Transform, Locomotion]);

/** How hard a character can change speed, m/s². */
const MAX_ACCELERATION = 10;
/** Standing height the crowd uses for characters, m. */
const AGENT_HEIGHT = 2 * (CHARACTER_CAPSULE.halfHeight + CHARACTER_CAPSULE.radius);

export class CrowdSystem implements SimSystem {
  readonly name = "crowd";
  /** Agents in the crowd: wire id -> the speed it was added with. */
  private readonly members = new Map<bigint, number>();
  /** The NavAgent.seq each steering agent's current target came from. */
  private readonly seqs = new Map<bigint, number>();
  private cap = 0;
  private ids = new BigUint64Array(0);
  private eids = new Int32Array(0);
  private pos = new Float32Array(0);
  private vel = new Float32Array(0);
  private navPos = new Float32Array(0);
  private state = new Uint8Array(0);
  private radius = new Float32Array(0);
  private height = new Float32Array(0);
  private speed = new Float32Array(0);
  private accel = new Float32Array(0);
  private addIds = new BigUint64Array(0);
  private addPos = new Float32Array(0);
  private target = new Float32Array(0);
  private targetIds = new BigUint64Array(0);

  constructor(private readonly crowd: CrowdBackend) {}

  step(sim: SimWorld, dt: number): void {
    const found = characters(sim.ecs);
    const n = found.length;
    this.ensure(n);

    // Who's in the crowd now, and who's new or changed speed.
    const seen = new Set<bigint>();
    let adds = 0;
    for (let i = 0; i < n; i++) {
      const e = found[i] as number;
      const id = sim.wireId(e);
      seen.add(id);
      this.ids[i] = id;
      this.eids[i] = e;
      this.pos[i * 3] = Transform.px[e];
      this.pos[i * 3 + 1] = Transform.py[e];
      this.pos[i * 3 + 2] = Transform.pz[e];
      const speed = hasComponent(sim.ecs, NavAgent, e) && NavAgent.speed[e] > 0 ? NavAgent.speed[e] : sim.movement.walkSpeed;
      if (this.members.get(id) === speed) continue;
      this.members.set(id, speed);
      this.addIds[adds] = id;
      this.addPos.set(this.pos.subarray(i * 3, i * 3 + 3), adds * 3);
      this.speed[adds] = speed;
      adds++;
    }
    if (adds > 0) {
      this.crowd.add({
        count: adds,
        entityIds: this.addIds.subarray(0, adds),
        pos: this.addPos.subarray(0, adds * 3),
        radius: this.radius.subarray(0, adds),
        height: this.height.subarray(0, adds),
        maxSpeed: this.speed.subarray(0, adds),
        maxAcceleration: this.accel.subarray(0, adds),
      });
    }
    if (this.members.size > seen.size) {
      const gone: bigint[] = [];
      for (const id of this.members.keys()) if (!seen.has(id)) gone.push(id);
      for (const id of gone) {
        this.members.delete(id);
        this.seqs.delete(id);
      }
      this.crowd.remove(BigUint64Array.from(gone));
    }
    if (n === 0) return;

    // New targets.
    let targets = 0;
    for (let i = 0; i < n; i++) {
      const e = this.eids[i];
      if (!hasComponent(sim.ecs, NavAgent, e)) continue;
      const id = this.ids[i];
      if (this.seqs.get(id) === NavAgent.seq[e]) continue;
      this.seqs.set(id, NavAgent.seq[e]);
      this.targetIds[targets] = id;
      this.target[targets * 3] = NavAgent.tx[e];
      this.target[targets * 3 + 1] = NavAgent.ty[e];
      this.target[targets * 3 + 2] = NavAgent.tz[e];
      targets++;
    }
    if (targets > 0) {
      this.crowd.target({ count: targets, entityIds: this.targetIds.subarray(0, targets), target: this.target.subarray(0, targets * 3) });
    }

    // Snap to the simulation, update, read the steering back.
    this.crowd.step(
      dt,
      { count: n, entityIds: this.ids.subarray(0, n), pos: this.pos.subarray(0, n * 3) },
      { vel: this.vel.subarray(0, n * 3), pos: this.navPos.subarray(0, n * 3), state: this.state.subarray(0, n) },
    );

    for (let i = 0; i < n; i++) {
      const e = this.eids[i];
      if (!hasComponent(sim.ecs, NavAgent, e)) continue;
      const state = this.state[i];
      NavAgent.state[e] = state;
      if (!hasComponent(sim.ecs, PlayerIntent, e)) continue;
      if (state !== NavAgentState.Moving) {
        // Idle, arrived or stuck: stand. Off the mesh, leave the intent to
        // whoever set it (a brain walking straight where there's no navmesh).
        if (state !== NavAgentState.Invalid) {
          PlayerIntent.mx[e] = 0;
          PlayerIntent.mz[e] = 0;
        }
        continue;
      }
      // The crowd's velocity as intent: IntentSystem scales intent by the
      // walking speed (and the entity's move-speed stat), so divide it out.
      const full = sim.movement.walkSpeed * moveSpeedFactor(sim, e);
      if (full <= 0) continue;
      const vx = this.vel[i * 3];
      const vz = this.vel[i * 3 + 2];
      let mx = vx / full;
      let mz = vz / full;
      const m = Math.hypot(mx, mz);
      if (m > 1) {
        mx /= m;
        mz /= m;
      }
      PlayerIntent.mx[e] = mx;
      PlayerIntent.mz[e] = mz;
      if (Math.hypot(vx, vz) > 0.05) PlayerIntent.lookYaw[e] = Math.atan2(vx, vz);
    }
  }

  /** Agents in the crowd (tests, HUD). */
  get agentCount(): number {
    return this.members.size;
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    const c = Math.max(16, n * 2);
    this.cap = c;
    this.ids = new BigUint64Array(c);
    this.eids = new Int32Array(c);
    this.pos = new Float32Array(c * 3);
    this.vel = new Float32Array(c * 3);
    this.navPos = new Float32Array(c * 3);
    this.state = new Uint8Array(c);
    this.radius = new Float32Array(c).fill(CHARACTER_CAPSULE.radius);
    this.height = new Float32Array(c).fill(AGENT_HEIGHT);
    this.speed = new Float32Array(c);
    this.accel = new Float32Array(c).fill(MAX_ACCELERATION);
    this.addIds = new BigUint64Array(c);
    this.addPos = new Float32Array(c * 3);
    this.target = new Float32Array(c * 3);
    this.targetIds = new BigUint64Array(c);
  }
}
