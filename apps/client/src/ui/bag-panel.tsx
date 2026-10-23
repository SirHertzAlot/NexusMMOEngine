/**
 * BagPanel (roadmap M3a; U10's first cut): the player's bag from the
 * inventory message (0x14) — a grid of slots, each item's name in its
 * rank's colour, its details on focus, and a drop button. The server owns
 * the bag: every change comes back as a new inventory message, so this
 * panel holds no item state of its own.
 *
 * Equipping (M3b): the two hand slots with equip and unequip buttons.
 * U10a adds dragging (a bag item onto its hand slot equips it, a held
 * item onto the bag puts it away; double-click equips), a tooltip beside
 * the hovered item comparing it with what it would replace, and the held
 * items' stat totals. A drop sends the same equip or unequip message as
 * the buttons, so the server still decides.
 */

import { useRef, useState } from "react";
import { ARMOUR_SLOT_NAMES, type ArmourSlotName, type ItemView } from "@mmo-engine/protocol";
import { t, tName } from "../i18n.js";
/** Stats in a fixed, readable order; anything else follows alphabetically. */
const STAT_ORDER = ["power", "armour", "block", "spell", "speed", "crit", "reach", "health", "stagger"];

export function statLines(stats: Record<string, number>): Array<[string, number]> {
  const keys = Object.keys(stats).filter((k) => stats[k] !== 0);
  keys.sort((a, b) => {
    const ia = STAT_ORDER.indexOf(a);
    const ib = STAT_ORDER.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return a.localeCompare(b);
  });
  return keys.map((k) => [k, stats[k]]);
}

/** How an item is held ("one-handed"); empty for an item that is not held. */
const handLabel = (hand: ItemView["hand"]): string => (hand === "none" ? "" : t(`item.hand.${hand}`));

export function ItemDetails({ item }: { item: ItemView }): React.ReactElement {
  return (
    <div className="text-sm">
      <div className="font-semibold" style={{ color: item.color }}>
        {item.name}
      </div>
      <div className="text-xs text-muted-foreground">
        {item.rank} {item.base}
        {handLabel(item.hand) && <> · {handLabel(item.hand)}</>}
        {item.hand === "none" && item.slot && item.slot !== "none" && <> · {tName("slot", item.slot)}</>}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 tabular-nums">
        {statLines(item.stats).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{tName("stat", k)}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 text-xs text-muted-foreground tabular-nums">{t("bag.durability", { value: item.durability })}</div>
    </div>
  );
}

type Hands = { main: ItemView | null; off: ItemView | null };

/** What each armour slot wears; null: empty. */
export type Worn = Record<ArmourSlotName, ItemView | null>;

export const EMPTY_WORN: Worn = { head: null, chest: null, hands: null, legs: null, ring: null, amulet: null };

function armourSlotOf(item: ItemView): ArmourSlotName | null {
  const s = item.slot ?? "none";
  return (ARMOUR_SLOT_NAMES as readonly string[]).includes(s) ? (s as ArmourSlotName) : null;
}

/**
 * The slot an item goes into: a hand (a two-handed item rides in main),
 * an armour slot, or null when it can be neither held nor worn.
 */
export function slotFor(item: ItemView): "main" | "off" | ArmourSlotName | null {
  if (item.hand !== "none") return item.hand === "off" ? "off" : "main";
  return armourSlotOf(item);
}

/**
 * What equipping `item` pushes out, by the server's swap rules
 * (ItemService.equip/wear): main replaces main; off replaces off and a
 * two-handed main; two-handed empties both hands; armour replaces only
 * what its own slot wears.
 */
export function displaced(item: ItemView, hands: Hands, worn: Worn = EMPTY_WORN): ItemView[] {
  const out: ItemView[] = [];
  if (item.hand === "main") {
    if (hands.main) out.push(hands.main);
  } else if (item.hand === "off") {
    if (hands.off) out.push(hands.off);
    if (hands.main?.hand === "both") out.push(hands.main);
  } else if (item.hand === "both") {
    if (hands.main) out.push(hands.main);
    if (hands.off) out.push(hands.off);
  } else {
    const slot = armourSlotOf(item);
    if (slot && worn[slot]) out.push(worn[slot]);
  }
  return out;
}

/** The items' stats added up. */
export function sumStats(items: Array<ItemView | null>): Record<string, number> {
  const total: Record<string, number> = {};
  for (const it of items) {
    if (!it) continue;
    for (const k in it.stats) total[k] = (total[k] ?? 0) + it.stats[k];
  }
  return total;
}

/** Each stat's change from equipping `item`, in statLines order, zeros dropped. */
export function compareStats(item: ItemView, hands: Hands, worn: Worn = EMPTY_WORN): Array<[string, number]> {
  const gain = { ...item.stats };
  for (const o of displaced(item, hands, worn)) for (const k in o.stats) gain[k] = (gain[k] ?? 0) - o.stats[k];
  return statLines(gain);
}

/** The drag payload: "bag:<item id>" or "hand:<main|off>". */
const DRAG_TYPE = "application/x-mmo-item";

function signed(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

function ItemTooltip({ item, hands, worn, top }: { item: ItemView; hands: Hands; worn: Worn; top: number }): React.ReactElement {
  const out = displaced(item, hands, worn);
  const delta = out.length ? compareStats(item, hands, worn) : [];
  const target = slotFor(item);
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute right-full mr-2 w-56 rounded-lg border bg-card/95 p-2 text-card-foreground shadow-md"
      style={{ top }}
    >
      <ItemDetails item={item} />
      {target !== null && (
        <div className="mt-2 border-t pt-1 text-xs">
          <div className="text-muted-foreground">{out.length ? t("bag.versus", { names: out.map((o) => o.name).join(" + ") }) : t("bag.slotIsEmpty")}</div>
          {out.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 tabular-nums">
              {delta.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{tName("stat", k)}</span>
                  <span className={v > 0 ? "text-green-500" : "text-red-500"}>{signed(v)}</span>
                </div>
              ))}
              {delta.length === 0 && <div className="text-muted-foreground">{t("bag.noChange")}</div>}
            </div>
          )}
          <div className="mt-1 text-muted-foreground">{t("bag.equipHint")}</div>
        </div>
      )}
    </div>
  );
}

