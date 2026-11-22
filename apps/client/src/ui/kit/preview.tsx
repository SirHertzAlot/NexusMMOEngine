/**
 * Before/after preview for the style kit.
 *
 * Mounts the REAL BagPanel and the REAL BagPanelKit side by side on the
 * same fixture bag, so the capture compares the two implementations rather
 * than a screenshot against a mockup. Nothing here is drawn by hand: what
 * you see is what the client renders.
 *
 * Built and captured by capture.mjs; not part of the shipped client bundle.
 */

import { createRoot } from "react-dom/client";
import type { ItemView } from "@mmo-engine/protocol";
import { BagPanel, EMPTY_WORN, type Worn } from "../bag-panel.js";
import { BagPanelKit } from "../bag-panel-kit.js";
import { initI18n } from "../../i18n.js";

declare const __STRINGS__: Record<string, Record<string, string>>;

initI18n(__STRINGS__);

/** One fixture bag, used by both panels so the comparison is like for like. */
const item = (
  id: number,
  name: string,
  base: string,
  rank: string,
  color: string,
  stats: Record<string, number>,
  at: { x: number; y: number; w: number; h: number },
  extra: Partial<ItemView> = {},
): ItemView => ({
  id,
  def: `def.${id}`,
  name,
  base,
  rank,
  color,
  hand: "none",
  slot: "none",
  stats,
  durability: 100,
  model: "",
  at: { ...at, rot: false },
  ...extra,
});

const sword = item(1, "Emberfang", "sword", "Rare", "#d8bd7d", { power: 24, crit: 6, reach: 2 }, { x: 0, y: 0, w: 1, h: 3 }, {
  hand: "main",
  durability: 86,
});
const shield = item(2, "Oakenward", "shield", "Uncommon", "#86b36a", { armour: 18, block: 12 }, { x: 1, y: 0, w: 2, h: 2 }, {
  hand: "off",
  durability: 94,
});
const helm = item(3, "Vigil Helm", "helm", "Rare", "#d8bd7d", { armour: 9, stagger: 4 }, { x: 3, y: 0, w: 2, h: 2 }, {
  slot: "head",
  durability: 71,
});
const ring = item(4, "Loop of Mending", "ring", "Epic", "#b08ad8", { spell: 11, health: 15 }, { x: 5, y: 0, w: 1, h: 1 }, {
  slot: "ring",
});
const herbs = item(5, "Marsh Herbs", "herbs", "Common", "#c2b08c", { health: 4 }, { x: 0, y: 3, w: 1, h: 1 }, {
  count: 12,
  maxStack: 20,
});
const ore = item(6, "Iron Ore", "ore", "Common", "#c2b08c", {}, { x: 1, y: 3, w: 2, h: 1 }, { count: 7, maxStack: 20 });
const cloak = item(7, "Wayfarer Cloak", "cloak", "Uncommon", "#86b36a", { armour: 6, speed: 3 }, { x: 3, y: 2, w: 2, h: 3 }, {
  slot: "chest",
  durability: 58,
});

const bag: Array<ItemView | null> = [sword, shield, helm, ring, herbs, ore, cloak];

const hands = {
  main: { ...sword, id: 101, name: "Thornbite", at: undefined } as ItemView,
  off: null,
};

const worn: Worn = {
  ...EMPTY_WORN,
  head: { ...helm, id: 102, at: undefined } as ItemView,
  chest: { ...cloak, id: 103, at: undefined } as ItemView,
};

const grid = { columns: 6, rows: 5, slots: 28 };

const noop = (): void => {};

function Pane({ title, note, children }: { title: string; note: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="pane">
      <div className="pane__title">{title}</div>
      <div className="pane__note">{note}</div>
      <div className="pane__stage">{children}</div>
    </div>
  );
}

