/**
 * Selection card (ROADMAP E6, PICG slice 3) — what a picked entity is.
 *
 * Click an entity in play mode's game view and the card shows every
 * component the mirror holds for it, field by field, and, when its
 * AssetRef names a PICG library asset, that asset: its graph, which of
 * its cooked shapes this entity shows (variant → shape and seed, the same
 * mapping the server's cook uses), and the graph's exposed parameters
 * with their defaults and the values this asset cooks with.
 *
 * Pure TS view-model (no React, no DOM), like inspectors/ecs.ts: the
 * panel renders it, tests feed it plain objects. Components are listed
 * generically, so a component added to the mirror shows up here without
 * a change.
 */

import { variantIndex, variantSeed } from "@mmo-engine/picg";
import type { PcgAssetView, PcgParameterView } from "../pcg-host.js";

/** An entity as the mirror holds it: a wire id and component rows. */
export interface SelectedEntity {
  wireId: bigint;
  [component: string]: unknown;
}

export interface CardField {
  key: string;
  value: string;
}

export interface CardComponent {
  name: string;
  fields: CardField[];
}

export interface CardParameter {
  name: string;
  type: string;
  value: string;
  default: string;
  overridden: boolean;
  /** "0.1 – 0.6" when the parameter has a range. */
  range?: string;
  description?: string;
}

export interface CardAsset {
  id: string;
  displayName: string;
  graph: string;
  description?: string;
  /** The AssetRef variant and the cooked shape it picks (of `variants`). */
  variant: number;
  shape: number;
  variants: number;
  seed: number;
  parameters: CardParameter[];
  error?: string;
}

export interface SelectionCard {
  wireId: string;
  /** The entity's name (a character or creature), when the names fan-out has one. */
  name: string | null;
  /** A short kind: the asset's name, "character", or "entity". */
  kind: string;
  components: CardComponent[];
  /** The PICG asset its AssetRef names (null: no AssetRef). */
  asset: CardAsset | null;
  /** An AssetRef whose hash isn't in the library. */
  unknownAsset: { assetHash: number; variant: number } | null;
}

/** Component display names (mirror keys); others show their key. */
const COMPONENT_NAMES: Record<string, string> = {
  transform: "Transform",
  velocity: "Velocity",
  intent: "Intent",
  chunk: "Chunk",
  health: "Health",
  stamina: "Stamina",
  characterRef: "CharacterRef",
  body: "BodyConfig",
  asset: "AssetRef",
  locomotion: "Locomotion",
  appearance: "Appearance",
  action: "Action",
};

/** A field value as text: 3 decimals for fractions, ids as integers, arrays inline. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "boolean" || typeof v === "string") return String(v);
  if (Array.isArray(v)) return v.length > 8 ? `[${v.slice(0, 8).map(formatValue).join(", ")}, … ${v.length}]` : `[${v.map(formatValue).join(", ")}]`;
  if (typeof v === "object") {
    return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${formatValue(x)}`).join(", ")} }`;
  }
  return String(v);
}

function componentFields(row: unknown): CardField[] {
  if (row === null || typeof row !== "object") return [{ key: "value", value: formatValue(row) }];
  return Object.entries(row as Record<string, unknown>)
    .filter(([k]) => k !== "wireId")
    .map(([key, value]) => ({ key, value: formatValue(value) }));
}

function cardParameter(p: PcgParameterView): CardParameter {
  return {
    name: p.name,
    type: p.type,
    value: formatValue(p.value),
    default: formatValue(p.default),
    overridden: p.overridden,
    ...(p.min !== undefined && p.max !== undefined ? { range: `${formatValue(p.min)} – ${formatValue(p.max)}` } : {}),
    ...(p.description ? { description: p.description } : {}),
  };
}

/** The card for one entity. `assets` is the library (empty while it loads). */
export function selectionCard(entity: SelectedEntity, name: string | null, assets: readonly PcgAssetView[]): SelectionCard {
  const components: CardComponent[] = Object.keys(entity)
    .filter((k) => k !== "wireId" && entity[k] !== undefined)
    .map((k) => ({ name: COMPONENT_NAMES[k] ?? k, fields: componentFields(entity[k]) }));

  const ref = entity.asset as { assetHash?: number; variant?: number } | undefined;
  let asset: CardAsset | null = null;
  let unknownAsset: SelectionCard["unknownAsset"] = null;
  if (ref && typeof ref.assetHash === "number") {
    const hash = ref.assetHash >>> 0;
    const variant = (ref.variant ?? 0) >>> 0;
    const found = assets.find((a) => a.assetHash >>> 0 === hash);
    if (found) {
      const lib = { id: found.id, graph: found.graph, variants: found.variants };
      const shape = variantIndex(lib, variant);
      asset = {
        id: found.id,
        displayName: found.displayName,
        graph: found.graph,
        ...(found.description ? { description: found.description } : {}),
        variant,
        shape,
        variants: found.variants,
        seed: variantSeed(lib, shape),
        parameters: found.parameters.map(cardParameter),
        ...(found.error ? { error: found.error } : {}),
      };
    } else {
      unknownAsset = { assetHash: hash, variant };
    }
  }

  const kind = asset ? asset.displayName : entity.characterRef !== undefined ? "character" : "entity";
  return { wireId: entity.wireId.toString(), name, kind, components, asset, unknownAsset };
}
