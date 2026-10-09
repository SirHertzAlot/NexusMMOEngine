/**
 * A6 appearance editor: parse and apply `appearance` admin-command edits.
 *
 * The command views and edits a character's look live — parts per slot,
 * colours per slot — validated against the modular catalog the same way
 * character creation validates. Applied via sim.setLook, so the change
 * syncs to clients like any appearance update.
 */
import { hasComponent } from "bitecs";
import {
  lookToJson,
  parseLook,
  validateLook,
  type CharacterLook,
  type ModularCatalog,
} from "@mmo-engine/art/character";
import * as C from "../components.js";
import type { SimWorld } from "../world.js";

export type AppearanceEdit =
  | { kind: "show" }
  | { kind: "part"; slot: string; part: string | null }
  | { kind: "colour"; slot: string; colour: string };

export type ParseResult =
  | { ok: true; edit: AppearanceEdit }
  | { ok: false; message: string };

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Parse `appearance` args into an edit (empty = show the look). */
export function parseAppearanceArgs(args: string[]): ParseResult {
  if (args.length === 0) return { ok: true, edit: { kind: "show" } };
  if (args[0] === "colour" || args[0] === "color") {
    const [, slot, colour] = args;
    if (!slot || !colour) return { ok: false, message: "usage: appearance colour <slot> <#rrggbb>" };
    if (!HEX.test(colour)) return { ok: false, message: `appearance: ${colour} is not a #rrggbb colour` };
    return { ok: true, edit: { kind: "colour", slot, colour: colour.toLowerCase() } };
  }
  const [slot, part] = args;
  if (!slot || part === undefined) {
    return { ok: false, message: "usage: appearance [<slot> <part|clear>] | [colour <slot> <#rrggbb>]" };
  }
  return { ok: true, edit: { kind: "part", slot, part: part === "clear" ? null : part } };
}

export interface EditResult {
  ok: boolean;
  message?: string;
  /** The new look JSON (when the edit applied). */
  json?: string;
}

/**
 * Apply an edit to an entity's look. The catalog may be null (no art on
 * this machine) — then parts are checked structurally only.
 */
export function applyAppearanceEdit(
  sim: SimWorld,
  wireId: bigint,
  edit: AppearanceEdit,
  catalog: ModularCatalog | null,
): EditResult {
  const eid = sim.resolveWireId(wireId);
  if (eid < 0) return { ok: false, message: `appearance: unknown entity ${wireId}` };
  if (!hasComponent(sim.ecs, C.Appearance, eid)) {
    return { ok: false, message: `appearance: entity ${wireId} has no Appearance` };
  }
  const look = parseLook(JSON.parse(sim.lookJson(C.Appearance.look[eid]) as string) as unknown);
  if (!look) return { ok: false, message: `appearance: entity ${wireId} has an unreadable look` };

  if (edit.kind === "show") {
    return { ok: true, json: lookToJson(look), message: describeLook(look) };
  }

  const next: CharacterLook = {
    gender: look.gender,
    parts: { ...look.parts },
    colours: { ...look.colours },
  };
  if (edit.kind === "part") {
    if (edit.part === null) delete next.parts[edit.slot as keyof typeof next.parts];
    else (next.parts as Record<string, string>)[edit.slot] = edit.part;
  } else {
    (next.colours as Record<string, string>)[edit.slot] = edit.colour;
  }

  if (catalog) {
    const problems = validateLook(catalog, next);
    if (problems.length > 0) {
      return { ok: false, message: `appearance: ${problems[0]!.field}: ${problems[0]!.message}` };
    }
  } else if (edit.kind === "part" && edit.part !== null) {
    // Without a catalog we can only check the shape, not the part name.
    if (!/^[a-z0-9-]+$/i.test(edit.part)) {
      return { ok: false, message: `appearance: "${edit.part}" is not a part name` };
    }
  }

  const json = lookToJson(next);
  sim.setLook(eid, json);
  return { ok: true, json, message: describeLook(next) };
}

function describeLook(look: CharacterLook): string {
  const parts = Object.entries(look.parts)
    .map(([slot, part]) => `${slot}=${part}`)
    .join(" ");
  const colours = Object.entries(look.colours)
    .map(([slot, colour]) => `${slot}=${colour}`)
    .join(" ");
  return `${look.gender} ${parts}${colours ? ` [${colours}]` : ""}`.trim();
}
