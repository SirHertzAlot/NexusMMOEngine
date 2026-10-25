/**
 * Selection facts — the one input the authoring layer evaluates.
 *
 * The relevance rules (MODULE-AUTHORING-AUDIT.md §5) are predicate checks
 * against things the code already exposes: components present on the
 * entity, `VendorSystem.vendorOf(entity)`, `CreatureSystem.kindOf(entity)`,
 * quest-content giver matches, dungeon-entrance membership, and the
 * Phase A marker components (FlowRef=18, VfxEmitter=19, AudioEmitter=20).
 * This type flattens all of those lookups into one plain record so the
 * evaluator, the add shelf, the hierarchy filters and the widget builder
 * all read the same facts — and so tests can state a selection ("the
 * blacksmith") without booting a world.
 *
 * Adapters that produce facts from real editor state live with the UI
 * (ui/authoring-view.tsx); this file is pure data + a builder.
 */

/** Designer-language object kinds. Free-form on purpose: content invents kinds. */
export type ObjectKind = string;

export interface SelectionFacts {
  /** Entity / node id of the selected object. */
  id: string;
  /** Display label ("Blacksmith Mara"). */
  label: string;
  /** Designer-language kind: "npc", "creature", "player", "prop", "rock", "dungeon-entrance", … */
  kind: ObjectKind;
  /** Component names present on the object (engine ECS names and scene-doc names both appear here). */
  components: readonly string[];
  /** Rule 1: the entity is in the vendor map (`VendorSystem.vendorOf(entity)` defined). */
  isVendor: boolean;
  /** Vendor template id when applied (from the vendor map entry). */
  vendorTemplateId?: string;
  /** Rule 4: `CreatureSystem.kindOf(entity)` result; undefined = not a creature. */
  creatureKind?: string;
  /** Rule 7/16: the object's id matches a quest-content `npcs` entry or a quest `giver`. */
  isQuestGiver: boolean;
  /** Quest ids this giver offers, when known. */
  questIds?: readonly string[];
  /** Rule 8: the object is a dungeon entrance (dungeons/content entrances). */
  isDungeonEntrance: boolean;
  /** Rule 5 support: a collider is attached (prop-collision / collider systems). */
  hasCollider: boolean;
  /** Phase A marker values: the bound graph / effect / clip id, when the marker component is present. */
  flowRef?: string;
  vfxEmitter?: string;
  audioEmitter?: string;
  /** The object's ground position from its Transform, when the selection carries one — prefills teleport/spawn inputs. */
  position?: { x: number; z: number };
  /** Reference targets the hierarchy renders as edges, when the data carries them. */
  patrolRouteId?: string;
  dialogueGraphId?: string;
  /** Last provenance timestamp (ms) touching this object — feeds "recently modified" sorting. */
  lastModifiedAt?: number;
  /** Actor id of the last provenance entry, when known. */
  lastModifiedBy?: string;
}

/** Component-presence check, case-insensitive (ECS names and scene-doc names differ in casing style only). */
export function hasComponent(facts: SelectionFacts, name: string): boolean {
  const want = name.toLowerCase();
  return facts.components.some((c) => c.toLowerCase() === want);
}

export type FactsPatch = Partial<Omit<SelectionFacts, "components">> & { components?: readonly string[] };

/**
 * Build facts with honest defaults: nothing applied, nothing present.
 * Tests and adapters state only what the selection actually carries.
 */
export function makeFacts(patch: FactsPatch & { id: string; label: string }): SelectionFacts {
  return {
    kind: "prop",
    components: [],
    isVendor: false,
    isQuestGiver: false,
    isDungeonEntrance: false,
    hasCollider: false,
    ...patch,
  };
}

/** Kinds that can plausibly host a person-like sheet (NPCs, creatures, players). */
const PERSON_KINDS: ReadonlySet<string> = new Set(["npc", "character", "player", "creature", "villager", "mob"]);

/** Whether the object's kind can ever host character/vendor/quest behaviour. Plain props and rocks cannot. */
export function isPersonKind(facts: SelectionFacts): boolean {
  return PERSON_KINDS.has(facts.kind.toLowerCase()) || hasComponent(facts, "CharacterRef") || facts.creatureKind !== undefined;
}
