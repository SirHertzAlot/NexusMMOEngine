/**
 * Entity API functions for querying mock and live entities.
 */

export interface EntitySummary {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  z: number;
}

export interface EntityDetail extends EntitySummary {
  components: Record<string, unknown>;
  health?: { current: number; max: number };
}

const MOCK_ENTITIES: EntityDetail[] = [
  {
    id: "entity-1",
    name: "Hero Player",
    type: "Player",
    x: 100.5,
    y: 10.0,
    z: 250.2,
    health: { current: 100, max: 100 },
    components: {
      transform: { px: 100.5, py: 10.0, pz: 250.2 },
      physics: { mass: 70, velocity: [0, 0, 0] },
      inventory: { itemsCount: 12 },
    },
  },
  {
    id: "entity-2",
    name: "Goblin Scout",
    type: "NPC",
    x: 115.0,
    y: 10.0,
    z: 260.5,
    health: { current: 30, max: 50 },
    components: {
      transform: { px: 115.0, py: 10.0, pz: 260.5 },
      ai: { state: "patrol", aggro: false },
    },
  },
  {
    id: "entity-3",
    name: "Iron Chest",
    type: "Object",
    x: 95.2,
    y: 9.8,
    z: 245.0,
    components: {
      transform: { px: 95.2, py: 9.8, pz: 245.0 },
      loot: { locked: true, rarity: "rare" },
    },
  },
];

export async function fetchEntities(): Promise<EntitySummary[]> {
  try {
    const res = await fetch("/api/editor/entities");
    if (res.ok) {
      const data = (await res.json()) as EntitySummary[];
      if (Array.isArray(data)) return data;
    }
  } catch {
    // Fallback
  }
  return MOCK_ENTITIES.map(({ id, name, type, x, y, z }) => ({ id, name, type, x, y, z }));
}

export async function fetchEntityDetail(id: string): Promise<EntityDetail | null> {
  try {
    const res = await fetch(`/api/editor/entities/${id}`);
    if (res.ok) {
      return (await res.json()) as EntityDetail;
    }
  } catch {
    // Fallback
  }
  return MOCK_ENTITIES.find((e) => e.id === id) ?? null;
}
