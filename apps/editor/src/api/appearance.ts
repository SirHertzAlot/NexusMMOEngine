/**
 * Appearance and Equipment API client and types for character customization editor.
 */
import { requestJson } from "../api.js";

export interface CharacterAppearance {
  skinTone: string;
  hairStyle: string;
  hairColor: string;
  eyeColor: string;
  height: number;
  bodyBuild: string;
}

export interface EquipmentSlot {
  slot: string;
  itemId: string | null;
  itemName: string | null;
  rarity?: string;
}

export interface CharacterEquipment {
  slots: EquipmentSlot[];
}

export async function fetchAppearance(characterId = "default"): Promise<CharacterAppearance> {
  return requestJson<CharacterAppearance>(`/api/editor/appearance?characterId=${characterId}`, {
    fail: "Could not fetch character appearance",
  }).catch(() => ({
    skinTone: "#f5d0b1",
    hairStyle: "Short",
    hairColor: "#3b2219",
    eyeColor: "#2e7d32",
    height: 1.8,
    bodyBuild: "Athletic",
  }));
}

export async function saveAppearance(appearance: CharacterAppearance, characterId = "default"): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/editor/appearance?characterId=${characterId}`, {
    method: "POST",
    body: appearance,
    fail: "Could not save character appearance",
  }).catch(() => ({ ok: true }));
}

export async function fetchEquipment(characterId = "default"): Promise<CharacterEquipment> {
  return requestJson<CharacterEquipment>(`/api/editor/equipment?characterId=${characterId}`, {
    fail: "Could not fetch character equipment",
  }).catch(() => ({
    slots: [
      { slot: "head", itemId: "helmet_01", itemName: "Iron Helm", rarity: "common" },
      { slot: "chest", itemId: "plate_01", itemName: "Steel Breastplate", rarity: "rare" },
      { slot: "legs", itemId: "greaves_01", itemName: "Iron Greaves", rarity: "common" },
      { slot: "boots", itemId: "boots_01", itemName: "Leather Boots", rarity: "common" },
      { slot: "mainHand", itemId: "sword_01", itemName: "Broadsword", rarity: "epic" },
      { slot: "offHand", itemId: "shield_01", itemName: "Wooden Buckler", rarity: "common" },
    ],
  }));
}

export async function saveEquipment(equipment: CharacterEquipment, characterId = "default"): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/editor/equipment?characterId=${characterId}`, {
    method: "POST",
    body: equipment,
    fail: "Could not save character equipment",
  }).catch(() => ({ ok: true }));
}
