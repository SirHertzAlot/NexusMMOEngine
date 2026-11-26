/**
 * The Blender live-link's rules (docs/BLENDER-LINK.md, slice EU10).
 *
 * The functionality reference's Blender tab is a live link: an add-on
 * in Blender, auto-import on save, send selection. The shape of ours is
 * decided by two facts about this repository.
 *
 * First, art lives in `<repo>/assets`, which is gitignored and served
 * by the dev server on loopback only. That is where a model from
 * Blender has to land — `assets/live/` — and because the whole folder
 * is ignored, nothing a designer sends can be committed by accident.
 * The rule that `assets/` is never staged or pushed is unchanged;
 * `vcs-host.ts` still refuses every path under it.
 *
 * Second, the only program that may write there is this host, so the
 * name a push carries is the one thing a stranger controls. These
 * checks are therefore the interesting part of the slice, kept pure so
 * the host and the panel apply the same ones.
 */

/** One model pushed from Blender, as `assets/live/index.json` records it. */
export interface LiveModel {
  /** Plain identifier; the file is `<name>.glb`. */
  name: string;
  /** Bytes on disk. */
  bytes: number;
  /** Epoch ms of the push that produced this version. */
  at: number;
  /** How many times this name has been pushed in this checkout. */
  pushes: number;
  /** The blend file it came from, when the add-on knew one. */
  from?: string;
}

/** Everything the live link holds, newest push first. */
export interface LiveIndex {
  models: LiveModel[];
}

/** The folder, relative to the repository root. Never configurable: see above. */
export const LIVE_DIR = "assets/live";

/** glTF binary only: one file per model, which is what the add-on exports. */
export const LIVE_SUFFIX = ".glb";

/**
 * 256 MB. Large enough for a production character with textures packed
 * in, small enough that a runaway export does not fill the disk before
 * anyone notices.
 */
export const MAX_BYTES = 256 * 1024 * 1024;

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Why this push cannot be accepted, or null when it can. The name is
 * the only part of a push that reaches the filesystem, so it is checked
 * against a whitelist rather than scrubbed: a name that is not a plain
 * identifier is refused outright, which leaves no traversal, no hidden
 * file, no Windows device name and no case collision to reason about.
 */
export function refuseModel(name: string, bytes: number): string | null {
  if (!NAME.test(name)) {
    return `"${name}": a model name is lower-case letters, digits, - and _ (max 64), starting with a letter or digit`;
  }
  if (bytes <= 0) return `"${name}": empty export`;
  if (bytes > MAX_BYTES) {
    return `"${name}": ${mb(bytes)} exceeds the ${mb(MAX_BYTES)} live-link limit`;
  }
  return null;
}

/** `assets/live/hero.glb` — the path, once the name has been accepted. */
export function liveModelFile(name: string): string {
  return `${LIVE_DIR}/${name}${LIVE_SUFFIX}`;
}

/** What the browser fetches: the dev server serves `<repo>/assets` at `/assets`. */
export function liveModelUrl(name: string, at: number): string {
  // The version is in the query so a re-push is not served from cache.
  return `/${liveModelFile(name)}?v=${at}`;
}

export const mb = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Fold a push into the index: newest first, one entry per name, and the
 * push count kept so the panel can say a model is being iterated on
 * rather than that it arrived once.
 */
export function recordPush(index: LiveIndex, model: Omit<LiveModel, "pushes">): LiveIndex {
  const before = index.models.find((m) => m.name === model.name);
  const rest = index.models.filter((m) => m.name !== model.name);
  return { models: [{ ...model, pushes: (before?.pushes ?? 0) + 1 }, ...rest] };
}

/** "just now", "3 min ago", "2 h ago", "26 Nov" — a log line's worth of time. */
export function sinceLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