function App(): React.ReactElement {
  return (
    <div className="sheet">
      <Pane title="Before" note="Current client — stock shadcn/Tailwind dark theme">
        <BagPanel
          bag={bag}
          hands={hands}
          worn={worn}
          onDrop={noop}
          onEquip={noop}
          onUnequip={noop}
          grid={grid}
          onMove={noop}
          gold={1240}
          onUse={noop}
        />
      </Pane>
      <Pane title="After" note="Same component tree, rebuilt on the style kit">
        <BagPanelKit
          bag={bag}
          hands={hands}
          worn={worn}
          onDrop={noop}
          onEquip={noop}
          onUnequip={noop}
          grid={grid}
          onMove={noop}
          gold={1240}
          onUse={noop}
        />
      </Pane>
    </div>
  );
}

/**
 * The kit's parts on one sheet: every material, both frames, the type
 * scale, all four button states, the slot states and the parchment
 * tooltip. A style kit that is only ever seen inside one screen cannot be
 * reviewed, so this sheet is what a reviewer actually looks at.
 */
function KitSheet(): React.ReactElement {
  return (
    <div className="kit kit-panel kit-sheetpanel">
      <div className="kit-panel__body kit-surface-leather">
        <h2 className="kit-title">Style kit</h2>
        <hr className="kit-divider" />

        <div className="kit-label">Materials</div>
        <div className="swatches">
          <div className="swatch kit-surface-leather"><span className="kit-tiny">leather</span></div>
          <div className="swatch kit-surface-iron"><span className="kit-tiny">iron</span></div>
          <div className="swatch kit-surface-parchment"><span className="kit-tiny">parchment</span></div>
          <div className="swatch kit-panel kit-swatch-frame"><span className="kit-tiny">bronze frame</span></div>
        </div>

        <hr className="kit-divider" />

        <div className="kit-label">Type scale</div>
        <div className="kit-title">Title 20</div>
        <div className="kit-heading">Heading 15</div>
        <div className="kit-body">Body 13 — the readable size</div>
        <div className="kit-small kit-soft">Small 12 secondary</div>
        <div className="kit-tiny kit-dim">Tiny 11 de-emphasised</div>

        <hr className="kit-divider" />

        <div className="kit-label">Button states</div>
        <div className="kit-btnrow">
          <button type="button" className="kit-btn">Rest</button>
          <button type="button" className="kit-btn hover-demo">Hover</button>
          <button type="button" className="kit-btn active-demo">Pressed</button>
          <button type="button" className="kit-btn" disabled>Disabled</button>
          <button type="button" className="kit-btn kit-btn--iron">Iron</button>
        </div>

        <hr className="kit-divider" />

        <div className="kit-label">Slot states</div>
        <div className="kit-slotstates">
          <div className="kit-slot kit-slot--cell"><span className="kit-tiny kit-soft">empty</span></div>
          <div className="kit-slot kit-slot--cell kit-slot--good"><span className="kit-tiny">allowed</span></div>
          <div className="kit-slot kit-slot--cell kit-slot--bad"><span className="kit-tiny">refused</span></div>
        </div>

        <hr className="kit-divider" />

        <div className="kit-label">Meter</div>
        <div className="kit-bar"><div className="kit-bar__fill" style={{ width: "62%" }} /></div>

        <hr className="kit-divider" />

        <div className="kit-label">Tooltip (parchment)</div>
        <div className="kit-tooltip kit-sheet-tooltip">
          <div className="kit-heading" style={{ color: "#8a5a2a" }}>Oakenward</div>
          <div className="kit-tiny kit-soft">Uncommon shield · off hand</div>
          <hr className="kit-divider" />
          <div className="kit-statgrid kit-num kit-small">
            <div className="kit-statrow"><span className="kit-soft">armour</span><span className="kit-good">+18</span></div>
            <div className="kit-statrow"><span className="kit-soft">speed</span><span className="kit-bad">-3</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <App />
    <div className="sheet sheet--kit">
      <Pane title="Style kit" note="Every part, one light direction, one palette">
        <KitSheet />
      </Pane>
    </div>
  </>,
);