export function BagPanel({
  bag,
  hands,
  worn,
  onDrop,
  onEquip,
  onUnequip,
  gold = null,
}: {
  bag: Array<ItemView | null>;
  hands: Hands;
  worn: Worn;
  onDrop: (item: number) => void;
  onEquip: (item: number) => void;
  onUnequip: (slot: "main" | "off" | ArmourSlotName) => void;
  /** The wallet balance (0x21); null hides the line (the server runs no economy). */
  gold?: number | null;
}): React.ReactElement {
  const [focus, setFocus] = useState<number | null>(null);
  const [hover, setHover] = useState<{ id: number; top: number } | null>(null);
  // What is being dragged: dragover can't read dataTransfer's data, so the
  // drop targets check this instead.
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const shown = focus !== null ? bag.find((i) => i?.id === focus) ?? null : null;
  const hovered = hover !== null ? bag.find((i) => i?.id === hover.id) ?? null : null;
  const used = bag.filter((i) => i !== null).length;
  const totals = statLines(sumStats([hands.main, hands.off, ...ARMOUR_SLOT_NAMES.map((s) => worn[s])]));
  const draggedItem = (): ItemView | null => {
    const d = dragging.current;
    if (!d?.startsWith("bag:")) return null;
    const id = Number(d.slice(4));
    return bag.find((i) => i?.id === id) ?? null;
  };
  const endDrag = (): void => {
    dragging.current = null;
    setOver(null);
  };
  return (
    <div className="pointer-events-auto relative w-80 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm" aria-label={t("bag.title")}>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">{t("bag.title")}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {used}/{bag.length}
        </div>
      </div>
      <div className="mb-1 grid grid-cols-2 gap-1" aria-label={t("bag.hands")}>
        {(["main", "off"] as const).map((hand) => {
          const held = hands[hand];
          return (
            <button
              key={hand}
              type="button"
              className="flex items-center justify-between rounded border bg-background/60 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              style={{
                ...(held ? { borderColor: held.color, color: held.color } : { opacity: 0.6 }),
                ...(over === `hand:${hand}` ? { outline: "2px solid currentColor", opacity: 1 } : {}),
              }}
              title={held ? t("bag.heldTitle", { name: held.name, slot: tName("slot", hand) }) : t("bag.handEmpty", { slot: tName("slot", hand) })}
              aria-label={t("bag.handSlot", { slot: tName("slot", hand) })}
              draggable={!!held}
              onClick={() => held && onUnequip(hand)}
              onDragStart={(e) => {
                dragging.current = `hand:${hand}`;
                e.dataTransfer.setData(DRAG_TYPE, dragging.current);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                const item = draggedItem();
                if (!item || slotFor(item) !== hand) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(`hand:${hand}`);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                const item = draggedItem();
                if (item && slotFor(item) === hand) onEquip(item.id);
                endDrag();
              }}
            >
              <span className="text-muted-foreground">{tName("slot", hand)}</span>
              <span className="truncate">{held ? held.base : "—"}</span>
            </button>
          );
        })}
      </div>
      <div className="mb-1 grid grid-cols-3 gap-1" aria-label={t("bag.armour")}>
        {ARMOUR_SLOT_NAMES.map((slot) => {
          const piece = worn[slot];
          return (
            <button
              key={slot}
              type="button"
              className="flex items-center justify-between rounded border bg-background/60 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              style={{
                ...(piece ? { borderColor: piece.color, color: piece.color } : { opacity: 0.6 }),
                ...(over === `worn:${slot}` ? { outline: "2px solid currentColor", opacity: 1 } : {}),
              }}
              title={piece ? t("bag.wornTitle", { name: piece.name, slot: tName("slot", slot) }) : t("bag.slotEmpty", { slot: tName("slot", slot) })}
              aria-label={t("bag.slotLabel", { slot: tName("slot", slot) })}
              draggable={!!piece}
              onClick={() => piece && onUnequip(slot)}
              onDragStart={(e) => {
                dragging.current = `worn:${slot}`;
                e.dataTransfer.setData(DRAG_TYPE, dragging.current);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                const item = draggedItem();
                if (!item || slotFor(item) !== slot) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setOver(`worn:${slot}`);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                const item = draggedItem();
                if (item && slotFor(item) === slot) onEquip(item.id);
                endDrag();
              }}
            >
              <span className="text-muted-foreground">{tName("slot", slot)}</span>
              <span className="truncate">{piece ? piece.base : "—"}</span>
            </button>
          );
        })}
      </div>
      {totals.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground tabular-nums" aria-label={t("bag.equippedStats")}>
          {totals.map(([k, v]) => (
            <span key={k}>
              {tName("stat", k)} {v}
            </span>
          ))}
        </div>
      )}
      <div
        className="grid grid-cols-6 gap-1 rounded"
        style={over === "bag" ? { outline: "2px solid currentColor" } : undefined}
        aria-label={t("bag.slots")}
        onDragOver={(e) => {
          if (!dragging.current?.startsWith("hand:") && !dragging.current?.startsWith("worn:")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver("bag");
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const d = dragging.current;
          if (d?.startsWith("hand:")) onUnequip(d.slice(5) as "main" | "off");
          else if (d?.startsWith("worn:")) onUnequip(d.slice(5) as ArmourSlotName);
          endDrag();
        }}
      >
        {bag.map((item, i) => (
          <button
            key={i}
            type="button"
            className="flex aspect-square items-center justify-center overflow-hidden rounded border bg-background/60 p-0.5 text-center text-[9px] leading-tight focus:outline-none focus:ring-1 focus:ring-ring"
            style={item ? { borderColor: item.color, color: item.color } : undefined}
            aria-label={item ? item.name : t("bag.empty")}
            disabled={!item}
            draggable={!!item && slotFor(item) !== null}
            onMouseEnter={(e) => item && setHover({ id: item.id, top: e.currentTarget.offsetTop })}
            onMouseLeave={() => setHover(null)}
            onFocus={() => item && setFocus(item.id)}
            onClick={() => item && setFocus(item.id)}
            onDoubleClick={() => {
              if (item && slotFor(item) !== null) {
                onEquip(item.id);
                setFocus(null);
              }
            }}
            onDragStart={(e) => {
              if (!item) return;
              dragging.current = `bag:${item.id}`;
              setHover(null);
              e.dataTransfer.setData(DRAG_TYPE, dragging.current);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={endDrag}
          >
            {item ? item.base : ""}
          </button>
        ))}
      </div>
      {gold !== null && (
        <div className="mt-2 flex items-baseline justify-between text-xs" aria-label={t("bag.gold")}>
          <span className="text-muted-foreground">{t("bag.gold")}</span>
          <span className="font-semibold tabular-nums text-amber-400">{gold.toLocaleString()}</span>
        </div>
      )}
      {hovered && hover && <ItemTooltip item={hovered} hands={hands} worn={worn} top={hover.top} />}
      {shown ? (
        <div className="mt-2 border-t pt-2">
          <ItemDetails item={shown} />
          <div className="mt-2 flex gap-2">
            {slotFor(shown) !== null && (
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onEquip(shown.id);
                  setFocus(null);
                }}
              >
                {t("bag.equip")}
              </button>
            )}
            <button
              type="button"
              className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                onDrop(shown.id);
                setFocus(null);
              }}
            >
              {t("bag.drop")}
            </button>
          </div>
        </div>
      ) : (
        used === 0 && <div className="mt-2 text-xs text-muted-foreground">{t("bag.emptyHint")}</div>
      )}
    </div>
  );
}
