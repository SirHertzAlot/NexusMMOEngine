/**
 * The bag and character panel, rebuilt on the style kit.
 *
 * Same screen as bag-panel.tsx, same server messages, same interactions.
 * It imports that module's pure logic rather than restating it — the swap
 * rules, the stat maths and the grid occupancy stay in one place, so this
 * is a rebuild of the *presentation* only and the two versions can never
 * disagree about what equipping something does.
 *
 * Why this screen was the one to rebuild first: it is the densest surface
 * in the client and exercises every part of the kit at once — a framed
 * panel, inset slots, a drag state with an allowed/refused verdict, item
 * rarity colour, a stat table of changing numbers, a tooltip over a
 * textured ground, and four button states. An ability bar would have
 * proved only the button.
 *
 * Everything visual here comes from kit.css classes. This file sets no
 * colour, no radius and no spacing of its own; the only inline styles are
 * grid geometry (cell positions in px) and the server's own rarity colour.
 */

import { useEffect, useRef, useState } from "react";
import { ARMOUR_SLOT_NAMES, type ArmourSlotName, type ItemView } from "@mmo-engine/protocol";
import { dropCombineTarget, dropVerdict, occupancyOf } from "./bag-grid.js";
import { compareStats, displaced, slotFor, statLines, sumStats, type Worn } from "./bag-panel.js";
import { t, tName } from "../i18n.js";

const CELL_PX = 30;
const DRAG_TYPE = "application/x-mmo-item";

type Hands = { main: ItemView | null; off: ItemView | null };

const signed = (v: number): string => (v > 0 ? `+${v}` : `${v}`);

const handLabel = (hand: ItemView["hand"]): string => (hand === "none" ? "" : t(`item.hand.${hand}`));

