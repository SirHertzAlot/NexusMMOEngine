/**
 * HUD layout (roadmap EA23, EDITOR-ARCHITECTURE.md section 7c): where the
 * client's HUD widgets sit, stored in `content/ui/hud.json`. Pure: the
 * client turns a widget into CSS (`anchorCss`), the editor drags and
 * re-anchors with `moveHudWidget` / `reanchorHudWidget` and checks the
 * layout at every UI scale and common resolution with `hudReport`.
 *
 * A widget is a box (w x h, in design px) pinned to one of nine anchors
 * with an offset. Offsets point inward from the anchor edge; on a centred
 * axis they are plain +right / +down. The client's UI scale multiplies
 * everything (it scales the root font size and the layout is in rem).
 */
import type { SceneIssue } from "./index.js";

export const HUD_VERSION = 1;
export const HUD_ANCHORS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const;
export type HudAnchor = (typeof HUD_ANCHORS)[number];
export const HUD_SCALES = [90, 100, 110, 125] as const;
export const HUD_RESOLUTIONS: ReadonlyArray<{ w: number; h: number }> = [
  { w: 1280, h: 720 },
  { w: 1366, h: 768 },
  { w: 1600, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
  { w: 3440, h: 1440 },
];
/** The root font size the client's UI scale is a percent of. */
const REM = 16;

export interface HudWidget {
  anchor: HudAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
  /** false hides the widget (default true). */
  visible?: boolean;
}
export interface HudDoc {
  version: number;
  /** Colour tokens from HUD_THEME_TOKENS, as #rrggbb. */
  theme: Record<string, string>;
  widgets: Record<string, HudWidget>;
}

/** The widgets the client mounts, in the order the editor lists them. */
export const HUD_CATALOG: ReadonlyArray<{ id: string; label: string; note: string }> = [
  { id: "player-frame", label: "Player frame", note: "your vitals, needs and body doll" },
  { id: "cast-bar", label: "Cast bar", note: "your spell cast under way" },
  { id: "friends-frame", label: "Friends", note: "friends and block list" },
  { id: "target-frame", label: "Target frame", note: "the selected target's health" },
  { id: "party-frame", label: "Party frame", note: "party members and invites" },
  { id: "guild-frame", label: "Guild frame", note: "guild roster and invites" },
  { id: "quest-tracker", label: "Quest tracker", note: "active quest objectives" },
  { id: "dungeon-hud", label: "Dungeon HUD", note: "run timer and loot, in an instance" },
  { id: "chat", label: "Chat", note: "chat channels and input" },
  { id: "settings", label: "Settings menu", note: "graphics, audio, keys, UI scale" },
  { id: "menu-stack", label: "Menu buttons", note: "quests, sheet and bag (their panels open above)" },
];
export const HUD_WIDGET_IDS: readonly string[] = HUD_CATALOG.map((c) => c.id);

/** Theme tokens the client maps onto its CSS colour variables. */
export const HUD_THEME_TOKENS = ["card", "card-foreground", "primary", "border", "muted-foreground", "accent"] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateHud(doc: unknown): SceneIssue[] {
  const issues: SceneIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ path, message });
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [{ path: "", message: "hud must be an object" }];
  const d = doc as Partial<HudDoc>;
  if (d.version !== HUD_VERSION) add("version", `must be ${HUD_VERSION}`);
  if (typeof d.theme !== "object" || d.theme === null || Array.isArray(d.theme)) add("theme", "must be an object");
  else {
    for (const [k, v] of Object.entries(d.theme)) {
      if (!(HUD_THEME_TOKENS as readonly string[]).includes(k)) add(`theme.${k}`, `unknown token (use ${HUD_THEME_TOKENS.join(", ")})`);
      else if (typeof v !== "string" || !HEX.test(v)) add(`theme.${k}`, "must be a #rrggbb colour");
    }
  }
  if (typeof d.widgets !== "object" || d.widgets === null || Array.isArray(d.widgets)) add("widgets", "must be an object");
  else {
    for (const [id, w] of Object.entries(d.widgets)) {
      const p = `widgets.${id}`;
      if (!HUD_WIDGET_IDS.includes(id)) {
        add(p, "not a widget the client has");
        continue;
      }
      const o = w as Partial<HudWidget> | null;
      if (typeof o !== "object" || o === null) {
        add(p, "must be an object");
        continue;
      }
      if (!(HUD_ANCHORS as readonly string[]).includes(o.anchor as string)) add(`${p}.anchor`, `must be one of ${HUD_ANCHORS.join(", ")}`);
      if (!finite(o.x)) add(`${p}.x`, "must be a number");
      if (!finite(o.y)) add(`${p}.y`, "must be a number");
      if (!finite(o.w) || o.w <= 0) add(`${p}.w`, "must be a positive number");
      if (!finite(o.h) || o.h <= 0) add(`${p}.h`, "must be a positive number");
      if (o.visible !== undefined && typeof o.visible !== "boolean") add(`${p}.visible`, "must be true or false");
    }
  }
  return issues;
}

