/**
 * The rig overrides document (`content/rigs.local.json`, gitignored: its keys
 * are licensed catalog model ids). Browser-safe and pure: the schema, its
 * validator and the edits the Rig view makes, each returning a new document
 * so `useDocument` history and the tests see the same thing.
 *
 * One entry per catalog model id; everything optional, an absent field means
 * "what the automatic rig found". Angles are degrees, lengths metres in the
 * rig's own frame (+Z forward, +Y up, feet on y = 0).
 *
 *   bodyPlan   "quadruped" (the automatic shape-cut rig, default for static meshes)
 *              or "skinned" (use the bones the file already has)
 *   headSign   +1 / -1: which end of the spine is the head (SegmentHints.headSign)
 *   legTop     fraction of the height where the legs end (SegmentHints.legTop)
 *   knee       fraction of the hip height where the knee sits (SegmentHints.knee)
 *   limits     per chain, named by its tip bone: a two-bone limb's knee angle range
 *              [min, max] (interior angle, 180 is straight); for a longer chain,
 *              max is the largest bend at any joint (min unused); an aim chain has none
 *   targets    per chain (named by its tip bone): the authored IK pose.
 *              offset = where the tip goes, as a displacement from its rest position,
 *              pole = the direction the knee points, weight = IK vs procedural blend
 *              (0 the gait alone, 1 the authored pose alone)
 *   inactive   bones switched off: they hold the rest pose
 */

export const RIG_VERSION = 1;

export interface RigLimit {
  min: number;
  max: number;
}
export type Triple = [number, number, number];
export interface RigTarget {
  offset: Triple;
  pole?: Triple;
  weight: number;
}
export interface ModelRig {
  bodyPlan?: "quadruped" | "skinned";
  headSign?: 1 | -1;
  legTop?: number;
  knee?: number;
  limits?: Record<string, RigLimit>;
  targets?: Record<string, RigTarget>;
  inactive?: string[];
}
export interface RigDoc {
  version: 1;
  models: Record<string, ModelRig>;
}
export interface RigIssue {
  path: string;
  message: string;
}

/** A knee: never folded flat; straight is allowed (a standing leg), the pole keeps it from bending backwards. */
export const DEFAULT_LIMIT: RigLimit = { min: 25, max: 180 };
export const MAX_MODELS = 5000;
export const MAX_NAMES = 128;

export const emptyRigs = (): RigDoc => ({ version: RIG_VERSION, models: {} });
export const modelRig = (doc: RigDoc, id: string): ModelRig => doc.models[id] ?? {};

const ID = /^[A-Za-z0-9_\-./]{1,200}$/;
const NAME = /^[A-Za-z0-9_\-. ]{1,64}$/;
const BODY_PLANS = ["quadruped", "skinned"];
const RIG_KEYS = ["bodyPlan", "headSign", "legTop", "knee", "limits", "targets", "inactive"];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const triple = (x: unknown): x is Triple => Array.isArray(x) && x.length === 3 && x.every(num);

