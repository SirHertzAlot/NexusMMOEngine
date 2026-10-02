/**
 * BagPanel (roadmap M3a; U10's first cut): the player's bag from the
 * inventory message (0x14) — a grid of slots, each item's name in its
 * rank's colour, its details on hover or focus, and a drop button. The
 * server owns the bag: every change comes back as a new inventory
 * message, so this panel holds no item state of its own.
 *
 * Equipping (the hands) arrives with held weapons (M3b).
 */

import { useState } from "react";
import type { ItemView } from "@mmo-engine/protocol";
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

const HAND_LABEL: Record<ItemView["hand"], string> = {
  main: "one-handed",
  off: "off hand",
  both: "two-handed",
  none: "",
};

export function ItemDetails({ item }: { item: ItemView }): React.ReactElement {
  return (
    <div className="text-sm">
      <div className="font-semibold" style={{ color: item.color }}>
        {item.name}
      </div>
      <div className="text-xs text-muted-foreground">
        {item.rank} {item.base}
        {HAND_LABEL[item.hand] && <> · {HAND_LABEL[item.hand]}</>}
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 tabular-nums">
        {statLines(item.stats).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <span className="text-muted-foreground">{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 text-xs text-muted-foreground tabular-nums">durability {item.durability}</div>
    </div>
  );
}

export function BagPanel({
  bag,
  hands,
  onDrop,
  onEquip,
  onUnequip,
}: {
  bag: Array<ItemView | null>;
  hands: { main: ItemView | null; off: ItemView | null };
  onDrop: (item: number) => void;
  onEquip: (item: number) => void;
  onUnequip: (hand: "main" | "off") => void;
}): React.ReactElement {
  const [focus, setFocus] = useState<number | null>(null);
  const shown = focus !== null ? bag.find((i) => i?.id === focus) ?? null : null;
  const used = bag.filter((i) => i !== null).length;
  return (
    <div className="pointer-events-auto w-80 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm" aria-label="bag">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">bag</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {used}/{bag.length}
        </div>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-1" aria-label="hands">
        {(["main", "off"] as const).map((hand) => {
          const held = hands[hand];
          return (
            <button
              key={hand}
              type="button"
              className="flex items-center justify-between rounded border bg-background/60 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
              style={held ? { borderColor: held.color, color: held.color } : undefined}
              title={held ? `${held.name} (${hand} hand): activate to put away` : `${hand} hand: empty`}
              disabled={!held}
              onClick={() => held && onUnequip(hand)}
            >
              <span className="text-muted-foreground">{hand}</span>
              <span className="truncate">{held ? held.base : "—"}</span>
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-6 gap-1">
        {bag.map((item, i) => (
          <button
            key={i}
            type="button"
            className="flex aspect-square items-center justify-center overflow-hidden rounded border bg-background/60 p-0.5 text-center text-[9px] leading-tight focus:outline-none focus:ring-1 focus:ring-ring"
            style={item ? { borderColor: item.color, color: item.color } : undefined}
            title={item ? item.name : "empty"}
            disabled={!item}
            onMouseEnter={() => item && setFocus(item.id)}
            onFocus={() => item && setFocus(item.id)}
          >
            {item ? item.base : ""}
          </button>
        ))}
      </div>
      {shown ? (
        <div className="mt-2 border-t pt-2">
          <ItemDetails item={shown} />
          <div className="mt-2 flex gap-2">
            {shown.hand !== "none" && (
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onEquip(shown.id);
                  setFocus(null);
                }}
              >
                equip
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
              drop
            </button>
          </div>
        </div>
      ) : (
        used === 0 && <div className="mt-2 text-xs text-muted-foreground">empty: walk up to a drop and press E</div>
      )}
    </div>
  );
}
