/**
 * Cutscene Lane — C0 data schemas (CUTSCENE-LANE-SPEC.md §3, §4, §5, §10).
 *
 * Baked-physics cinematics: the server owns story triggers, entry/exit poses,
 * and pre/post verbs; MuJoCo bakes recordings offline into versioned bundles.
 */
import { z } from "zod";

const slug = z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase slug (a-z, 0-9, -)");
const vec3Tuple = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const quatTuple = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const ActorSlotSchema = z.strictObject({
  slot: slug,
  rigFamily: slug,
  requiredComponents: z.array(z.string().min(1)).default([]),
});
export type ActorSlot = z.infer<typeof ActorSlotSchema>;

export const PropDefSchema = z.strictObject({
  prop: slug,
  kind: z.enum(["static", "dynamic", "breakable-cosmetic"]),
});
export type PropDef = z.infer<typeof PropDefSchema>;

export const PoseSchema = z.strictObject({
  position: vec3Tuple,
  yaw: z.number().finite(),
  rotation: quatTuple.optional(),
});
export type Pose = z.infer<typeof PoseSchema>;

export const StageSchema = z.strictObject({
  anchor: vec3Tuple,
  radiusM: z.number().positive(),
});
export type Stage = z.infer<typeof StageSchema>;

export const BEAT_TYPES = [
  "dialogue",
  "camera",
  "vfx",
  "audio",
  "shake",
  "flash",
  "slowmo",
] as const;
export type BeatType = (typeof BEAT_TYPES)[number];

/** Beat types whose timed spans may not overlap with another beat of the same type. */
const EXCLUSIVE_SPAN_BEATS = new Set<BeatType>(["dialogue", "camera", "slowmo"]);