export interface HudRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Which way each axis is pinned: -1 start edge, 1 end edge, 0 centred. */
function axes(a: HudAnchor): { h: -1 | 0 | 1; v: -1 | 0 | 1 } {
  switch (a) {
    case "top": return { h: 0, v: -1 };
    case "bottom": return { h: 0, v: 1 };
    case "left": return { h: -1, v: 0 };
    case "right": return { h: 1, v: 0 };
    case "center": return { h: 0, v: 0 };
    default: return { h: a.endsWith("left") ? -1 : 1, v: a.startsWith("top") ? -1 : 1 };
  }
}

/** The widget's box in viewport px (top-left origin) at a UI scale in percent. */
export function widgetRect(wd: HudWidget, vp: { w: number; h: number }, scale: number): HudRect {
  const s = scale / 100;
  const { h: ah, v: av } = axes(wd.anchor);
  const w = wd.w * s;
  const h = wd.h * s;
  const x = ah < 0 ? wd.x * s : ah > 0 ? vp.w - wd.x * s - w : vp.w / 2 - w / 2 + wd.x * s;
  const y = av < 0 ? wd.y * s : av > 0 ? vp.h - wd.y * s - h : vp.h / 2 - h / 2 + wd.y * s;
  return { x, y, w, h };
}

const rem = (px: number): string => `${px / REM}rem`;
/** The CSS that pins the widget (position: absolute, in rem so the UI scale applies). */
export function anchorCss(wd: HudWidget): Record<string, string> {
  const { h: ah, v: av } = axes(wd.anchor);
  const css: Record<string, string> = { width: rem(wd.w), height: rem(wd.h) };
  const t: string[] = [];
  if (ah < 0) css.left = rem(wd.x);
  else if (ah > 0) css.right = rem(wd.x);
  else {
    css.left = `calc(50% + ${rem(wd.x)})`;
    t.push("translateX(-50%)");
  }
  if (av < 0) css.top = rem(wd.y);
  else if (av > 0) css.bottom = rem(wd.y);
  else {
    css.top = `calc(50% + ${rem(wd.y)})`;
    t.push("translateY(-50%)");
  }
  if (t.length) css.transform = t.join(" ");
  return css;
}

const tenth = (n: number): number => Math.round(n * 10) / 10;

/** Move by a pointer delta in viewport px (at `scale`), toward where the pointer went whatever the anchor. */
export function moveHudWidget(wd: HudWidget, dxPx: number, dyPx: number, scale: number): HudWidget {
  const { h: ah, v: av } = axes(wd.anchor);
  const s = scale / 100;
  return { ...wd, x: tenth(wd.x + (ah > 0 ? -dxPx : dxPx) / s), y: tenth(wd.y + (av > 0 ? -dyPx : dyPx) / s) };
}

/** Change the anchor without moving the box on screen at this viewport and scale. */
export function reanchorHudWidget(wd: HudWidget, anchor: HudAnchor, vp: { w: number; h: number }, scale: number): HudWidget {
  const r = widgetRect(wd, vp, scale);
  const s = scale / 100;
  const { h: ah, v: av } = axes(anchor);
  const x = ah < 0 ? r.x : ah > 0 ? vp.w - r.x - r.w : r.x - (vp.w / 2 - r.w / 2);
  const y = av < 0 ? r.y : av > 0 ? vp.h - r.y - r.h : r.y - (vp.h / 2 - r.h / 2);
  return { ...wd, anchor, x: tenth(x / s), y: tenth(y / s) };
}

export interface HudProblems {
  /** Pairs of visible widgets whose boxes intersect (ids sorted). */
  overlaps: Array<[string, string]>;
  /** Visible widgets not fully inside the viewport. */
  offscreen: string[];
}

export function hudProblems(doc: HudDoc, vp: { w: number; h: number }, scale: number): HudProblems {
  const ids = Object.keys(doc.widgets).filter((id) => doc.widgets[id].visible !== false).sort();
  const rects = new Map(ids.map((id) => [id, widgetRect(doc.widgets[id], vp, scale)]));
  const overlaps: Array<[string, string]> = [];
  const offscreen: string[] = [];
  const EPS = 0.01;
  for (const [i, a] of ids.entries()) {
    const ra = rects.get(a)!;
    if (ra.x < -EPS || ra.y < -EPS || ra.x + ra.w > vp.w + EPS || ra.y + ra.h > vp.h + EPS) offscreen.push(a);
    for (const b of ids.slice(i + 1)) {
      const rb = rects.get(b)!;
      if (ra.x < rb.x + rb.w - EPS && rb.x < ra.x + ra.w - EPS && ra.y < rb.y + rb.h - EPS && rb.y < ra.y + ra.h - EPS) overlaps.push([a, b]);
    }
  }
  return { overlaps, offscreen };
}

/** Every resolution x UI scale, with its problems. */
export function hudReport(doc: HudDoc): Array<{ w: number; h: number; scale: number } & HudProblems> {
  return HUD_RESOLUTIONS.flatMap((r) => HUD_SCALES.map((scale) => ({ ...r, scale, ...hudProblems(doc, r, scale) })));
}

/** #rrggbb to the bare "H S% L%" channels the client's CSS variables hold. */
export function hexToHsl(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** The theme as CSS custom properties for the client. */
export function themeVars(theme: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of HUD_THEME_TOKENS) if (theme[t] !== undefined && HEX.test(theme[t])) out[`--${t}`] = hexToHsl(theme[t]);
  return out;
}