/** Item name, rank line and stats. On parchment, so it takes the dark ink. */
function ItemDetails({ item }: { item: ItemView }): React.ReactElement {
  const count = item.count ?? 1;
  return (
    <div>
      <div className="kit-heading" style={{ color: item.color }}>
        {item.name}
        {count > 1 && <span className="kit-num kit-small kit-soft"> ×{count}</span>}
      </div>
      <div className="kit-tiny kit-soft">
        {item.rank} {item.base}
        {item.maxStack && item.maxStack > 1 && <> · {t("bag.stackOf", { count, max: item.maxStack })}</>}
        {handLabel(item.hand) && <> · {handLabel(item.hand)}</>}
        {item.hand === "none" && item.slot && item.slot !== "none" && <> · {tName("slot", item.slot)}</>}
      </div>
      <hr className="kit-divider" />
      <div className="kit-statgrid kit-num kit-small">
        {statLines(item.stats).map(([k, v]) => (
          <div key={k} className="kit-statrow">
            <span className="kit-soft">{tName("stat", k)}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
      <div className="kit-tiny kit-soft kit-num" style={{ marginTop: "var(--kit-space-1)" }}>
        {t("bag.durability", { value: item.durability })}
      </div>
    </div>
  );
}

/** The comparison tooltip: what this item would replace, and the difference. */
function ItemTooltip({ item, hands, worn, top }: { item: ItemView; hands: Hands; worn: Worn; top: number }): React.ReactElement {
  const out = displaced(item, hands, worn);
  const delta = out.length ? compareStats(item, hands, worn) : [];
  const target = slotFor(item);
  return (
    <div role="tooltip" className="kit-tooltip kit-tooltip--bag" style={{ top }}>
      <ItemDetails item={item} />
      {target !== null && (
        <>
          <hr className="kit-divider" />
          <div className="kit-tiny kit-soft">
            {out.length ? t("bag.versus", { names: out.map((o) => o.name).join(" + ") }) : t("bag.slotIsEmpty")}
          </div>
          {out.length > 0 && (
            <div className="kit-statgrid kit-num kit-small">
              {delta.map(([k, v]) => (
                <div key={k} className="kit-statrow">
                  <span className="kit-soft">{tName("stat", k)}</span>
                  <span className={v > 0 ? "kit-good" : "kit-bad"}>{signed(v)}</span>
                </div>
              ))}
              {delta.length === 0 && <div className="kit-soft">{t("bag.noChange")}</div>}
            </div>
          )}
          <div className="kit-tiny kit-soft" style={{ marginTop: "var(--kit-space-1)" }}>{t("bag.equipHint")}</div>
        </>
      )}
    </div>
  );
}

/** One equipment well: empty shows its slot name, filled shows the item. */
function EquipSlot({
  label,
  item,
  highlight,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  label: string;
  item: ItemView | null;
  highlight: boolean;
  onClick: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`kit-slot kit-equip ${highlight ? "kit-slot--good" : ""}`}
      aria-label={t("bag.handSlot", { slot: label })}
      title={item ? t("bag.heldTitle", { name: item.name, slot: label }) : t("bag.handEmpty", { slot: label })}
      draggable={!!item}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {item ? (
        <span className="kit-equip__name" style={{ color: item.color }}>{item.base}</span>
      ) : (
        <span className="kit-label kit-equip__empty">{label}</span>
      )}
    </button>
  );
}

/** The grid bag: items stand at their footprint, drag to move, R to turn. */
function GridBag({
  bag,
  grid,
  onMove,
  onCombine,
  onFocus,
  onEquip,
}: {
  bag: Array<ItemView | null>;
  grid: { columns: number; rows: number; slots: number };
  onMove: (item: number, x: number, y: number, rot: boolean) => void;
  onCombine?: (from: number, into: number) => void;
  onFocus: (id: number) => void;
  onEquip: (id: number) => void;
}): React.ReactElement {
  const items = bag.filter((i): i is ItemView => i !== null && i.at !== undefined);
  const el = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; rot: boolean; x: number; y: number } | null>(null);
  const cells = occupancyOf(items, grid);
  const held = drag ? items.find((i) => i.id === drag.id) : undefined;
  const footprint: [number, number] | null = held?.at ? [held.at.rot ? held.at.h : held.at.w, held.at.rot ? held.at.w : held.at.h] : null;
  const placement = drag ? { x: drag.x, y: drag.y, rot: drag.rot } : null;
  const verdict = drag && footprint && placement ? dropVerdict(grid, cells, footprint, placement, drag.id) : null;
  const combineTarget = drag && held && footprint && placement && verdict === "occupied" ? dropCombineTarget(grid, cells, items, held, footprint, placement) : null;
  const canLand = verdict === null || combineTarget !== null;
  const cellAt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = el.current!.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / CELL_PX), y: Math.floor((e.clientY - r.top) / CELL_PX) };
  };
  useEffect(() => {
    if (!drag) return;
    const key = (e: KeyboardEvent): void => {
      if (e.code === "KeyR") setDrag((d) => (d ? { ...d, rot: !d.rot } : d));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [drag]);
  return (
    <div
      ref={el}
      className="kit-slot kit-grid"
      style={{ width: grid.columns * CELL_PX, height: grid.rows * CELL_PX, backgroundSize: `${CELL_PX}px ${CELL_PX}px, ${CELL_PX}px ${CELL_PX}px, auto` }}
      aria-label={t("bag.slots")}
      onPointerMove={(e) => drag && setDrag({ ...drag, ...cellAt(e) })}
      onPointerUp={() => {
        if (drag) {
          if (combineTarget !== null) {
            if (onCombine) onCombine(drag.id, combineTarget);
            else onMove(drag.id, drag.x, drag.y, drag.rot);
          } else if (verdict === null) {
            onMove(drag.id, drag.x, drag.y, drag.rot);
          }
        }
        setDrag(null);
      }}
      onPointerLeave={() => setDrag(null)}
    >
      {Array.from({ length: grid.columns * grid.rows - grid.slots }, (_, k) => grid.slots + k).map((c) => (
        <div
          key={`x${c}`}
          className="kit-grid__blocked"
          style={{ left: (c % grid.columns) * CELL_PX, top: Math.floor(c / grid.columns) * CELL_PX, width: CELL_PX, height: CELL_PX }}
        />
      ))}
      {items.map((it) => {
        const a = it.at!;
        const count = it.count ?? 1;
        return (
          <button
            key={it.id}
            type="button"
            className="kit-item"
            style={{
              left: a.x * CELL_PX,
              top: a.y * CELL_PX,
              width: a.w * CELL_PX,
              height: a.h * CELL_PX,
              // The server owns rarity colour; the kit owns everything else.
              borderColor: it.color,
              color: it.color,
              opacity: drag?.id === it.id ? 0.4 : 1,
              touchAction: "none",
            }}
            aria-label={count > 1 ? `${it.name} ×${count}` : it.name}
            onPointerDown={(e) => {
              onFocus(it.id);
              setDrag({ id: it.id, rot: a.rot, ...cellAt(e) });
            }}
            onDoubleClick={() => onEquip(it.id)}
          >
            <span className="kit-item__label">{it.base}</span>
            {count > 1 && <span className="kit-item__count kit-num">×{count}</span>}
          </button>
        );
      })}
      {drag && footprint && (
        <div
          className={`kit-ghost ${canLand ? "kit-ghost--good" : "kit-ghost--bad"}`}
          style={{
            left: drag.x * CELL_PX,
            top: drag.y * CELL_PX,
            width: (drag.rot ? footprint[1] : footprint[0]) * CELL_PX,
            height: (drag.rot ? footprint[0] : footprint[1]) * CELL_PX,
          }}
        />
      )}
    </div>
  );
}

export function BagPanelKit({
  bag,
  hands,
  worn,
  onDrop,
  onEquip,
  onUnequip,
  grid = null,
  onMove,
  onCombine,
  gold = null,
  onUse,
}: {
  bag: Array<ItemView | null>;
  hands: Hands;
  worn: Worn;
  onDrop: (item: number) => void;
  onEquip: (item: number) => void;
  onUnequip: (slot: "main" | "off" | ArmourSlotName) => void;
  grid?: { columns: number; rows: number; slots: number } | null;
  onMove?: (item: number, x: number, y: number, rot: boolean) => void;
  onCombine?: (from: number, into: number) => void;
  gold?: number | null;
  onUse?: (item: number) => void;
}): React.ReactElement {
  const [focus, setFocus] = useState<number | null>(null);
  const [hover, setHover] = useState<{ id: number; top: number } | null>(null);
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const shown = focus !== null ? bag.find((i) => i?.id === focus) ?? null : null;
  const hovered = hover !== null ? bag.find((i) => i?.id === hover.id) ?? null : null;
  const used = bag.filter((i) => i !== null).length;
  const totals = statLines(sumStats([hands.main, hands.off, ...ARMOUR_SLOT_NAMES.map((s) => worn[s])]));

  const endDrag = (): void => {
    dragging.current = null;
    setOver(null);
  };
  const startDrag = (payload: string) => (e: React.DragEvent) => {
    dragging.current = payload;
    e.dataTransfer.setData(DRAG_TYPE, payload);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="kit kit-panel kit-bagpanel" aria-label={t("bag.title")}>
      <span className="kit-ornament kit-ornament--tl" aria-hidden="true" />
      <span className="kit-ornament kit-ornament--tr" aria-hidden="true" />
      <span className="kit-ornament kit-ornament--bl" aria-hidden="true" />
      <span className="kit-ornament kit-ornament--br" aria-hidden="true" />

      <div className="kit-panel__body kit-surface-leather kit-bagpanel__body">
        <header className="kit-bagpanel__head">
          <h2 className="kit-title">{t("bag.title")}</h2>
          <span className="kit-num kit-small kit-soft">
            {used}/{bag.length}
          </span>
        </header>

        <hr className="kit-divider" />

        <div className="kit-label">{t("bag.hands")}</div>
        <div className="kit-equiprow" aria-label={t("bag.hands")}>
          {(["main", "off"] as const).map((hand) => (
            <EquipSlot
              key={hand}
              label={tName("slot", hand)}
              item={hands[hand]}
              highlight={over === `hand:${hand}`}
              onClick={() => hands[hand] && onUnequip(hand)}
              onDragStart={startDrag(`hand:${hand}`)}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (dragging.current?.startsWith("bag:")) {
                  e.preventDefault();
                  setOver(`hand:${hand}`);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const d = dragging.current;
                if (d?.startsWith("bag:")) onEquip(Number(d.slice(4)));
                endDrag();
              }}
            />
          ))}
        </div>

        <div className="kit-label">{t("bag.armour")}</div>
        <div className="kit-equipgrid" aria-label={t("bag.armour")}>
          {ARMOUR_SLOT_NAMES.map((slot) => (
            <EquipSlot
              key={slot}
              label={tName("slot", slot)}
              item={worn[slot]}
              highlight={over === `worn:${slot}`}
              onClick={() => worn[slot] && onUnequip(slot)}
              onDragStart={startDrag(`worn:${slot}`)}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (dragging.current?.startsWith("bag:")) {
                  e.preventDefault();
                  setOver(`worn:${slot}`);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const d = dragging.current;
                if (d?.startsWith("bag:")) onEquip(Number(d.slice(4)));
                endDrag();
              }}
            />
          ))}
        </div>

        {totals.length > 0 && (
          <>
            <hr className="kit-divider" />
            <div className="kit-label">{t("bag.equippedStats")}</div>
            <div className="kit-statgrid kit-num kit-small">
              {totals.map(([k, v]) => (
                <div key={k} className="kit-statrow">
                  <span className="kit-soft">{tName("stat", k)}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <hr className="kit-divider" />

        <div className="kit-bagpanel__bagwrap">
          {grid ? (
            <GridBag
              bag={bag}
              grid={grid}
              onMove={onMove ?? (() => {})}
              onCombine={onCombine}
              onFocus={setFocus}
              onEquip={onEquip}
            />
          ) : (
            <div className="kit-slotrow" aria-label={t("bag.slots")}>
              {bag.map((item, i) => (
                <button
                  key={i}
                  type="button"
                  className="kit-slot kit-slot--cell"
                  aria-label={item ? item.name : t("bag.slotEmpty")}
                  onClick={() => item && setFocus(item.id)}
                  onMouseEnter={(e) => item && setHover({ id: item.id, top: e.currentTarget.offsetTop })}
                  onMouseLeave={() => setHover(null)}
                >
                  {item && <span className="kit-item__label" style={{ color: item.color }}>{item.base}</span>}
                </button>
              ))}
            </div>
          )}
          {hovered && <ItemTooltip item={hovered} hands={hands} worn={worn} top={hover!.top} />}
        </div>

        {gold !== null && (
          <div className="kit-bagpanel__gold kit-num kit-small">
            <span className="kit-label">{t("bag.gold")}</span>
            <span className="kit-warn">{gold.toLocaleString()}</span>
          </div>
        )}

        {shown && (
          <>
            <hr className="kit-divider" />
            <div className="kit-surface-parchment kit-detailcard">
              <ItemDetails item={shown} />
              <div className="kit-btnrow">
                {onUse && (
                  <button type="button" className="kit-btn" onClick={() => onUse(shown.id)}>
                    {t("bag.use")}
                  </button>
                )}
                <button type="button" className="kit-btn" onClick={() => onEquip(shown.id)}>
                  {t("bag.equip")}
                </button>
                <button type="button" className="kit-btn kit-btn--iron" onClick={() => onDrop(shown.id)}>
                  {t("bag.drop")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

BagPanelKit.displayName = "BagPanelKit";
