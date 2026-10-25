/**
 * Selection card actions (roadmap A2 write path, A3 despawn): the admin
 * commands the play-mode debugger sends for the picked entity.
 *
 * Pure TS (no React): the card names components the way the mirror does
 * (inspectors/selection.ts), the server's `set` names them the way the
 * ECS does (engine-core admin/set.ts). This maps one onto the other and
 * builds the command args; the server still validates everything.
 */

import type { SelectedEntity } from "./selection.js";

/** One admin command (protocol 0x10) as MirrorClient.admin takes it. */
export interface AdminCall {
  command: string;
  args: Record<string, unknown>;
}

export interface AdminOutcome {
  ok: boolean;
  message: string;
}

/** Card component name → the server's component name, where they differ. */
const SERVER_COMPONENT: Record<string, string> = { Intent: "PlayerIntent" };

/**
 * The `set` whitelist (engine-core admin/set.ts) for the components the
 * card shows; keep the two in step. Fields not listed stay read-only.
 */
const SET_FIELDS: Record<string, Record<string, "int" | "float">> = {
  Transform: { px: "float", py: "float", pz: "float", qx: "float", qy: "float", qz: "float", qw: "float", sx: "float", sy: "float", sz: "float" },
  Velocity: { lx: "float", ly: "float", lz: "float", ax: "float", ay: "float", az: "float" },
  PlayerIntent: { mx: "float", my: "float", mz: "float", lookYaw: "float", lookPitch: "float", jump: "int", buttons: "int" },
  Health: { current: "float", max: "float" },
  BodyConfig: { shapeKind: "int", halfX: "float", halfY: "float", halfZ: "float", radius: "float", mass: "float", motionType: "int", layer: "int", friction: "float", restitution: "float" },
  AssetRef: { assetHash: "int", variant: "int" },
  Locomotion: { mode: "int", abilities: "int", breath: "float" },
  Action: { move: "int", started: "int", seq: "int", yaw: "float" },
};

export function serverComponent(cardName: string): string {
  return SERVER_COMPONENT[cardName] ?? cardName;
}

/** Whether `set` can write this card field. */
export function editableField(cardComponent: string, field: string): boolean {
  return SET_FIELDS[serverComponent(cardComponent)]?.[field] !== undefined;
}

/** `set` for one card field from the typed text, or why it can't be sent. */
export function setCommand(wireId: string, cardComponent: string, field: string, text: string): AdminCall | { error: string } {
  const component = serverComponent(cardComponent);
  const kind = SET_FIELDS[component]?.[field];
  if (!kind) return { error: `${cardComponent}.${field} is read-only` };
  const t = text.trim();
  // Booleans (Intent.jump) show as true/false and store as 0/1.
  const value = t === "true" ? 1 : t === "false" ? 0 : t === "" ? NaN : Number(t);
  if (!Number.isFinite(value)) return { error: `not a number: ${JSON.stringify(text)}` };
  if (kind === "int" && !Number.isInteger(value)) return { error: `${component}.${field} takes an integer` };
  return { command: "set", args: { entity: wireId, component, field, value } };
}

export function inspectCommand(wireId: string): AdminCall {
  return { command: "inspect", args: { entity: wireId } };
}

export function despawnCommand(wireId: string): AdminCall {
  return { command: "despawn", args: { entity: wireId } };
}

/** Heal = `set` Health.current to Health.max. */
export function healCommand(entity: SelectedEntity): AdminCall | { error: string } {
  const health = entity.health as { max?: number } | undefined;
  if (typeof health?.max !== "number") return { error: "no Health" };
  return { command: "set", args: { entity: entity.wireId.toString(), component: "Health", field: "current", value: health.max } };
}

/** Teleport the caller's avatar to the entity's x/z (the server snaps to the ground). */
export function teleportHereCommand(entity: SelectedEntity): AdminCall | { error: string } {
  const t = entity.transform as { px?: number; pz?: number } | undefined;
  if (typeof t?.px !== "number" || typeof t.pz !== "number") return { error: "no Transform" };
  return { command: "teleport", args: { x: t.px, z: t.pz } };
}

/**
 * Send one call and fold the answer into an outcome. The gateway refuses
 * with a 4003 error (the client rejects "admin rejected: 4003 <why>"),
 * so the reason is unwrapped for display.
 */
export async function sendAdmin(
  client: { admin(command: string, args?: unknown): Promise<AdminOutcome> },
  call: AdminCall | { error: string },
): Promise<AdminOutcome> {
  if ("error" in call) return { ok: false, message: call.error };
  try {
    const res = await client.admin(call.command, call.args);
    return { ok: res.ok, message: res.message };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message: message.replace(/^admin rejected: \d+ /, "") };
  }
}
