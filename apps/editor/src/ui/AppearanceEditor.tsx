/**
 * Appearance & Equipment Editor UI Pane (A6)
 * Provides tabs for character appearance customization and equipment slots.
 */

import * as React from "react";
import {
  fetchAppearance,
  saveAppearance,
  fetchEquipment,
  saveEquipment,
  type CharacterAppearance,
  type CharacterEquipment,
} from "../api/appearance.js";
import { notify } from "./components.js";

export function AppearanceEditor(): React.JSX.Element {
  const [tab, setTab] = React.useState<"appearance" | "equipment">("appearance");
  const [appearance, setAppearance] = React.useState<CharacterAppearance>({
    skinTone: "#f5d0b1",
    hairStyle: "Short",
    hairColor: "#3b2219",
    eyeColor: "#2e7d32",
    height: 1.8,
    bodyBuild: "Athletic",
  });
  const [equipment, setEquipment] = React.useState<CharacterEquipment>({
    slots: [
      { slot: "head", itemId: "helmet_01", itemName: "Iron Helm", rarity: "common" },
      { slot: "chest", itemId: "plate_01", itemName: "Steel Breastplate", rarity: "rare" },
      { slot: "legs", itemId: "greaves_01", itemName: "Iron Greaves", rarity: "common" },
      { slot: "boots", itemId: "boots_01", itemName: "Leather Boots", rarity: "common" },
      { slot: "mainHand", itemId: "sword_01", itemName: "Broadsword", rarity: "epic" },
      { slot: "offHand", itemId: "shield_01", itemName: "Wooden Buckler", rarity: "common" },
    ],
  });
  const [loading, setLoading] = React.useState<boolean>(false);

  React.useEffect(() => {
    let mounted = true;
    Promise.all([fetchAppearance(), fetchEquipment()])
      .then(([appData, eqData]) => {
        if (!mounted) return;
        if (appData) setAppearance(appData);
        if (eqData) setEquipment(eqData);
      })
      .catch(() => {
        // Fallback to mock data already initialized
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleSaveAppearance() {
    setLoading(true);
    try {
      await saveAppearance(appearance);
      notify("Character appearance saved successfully.");
    } catch (e: any) {
      notify(`Failed to save appearance: ${e?.message ?? "unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveEquipment() {
    setLoading(true);
    try {
      await saveEquipment(equipment);
      notify("Character equipment saved successfully.");
    } catch (e: any) {
      notify(`Failed to save equipment: ${e?.message ?? "unknown error"}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col p-4 text-sm" style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface)" }}>
      {/* Sub-tabs header */}
      <div className="flex items-center gap-2 border-b border-outline-variant pb-2 mb-4">
        <button
          type="button"
          onClick={() => setTab("appearance")}
          className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-colors`}
          style={{
            background: tab === "appearance" ? "var(--m3-primary)" : "var(--m3-surface-2)",
            color: tab === "appearance" ? "var(--m3-on-primary)" : "var(--m3-on-surface)",
          }}
        >
          🎨 Appearance
        </button>
        <button
          type="button"
          onClick={() => setTab("equipment")}
          className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-colors`}
          style={{
            background: tab === "equipment" ? "var(--m3-primary)" : "var(--m3-surface-2)",
            color: tab === "equipment" ? "var(--m3-on-primary)" : "var(--m3-on-surface)",
          }}
        >
          🛡️ Equipment
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pr-1">
        {tab === "appearance" && (
          <div className="flex flex-col gap-4 max-w-md">
            <h3 className="font-semibold text-base mb-1">Character Appearance Customization</h3>
            
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-on-surface-variant">Skin Tone</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={appearance.skinTone}
                  onChange={(e) => setAppearance({ ...appearance, skinTone: e.target.value })}
                  className="h-8 w-12 rounded border border-outline cursor-pointer"
                  aria-label="Skin Tone"
                />
                <input
                  type="text"
                  value={appearance.skinTone}
                  onChange={(e) => setAppearance({ ...appearance, skinTone: e.target.value })}
                  className="flex-1 rounded border border-outline px-2 py-1 text-xs bg-surface-0 text-on-surface"
                />
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-on-surface-variant">Hair Style</span>
              <select
                value={appearance.hairStyle}
                onChange={(e) => setAppearance({ ...appearance, hairStyle: e.target.value })}
                className="rounded border border-outline px-2 py-1.5 text-xs bg-surface-0 text-on-surface"
                aria-label="Hair Style"
              >
                <option value="Short">Short</option>
                <option value="Long">Long</option>
                <option value="Bald">Bald</option>
                <option value="Spiky">Spiky</option>
                <option value="Braided">Braided</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-on-surface-variant">Hair Color</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={appearance.hairColor}
                  onChange={(e) => setAppearance({ ...appearance, hairColor: e.target.value })}
                  className="h-8 w-12 rounded border border-outline cursor-pointer"
                  aria-label="Hair Color"
                />
                <input
                  type="text"
                  value={appearance.hairColor}
                  onChange={(e) => setAppearance({ ...appearance, hairColor: e.target.value })}
                  className="flex-1 rounded border border-outline px-2 py-1 text-xs bg-surface-0 text-on-surface"
                />
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-on-surface-variant">Eye Color</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={appearance.eyeColor}
                  onChange={(e) => setAppearance({ ...appearance, eyeColor: e.target.value })}
                  className="h-8 w-12 rounded border border-outline cursor-pointer"
                  aria-label="Eye Color"
                />
                <input
                  type="text"
                  value={appearance.eyeColor}
                  onChange={(e) => setAppearance({ ...appearance, eyeColor: e.target.value })}
                  className="flex-1 rounded border border-outline px-2 py-1 text-xs bg-surface-0 text-on-surface"
                />
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-on-surface-variant">Height ({appearance.height.toFixed(2)}m)</span>
              <input
                type="range"
                min="1.0"
                max="2.5"
                step="0.05"
                value={appearance.height}
                onChange={(e) => setAppearance({ ...appearance, height: parseFloat(e.target.value) })}
                className="accent-primary cursor-pointer"
                aria-label="Height"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-on-surface-variant">Body Build</span>
              <select
                value={appearance.bodyBuild}
                onChange={(e) => setAppearance({ ...appearance, bodyBuild: e.target.value })}
                className="rounded border border-outline px-2 py-1.5 text-xs bg-surface-0 text-on-surface"
                aria-label="Body Build"
              >
                <option value="Slim">Slim</option>
                <option value="Athletic">Athletic</option>
                <option value="Muscular">Muscular</option>
                <option value="Heavy">Heavy</option>
              </select>
            </label>

            <div className="pt-2">
              <button
                type="button"
                onClick={handleSaveAppearance}
                disabled={loading}
                className="rounded px-4 py-2 text-xs font-semibold shadow transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}
              >
                {loading ? "Saving..." : "Save Appearance"}
              </button>
            </div>
          </div>
        )}

        {tab === "equipment" && (
          <div className="flex flex-col gap-4 max-w-lg">
            <h3 className="font-semibold text-base mb-1">Character Equipment & Gear</h3>
            <p className="text-xs text-on-surface-variant">Manage equipped armor, weapons, and accessories across slots.</p>

            <div className="grid grid-cols-1 gap-2">
              {equipment.slots.map((slotItem, idx) => (
                <div
                  key={slotItem.slot}
                  className="flex items-center justify-between rounded-lg border border-outline-variant p-3"
                  style={{ background: "var(--m3-surface-0)" }}
                >
                  <div className="flex flex-col">
                    <span className="text-xs font-bold uppercase tracking-wider text-on-surface-variant">
                      {slotItem.slot}
                    </span>
                    <span className="text-sm font-medium">{slotItem.itemName ?? "Empty"}</span>
                    {slotItem.rarity && (
                      <span className="text-[10px] uppercase text-primary font-semibold">{slotItem.rarity}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={slotItem.itemName ?? ""}
                      onChange={(e) => {
                        const newSlots = [...equipment.slots];
                        newSlots[idx] = { ...slotItem, itemName: e.target.value };
                        setEquipment({ ...equipment, slots: newSlots });
                      }}
                      placeholder="Item name"
                      className="rounded border border-outline px-2 py-1 text-xs bg-surface-1 text-on-surface"
                      aria-label={`Item name for ${slotItem.slot}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const newSlots = [...equipment.slots];
                        newSlots[idx] = { ...slotItem, itemId: null, itemName: null, rarity: undefined };
                        setEquipment({ ...equipment, slots: newSlots });
                      }}
                      className="rounded px-2 py-1 text-xs text-error hover:bg-error/10"
                      title="Unequip"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={handleSaveEquipment}
                disabled={loading}
                className="rounded px-4 py-2 text-xs font-semibold shadow transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)" }}
              >
                {loading ? "Saving..." : "Save Equipment"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
