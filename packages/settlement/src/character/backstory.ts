/**
 * Backstory assembly and template rendering (Section 12 of CHARACTER-FOUNDATION-SPEC.md).
 */

import {
  alignmentBand,
  type CharacterBackstory,
  type CharacterCatalogs,
  type FragmentDef,
} from "./types.js";
import type { DeterministicRng } from "./generator.js";

export interface BackstoryContext {
  characterId: string;
  archetypeId: string;
  temperamentId: string;
  alignment: { benevolence: number; order: number };
  interests: Array<{ id: string; score: number }>;
  descriptorIds: string[];
  profession?: string;
  townId?: string;
  tier?: "background" | "local" | "major" | "villain";
  pins?: Partial<CharacterBackstory>;
}

/** Check if a fragment's conditions match the character. */
function matchesFragment(
  frag: FragmentDef,
  ctx: BackstoryContext,
): boolean {
  const c = frag.conditions;
  if (!c) return true;
  if (c.archetypes && !c.archetypes.includes(ctx.archetypeId)) return false;
  if (c.benevolenceBands) {
    const b = alignmentBand(ctx.alignment.benevolence);
    if (!c.benevolenceBands.includes(b)) return false;
  }
  if (c.orderBands) {
    const o = alignmentBand(ctx.alignment.order);
    if (!c.orderBands.includes(o)) return false;
  }
  if (c.professions && ctx.profession && !c.professions.includes(ctx.profession)) {
    return false;
  }
  if (c.interests) {
    const hasAny = ctx.interests.some((it) => c.interests!.includes(it.id));
    if (!hasAny) return false;
  }
  return true;
}

/** Fill template slots using bake facts. */
export function interpolateTemplate(
  template: string,
  facts: {
    town?: string;
    profession?: string;
    place?: string;
    kin?: string;
    faith?: string;
  },
): string {
  return template
    .replace(/\{town\}/g, facts.town ?? "the settlement")
    .replace(/\{profession\}/g, facts.profession ?? "craft")
    .replace(/\{place\}/g, facts.place ?? "the borderlands")
    .replace(/\{kin\}/g, facts.kin ?? "family")
    .replace(/\{faith\}/g, facts.faith ?? "the Sanctuary");
}

export function assembleBackstory(
  ctx: BackstoryContext,
  catalogs: CharacterCatalogs,
  rng: { next(): number; weightedPick<T>(items: readonly T[], weightFn: (item: T) => number): T },
): CharacterBackstory {
  const pins = ctx.pins ?? {};
  const arch = catalogs.archetypes[ctx.archetypeId];
  const pools = arch?.fragmentPools ?? { origin: [], event: [], want: [], flaw: [] };

  const pickPool = (
    poolName: "origin" | "event" | "want" | "flaw",
    pinnedId?: string,
  ): string => {
    if (pinnedId && catalogs.fragments[pinnedId]) return pinnedId;
    const allowed = pools[poolName] || [];
    const valid = allowed
      .map((fid) => catalogs.fragments[fid])
      .filter((f): f is FragmentDef => !!f && matchesFragment(f, ctx));

    if (valid.length === 0) {
      // Fallback to any matching fragment in that pool
      const allInPool = Object.values(catalogs.fragments).filter(
        (f) => f.pool === poolName && matchesFragment(f, ctx),
      );
      if (allInPool.length > 0) {
        return rng.weightedPick(allInPool, (f) => f.weight).id;
      }
      return allowed[0] ?? `${poolName}:default`;
    }

    return rng.weightedPick(valid, (f) => f.weight).id;
  };

  const originId = pickPool("origin", pins.originId);
  const eventId = pickPool("event", pins.eventId);
  const wantId = pickPool("want", pins.wantId);
  const flawId = pickPool("flaw", pins.flawId);

  let text: string | undefined;
  if (pins.text) {
    text = pins.text;
  } else if (ctx.tier !== "background") {
    // Render text for local, major, villain
    const facts = {
      town: ctx.townId,
      profession: ctx.profession,
      place: "the frontiers",
      kin: "folk",
      faith: "the Sacred Light",
    };

    const originText = catalogs.fragments[originId]
      ? interpolateTemplate(catalogs.fragments[originId].text, facts)
      : "";
    const eventText = catalogs.fragments[eventId]
      ? interpolateTemplate(catalogs.fragments[eventId].text, facts)
      : "";
    const wantText = catalogs.fragments[wantId]
      ? interpolateTemplate(catalogs.fragments[wantId].text, facts)
      : "";
    const flawText = catalogs.fragments[flawId]
      ? interpolateTemplate(catalogs.fragments[flawId].text, facts)
      : "";

    text = [originText, eventText, wantText, flawText]
      .filter(Boolean)
      .join(" ");
  }

  return {
    originId,
    eventId,
    wantId,
    flawId,
    text,
  };
}
