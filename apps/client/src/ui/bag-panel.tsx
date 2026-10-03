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

type Hands = { main: ItemView | null; off: ItemView | null };

/** The hand slot an item goes into (a two-handed item rides in main), or null. */
export function slotFor(item: ItemView): "main" | "off" | null {
  if (item.hand === "none") return null;
  return item.hand === "off" ? "off" : "main";
}

/**
 * What equipping `item` pushes out of the hands, by the server's swap
 * rules (ItemService.equip): main replaces main; off replaces off and a
 * two-handed main; two-handed empties both hands.
 */
export function displaced(item: ItemView, hands: Hands): ItemView[] {
  const out: ItemView[] = [];
  if (item.hand === "main") {
    if (hands.main) out.push(hands.main);
  } else if (item.hand === "off") {
    if (hands.off) out.push(hands.off);
    if (hands.main?.hand === "both") out.push(hands.main);
  } else if (item.hand === "both") {
    if (hands.main) out.push(hands.main);
    if (hands.off) out.push(hands.off);
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
export function compareStats(item: ItemView, hands: Hands): Array<[string, number]> {
  const gain = { ...item.stats };
  for (const o of displaced(item, hands)) for (const k in o.stats) gain[k] = (gain[k] ?? 0) - o.stats[k];
  return statLines(gain);
}

/** The drag payload: "bag:<item id>" or "hand:<main|off>". */
const DRAG_TYPE = "application/x-mmo-item";

function signed(v: number): string {
  return v > 0 ? `+${v}` : `${v}`;
}

function ItemTooltip({ item, hands, top }: { item: ItemView; hands: Hands; top: number }): React.ReactElement {
  const out = displaced(item, hands);
  const delta = out.length ? compareStats(item, hands) : [];
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute right-full mr-2 w-56 rounded-lg border bg-card/95 p-2 text-card-foreground shadow-md"
      style={{ top }}
    >
      <ItemDetails item={item} />
      {item.hand !== "none" && (
        <div className="mt-2 border-t pt-1 text-xs">
          <div className="text-muted-foreground">{out.length ? `vs ${out.map((o) => o.name).join(" + ")}` : "hand is empty"}</div>
          {out.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 tabular-nums">
              {delta.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{k}</span>
                  <span className={v > 0 ? "text-green-500" : "text-red-500"}>{signed(v)}</span>
                </div>
              ))}
              {delta.length === 0 && <div className="text-muted-foreground">no change</div>}
            </div>
          )}
          <div className="mt-1 text-muted-foreground">drag to a hand or double-click to equip</div>
        </div>
      )}
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
  hands: Hands;
  onDrop: (item: number) => void;
  onEquip: (item: number) => void;
  onUnequip: (hand: "main" | "off") => void;
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
  const totals = statLines(sumStats([hands.main, hands.off]));
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
    <div className="pointer-events-auto relative w-80 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm" aria-label="bag">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">bag</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {used}/{bag.length}
        </div>
      </div>
      <div className="mb-1 grid grid-cols-2 gap-1" aria-label="hands">
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
              title={held ? `${held.name} (${hand} hand): activate or drag to the bag to put away` : `${hand} hand: empty`}
              aria-label={`${hand} hand`}
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
              <span className="text-muted-foreground">{hand}</span>
              <span className="truncate">{held ? held.base : "—"}</span>
            </button>
          );
        })}
      </div>
      {totals.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground tabular-nums" aria-label="held stats">
          {totals.map(([k, v]) => (
            <span key={k}>
              {k} {v}
            </span>
          ))}
        </div>
      )}
      <div
        className="grid grid-cols-6 gap-1 rounded"
        style={over === "bag" ? { outline: "2px solid currentColor" } : undefined}
        aria-label="bag slots"
        onDragOver={(e) => {
          if (!dragging.current?.startsWith("hand:")) return;
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
          endDrag();
        }}
      >
        {bag.map((item, i) => (
          <button
            key={i}
            type="button"
            className="flex aspect-square items-center justify-center overflow-hidden rounded border bg-background/60 p-0.5 text-center text-[9px] leading-tight focus:outline-none focus:ring-1 focus:ring-ring"
            style={item ? { borderColor: item.color, color: item.color } : undefined}
            aria-label={item ? item.name : "empty"}
            disabled={!item}
            draggable={!!item && item.hand !== "none"}
            onMouseEnter={(e) => item && setHover({ id: item.id, top: e.currentTarget.offsetTop })}
            onMouseLeave={() => setHover(null)}
            onFocus={() => item && setFocus(item.id)}
            onClick={() => item && setFocus(item.id)}
            onDoubleClick={() => {
              if (item && item.hand !== "none") {
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
      {hovered && hover && <ItemTooltip item={hovered} hands={hands} top={hover.top} />}
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
