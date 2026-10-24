/**
 * The shop window (IX8, protocol 0x21): opened by E on a vendor, it lists what the
 * vendor sells with prices and a buy button, and lets the player sell a bag item for
 * the buyback share of the item's price. The server owns the stock and the gold: every
 * answer comes back as a vendor or wallet message, and a refusal as an error.
 */

import type { InventoryMessage, VendorMessage } from "@mmo-engine/protocol";
import { t } from "../i18n.js";

export interface ShopView {
  vendor: string;
  name: string;
  stock: NonNullable<VendorMessage["stock"]>;
  buybackRate: number;
}

/** The shop after a vendor message: a price list opens or refreshes it; buy and sell confirmations leave the list as it was. */
export function nextShop(prev: ShopView | null, m: VendorMessage): ShopView | null {
  if (m.state !== "listed") return prev;
  return { vendor: m.vendor, name: m.name ?? "", stock: m.stock ?? [], buybackRate: m.buybackRate ?? 0 };
}

export function VendorPanel({
  shop,
  gold,
  bag,
  onBuy,
  onSell,
  onClose,
}: {
  shop: ShopView;
  gold: number | null;
  bag: InventoryMessage["bag"];
  onBuy: (def: number) => void;
  onSell: (item: number) => void;
  onClose: () => void;
}): React.ReactElement {
  const items = bag.filter((i): i is NonNullable<typeof i> => i !== null);
  return (
    <div className="pointer-events-auto w-80 rounded-lg border bg-card/90 p-3 text-card-foreground shadow-sm" aria-label={t("vendor.title", { name: shop.name })}>
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-semibold">{shop.name}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {gold !== null && <span>{t("vendor.gold", { gold })}</span>}
          <button type="button" className="rounded border px-1.5 text-xs hover:text-foreground" onClick={onClose} aria-label={t("vendor.close")}>
            ×
          </button>
        </div>
      </div>
      <div className="mb-1 text-xs uppercase text-muted-foreground">{t("vendor.buy")}</div>
      {shop.stock.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t("vendor.nothing")}</div>
      ) : (
        <ul className="mb-2 space-y-1">
          {shop.stock.map((s) => (
            <li key={s.def} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {s.name}
                {s.quantity > 0 && <span className="ml-1 text-xs text-muted-foreground">×{s.quantity}</span>}
              </span>
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-xs tabular-nums text-muted-foreground hover:text-foreground disabled:opacity-40"
                disabled={s.quantity === 0 || (gold !== null && gold < s.price)}
                onClick={() => onBuy(s.def)}
              >
                {t("vendor.price", { price: s.price })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mb-1 text-xs uppercase text-muted-foreground">{t("vendor.sell", { rate: Math.round(shop.buybackRate * 100) })}</div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t("vendor.bagEmpty")}</div>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
              <span style={{ color: i.color }}>{i.name}</span>
              <button type="button" className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => onSell(i.id)}>
                {t("vendor.sellButton")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
