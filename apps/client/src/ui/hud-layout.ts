/**
 * EA23 HUD layout: widget positions as data (`content/ui/hud.json`).
 *
 * Each widget names an anchor (one of nine screen positions) plus a pixel
 * offset from it. The client renders widgets through <HudSlot>; the editor
 * edits this file. Moving a widget never touches component code.
 */
import { z } from "zod";

export const Anchor = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);
export type Anchor = z.infer<typeof Anchor>;

export const WidgetPlacement = z.object({
  anchor: Anchor,
  offset: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  visible: z.boolean().default(true),
});
export type WidgetPlacement = z.infer<typeof WidgetPlacement>;

export const HudLayout = z.object({
  widgets: z.record(z.string(), WidgetPlacement),
});
export type HudLayout = z.infer<typeof HudLayout>;

export function loadHudLayout(json: unknown): HudLayout {
  return HudLayout.parse(json);
}

/** CSS for an anchor + offset (React inline style). */
export function anchorStyle(
  anchor: Anchor,
  offset: { x: number; y: number },
): Record<string, string | number> {
  const base: Record<string, string | number> = { position: "absolute" };
  const { x, y } = offset;
  switch (anchor) {
    case "top-left": return { ...base, left: x, top: y };
    case "top-center": return { ...base, left: "50%", top: y, transform: `translateX(calc(-50% + ${x}px))` };
    case "top-right": return { ...base, right: x, top: y };
    case "center-left": return { ...base, left: x, top: "50%", transform: `translateY(calc(-50% + ${y}px))` };
    case "center": return { ...base, left: "50%", top: "50%", transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` };
    case "center-right": return { ...base, right: x, top: "50%", transform: `translateY(calc(-50% + ${y}px))` };
    case "bottom-left": return { ...base, left: x, bottom: y };
    case "bottom-center": return { ...base, left: "50%", bottom: y, transform: `translateX(calc(-50% + ${x}px))` };
    case "bottom-right": return { ...base, right: x, bottom: y };
  }
}

/**
 * The default layout, matching the hardcoded positions the client used
 * before hud.json existed. content/ui/hud.json starts as a copy of this.
 */
/**
 * The layout to render: the served layout (content/ui/hud.json) over the
 * defaults, so a widget the file does not place (a new one, or one not yet
 * listed) keeps its default place rather than vanishing. No layout: the defaults.
 */
export function withDefaults(layout: HudLayout | null | undefined): HudLayout {
  if (!layout) return DEFAULT_LAYOUT;
  return { widgets: { ...DEFAULT_LAYOUT.widgets, ...layout.widgets } };
}

export const DEFAULT_LAYOUT: HudLayout = {
  widgets: {
    "player-frame": { anchor: "bottom-left", offset: { x: 16, y: 16 }, visible: true },
    "cast-bar": { anchor: "bottom-left", offset: { x: 16, y: 150 }, visible: true },
    "friends-frame": { anchor: "bottom-left", offset: { x: 16, y: 260 }, visible: true },
    "chat-panel": { anchor: "bottom-left", offset: { x: 16, y: 400 }, visible: true },
    "quest-tracker": { anchor: "top-right", offset: { x: 16, y: 64 }, visible: true },
    "target-frame": { anchor: "top-center", offset: { x: 0, y: 96 }, visible: true },
    "bag-panel": { anchor: "bottom-right", offset: { x: 16, y: 16 }, visible: true },
    "vendor-panel": { anchor: "top-center", offset: { x: 0, y: 160 }, visible: true },
    "duel-panel": { anchor: "top-center", offset: { x: 0, y: 260 }, visible: true },
    "quest-log": { anchor: "bottom-right", offset: { x: 16, y: 200 }, visible: true },
    "character-sheet": { anchor: "bottom-right", offset: { x: 16, y: 400 }, visible: true },
    "party-frame": { anchor: "top-left", offset: { x: 16, y: 64 }, visible: true },
    "guild-frame": { anchor: "top-left", offset: { x: 16, y: 200 }, visible: true },
    "ability-bar": { anchor: "bottom-center", offset: { x: 0, y: 250 }, visible: true },
    "status-frame": { anchor: "top-right", offset: { x: 16, y: 260 }, visible: true },
  },
};