export const BeatSchema = z.strictObject({
  tSec: z.number().min(0).finite(),
  durationSec: z.number().min(0).finite().optional(),
  type: z.enum(BEAT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});
export type Beat = z.infer<typeof BeatSchema>;

export const VerbInvocationSchema = z.strictObject({
  verb: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type VerbInvocation = z.infer<typeof VerbInvocationSchema>;

export const Provenance5W1HSchema = z.strictObject({
  who: z.string().min(1),
  what: z.string().min(1),
  when: z.string().min(1),
  where: z.string().min(1),
  why: z.string().min(1),
  how: z.string().min(1),
  replaced: z.string().optional(),
});
export type Provenance5W1H = z.infer<typeof Provenance5W1HSchema>;

export const MAX_BAKED_DURATION_SEC = 60;
export const MAX_LIVE_DURATION_SEC = 20;
export const MAX_BAKED_ACTORS = 16;
export const MAX_LIVE_ACTORS = 8;
export const MAX_DYNAMIC_PROPS = 64;

export const CinematicDefSchema = z
  .strictObject({
    id: slug,
    title: z.string().min(1).max(120),
    kind: z.enum(["baked", "live"]),
    fallbackBakedId: slug.optional(),
    durationCapSec: z.number().positive(),
    actorSlots: z.array(ActorSlotSchema).default([]),
    props: z.array(PropDefSchema).default([]),
    stage: StageSchema,
    beats: z.array(BeatSchema).default([]),
    entryPoses: z.record(slug, PoseSchema).default({}),
    exitPoses: z.record(slug, PoseSchema).default({}),
    preVerbs: z.array(VerbInvocationSchema).default([]),
    postVerbs: z.array(VerbInvocationSchema).default([]),
    provenance: Provenance5W1HSchema,
  })
  .superRefine((def, ctx) => {
    if (def.kind === "live" && !def.fallbackBakedId) {
      ctx.addIssue({
        code: "custom",
        path: ["fallbackBakedId"],
        message: 'live cinematics require fallbackBakedId',
      });
    }
    const maxDur = def.kind === "live" ? MAX_LIVE_DURATION_SEC : MAX_BAKED_DURATION_SEC;
    if (def.durationCapSec > maxDur) {
      ctx.addIssue({
        code: "custom",
        path: ["durationCapSec"],
        message: `${def.kind} durationCapSec (${def.durationCapSec}s) exceeds ${maxDur}s cap`,
      });
    }
    const maxActors = def.kind === "live" ? MAX_LIVE_ACTORS : MAX_BAKED_ACTORS;
    if (def.actorSlots.length > maxActors) {
      ctx.addIssue({
        code: "custom",
        path: ["actorSlots"],
        message: `${def.kind} actorSlots (${def.actorSlots.length}) exceeds ${maxActors} cap`,
      });
    }
    const dynProps = def.props.filter((p) => p.kind === "dynamic" || p.kind === "breakable-cosmetic");
    if (dynProps.length > MAX_DYNAMIC_PROPS) {
      ctx.addIssue({
        code: "custom",
        path: ["props"],
        message: `dynamic props (${dynProps.length}) exceeds ${MAX_DYNAMIC_PROPS} cap`,
      });
    }

    const slotNames = new Set<string>();
    for (let i = 0; i < def.actorSlots.length; i++) {
      const slot = def.actorSlots[i].slot;
      if (slotNames.has(slot)) {
        ctx.addIssue({ code: "custom", path: ["actorSlots", i, "slot"], message: `duplicate actor slot "${slot}"` });
      }
      slotNames.add(slot);
      if (!(slot in def.entryPoses)) {
        ctx.addIssue({ code: "custom", path: ["entryPoses"], message: `missing entryPose for actor slot "${slot}"` });
      }
      if (!(slot in def.exitPoses)) {
        ctx.addIssue({ code: "custom", path: ["exitPoses"], message: `missing exitPose for actor slot "${slot}"` });
      }
    }

    // Beats must be sorted by tSec and exclusive beat types cannot overlap.
    const lastEndByType = new Map<BeatType, number>();
    let prevT = -Infinity;
    for (let i = 0; i < def.beats.length; i++) {
      const beat = def.beats[i];
      if (beat.tSec < prevT) {
        ctx.addIssue({
          code: "custom",
          path: ["beats", i, "tSec"],
          message: `beats must be sorted ascending by tSec (${beat.tSec} < ${prevT})`,
        });
      }
      prevT = beat.tSec;
      if (beat.tSec > def.durationCapSec) {
        ctx.addIssue({
          code: "custom",
          path: ["beats", i, "tSec"],
          message: `beat tSec (${beat.tSec}s) exceeds durationCapSec (${def.durationCapSec}s)`,
        });
      }
      if (EXCLUSIVE_SPAN_BEATS.has(beat.type)) {
        const prevEnd = lastEndByType.get(beat.type);
        if (prevEnd !== undefined && beat.tSec < prevEnd) {
          ctx.addIssue({
            code: "custom",
            path: ["beats", i],
            message: `overlapping ${beat.type} beat at ${beat.tSec}s (previous ends at ${prevEnd}s)`,
          });
        }
        lastEndByType.set(beat.type, beat.tSec + (beat.durationSec ?? 0));
      }
    }
  });
export type CinematicDef = z.infer<typeof CinematicDefSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "64-char lowercase sha256 hex");

export const CinematicBundleManifestSchema = z.strictObject({
  version: z.literal(1),
  id: slug,
  bundleHash: sha256Hex,
  mjcfVersion: z.string().min(1),
  sourceHashes: z.record(z.string(), sha256Hex),
  trackHash: sha256Hex,
  secondBakeTrackHash: sha256Hex.optional(),
  compressedBytes: z.number().int().nonnegative(),
  durationSec: z.number().positive().finite(),
  skeletalSampleRateHz: z.number().positive().default(60),
  propSampleRateHz: z.number().positive().default(30),
  clips: z.array(z.string().min(1)).default([]),
  propTrackFile: z.string().min(1).optional(),
  sourceLicenses: z.array(z.string().min(1)).min(1),
});
export type CinematicBundleManifest = z.infer<typeof CinematicBundleManifestSchema>;

export const RecordedFinalSampleSchema = z.strictObject({
  frames: z.number().int().positive(),
  sampleRateHz: z.number().positive(),
  durationSec: z.number().positive().finite(),
  actorFinalPoses: z.record(slug, PoseSchema).default({}),
  propFinalPoses: z.record(slug, PoseSchema).default({}),
  boneCount: z.number().int().nonnegative().default(0),
  maxBoneBudget: z.number().int().positive().default(200),
  hasNonFiniteSamples: z.boolean().default(false),
  jointLimitViolations: z.number().int().nonnegative().default(0),
});
export type RecordedFinalSample = z.infer<typeof RecordedFinalSampleSchema>;