export function validateRigs(doc: unknown): RigIssue[] {
  const issues: RigIssue[] = [];
  const bad = (path: string, message: string): void => void issues.push({ path, message });
  if (!isObject(doc)) return [{ path: "", message: "must be an object" }];
  for (const k of Object.keys(doc)) if (k !== "version" && k !== "models") bad(k, "unknown field");
  if (doc.version !== RIG_VERSION) bad("version", `must be ${RIG_VERSION}`);
  if (!isObject(doc.models)) {
    bad("models", "must be an object");
    return issues;
  }
  const ids = Object.keys(doc.models);
  if (ids.length > MAX_MODELS) bad("models", `at most ${MAX_MODELS} models`);
  for (const id of ids) {
    const at = `models.${id}`;
    if (!ID.test(id) || id.includes("..") || id.startsWith("/")) {
      bad(at, "model id must be 1-200 characters of letters, digits and _ - . / (no .. or leading /)");
      continue;
    }
    const rig = doc.models[id];
    if (!isObject(rig)) {
      bad(at, "must be an object");
      continue;
    }
    for (const k of Object.keys(rig)) if (!RIG_KEYS.includes(k)) bad(`${at}.${k}`, "unknown field");
    if (rig.bodyPlan !== undefined && !BODY_PLANS.includes(rig.bodyPlan as string)) bad(`${at}.bodyPlan`, `must be ${BODY_PLANS.join(" or ")}`);
    if (rig.headSign !== undefined && rig.headSign !== 1 && rig.headSign !== -1) bad(`${at}.headSign`, "must be 1 or -1");
    if (rig.legTop !== undefined && !(num(rig.legTop) && rig.legTop >= 0.1 && rig.legTop <= 0.9)) bad(`${at}.legTop`, "must be a number from 0.1 to 0.9");
    if (rig.knee !== undefined && !(num(rig.knee) && rig.knee >= 0.05 && rig.knee <= 0.95)) bad(`${at}.knee`, "must be a number from 0.05 to 0.95");
    if (rig.limits !== undefined) {
      if (!isObject(rig.limits)) bad(`${at}.limits`, "must be an object keyed by bone name");
      else
        for (const [bone, l] of Object.entries(rig.limits)) {
          const p = `${at}.limits.${bone}`;
          if (!NAME.test(bone)) bad(p, "bone name must be 1-64 characters of letters, digits and _ - . space");
          else if (!isObject(l)) bad(p, "must be { min, max }");
          else {
            if (!(num(l.min) && l.min >= 0 && l.min <= 180)) bad(`${p}.min`, "must be 0 to 180 degrees");
            if (!(num(l.max) && l.max >= 0 && l.max <= 180)) bad(`${p}.max`, "must be 0 to 180 degrees");
            if (num(l.min) && num(l.max) && l.min >= l.max) bad(p, "min must be below max");
          }
        }
    }
    if (rig.targets !== undefined) {
      if (!isObject(rig.targets)) bad(`${at}.targets`, "must be an object keyed by chain (tip bone) name");
      else
        for (const [chain, t] of Object.entries(rig.targets)) {
          const p = `${at}.targets.${chain}`;
          if (!NAME.test(chain)) bad(p, "chain name must be 1-64 characters of letters, digits and _ - . space");
          else if (!isObject(t)) bad(p, "must be { offset, weight }");
          else {
            if (!(triple(t.offset) && t.offset.every((c) => Math.abs(c) <= 10))) bad(`${p}.offset`, "must be three numbers, each within 10 m");
            if (!(num(t.weight) && t.weight >= 0 && t.weight <= 1)) bad(`${p}.weight`, "must be a number from 0 to 1");
            if (t.pole !== undefined && !(triple(t.pole) && t.pole.some((c) => c !== 0))) bad(`${p}.pole`, "must be three numbers, not all zero");
            for (const k of Object.keys(t)) if (k !== "offset" && k !== "weight" && k !== "pole") bad(`${p}.${k}`, "unknown field");
          }
        }
    }
    if (rig.inactive !== undefined) {
      const a = rig.inactive;
      if (!Array.isArray(a) || a.length > MAX_NAMES || !a.every((n) => typeof n === "string" && NAME.test(n)) || new Set(a).size !== a.length) {
        bad(`${at}.inactive`, `must be a list of at most ${MAX_NAMES} distinct bone names`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------- edits

const isEmpty = (r: ModelRig): boolean => Object.keys(r).length === 0;

/** Replace one model's override; an empty one removes the entry. */
function withModel(doc: RigDoc, id: string, rig: ModelRig): RigDoc {
  const { [id]: _gone, ...rest } = doc.models;
  return { ...doc, models: isEmpty(rig) ? rest : { ...rest, [id]: rig } };
}
/** `rig` with `key` set to `value`, or removed when undefined. */
function put<K extends keyof ModelRig>(rig: ModelRig, key: K, value: ModelRig[K] | undefined): ModelRig {
  const { [key]: _gone, ...rest } = rig;
  return value === undefined ? rest : { ...rest, [key]: value };
}
/** `map` with `name` set to `value`, or removed (and the map with it when empty). */
function entry<V>(map: Record<string, V> | undefined, name: string, value: V | undefined): Record<string, V> | undefined {
  const { [name]: _gone, ...rest } = map ?? {};
  const next = value === undefined ? rest : { ...rest, [name]: value };
  return Object.keys(next).length === 0 ? undefined : next;
}

export type RigHints = Pick<ModelRig, "bodyPlan" | "headSign" | "legTop" | "knee">;
/** Set the given hints (an `undefined` value removes that hint). */
export function setHint(doc: RigDoc, id: string, patch: { [K in keyof RigHints]?: RigHints[K] | undefined }): RigDoc {
  let rig = modelRig(doc, id);
  for (const k of Object.keys(patch) as (keyof RigHints)[]) rig = put(rig, k, patch[k] as never);
  return withModel(doc, id, rig);
}
export const setLimit = (doc: RigDoc, id: string, bone: string, limit: RigLimit | undefined): RigDoc => {
  const rig = modelRig(doc, id);
  return withModel(doc, id, put(rig, "limits", entry(rig.limits, bone, limit)));
};
export const setTarget = (doc: RigDoc, id: string, chain: string, target: RigTarget | undefined): RigDoc => {
  const rig = modelRig(doc, id);
  return withModel(doc, id, put(rig, "targets", entry(rig.targets, chain, target)));
};
/** Switch a bone on or off; only the ones switched off are stored. */
export function setActive(doc: RigDoc, id: string, bone: string, active: boolean): RigDoc {
  const rig = modelRig(doc, id);
  const off = (rig.inactive ?? []).filter((b) => b !== bone);
  return withModel(doc, id, put(rig, "inactive", active ? (off.length ? off : undefined) : [...off, bone]));
}
export function clearModel(doc: RigDoc, id: string): RigDoc {
  return withModel(doc, id, {});
}
