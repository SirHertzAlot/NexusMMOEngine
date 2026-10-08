/**
 * VendorSystem: price lists, buying, selling, stock, and reach.
 * Item movement is a stub; the ItemService wiring lives in server.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WalletSystem } from "../../src/economy/wallet.js";
import { VendorSystem, type VendorItems } from "../../src/economy/vendor.js";
import type { SimWorld } from "../../src/world.js";
import * as C from "../../src/components.js";

/** Minimal world: entity -> {x, z}. */
function worldAt(pos: Map<number, { x: number; z: number }>): SimWorld {
  const T = C.Transform;
  for (const [e, p] of pos) {
    T.px[e] = p.x;
    T.pz[e] = p.z;
  }
  return {} as SimWorld;
}

function setup() {
  const wallet = new WalletSystem();
  // charId -> item ids; item id -> def.
  const bags = new Map<number, number[]>();
  const defOf = new Map<number, number>();
  let nextItem = 1000;
  const items: VendorItems = {
    give: (c, def) => {
      const bag = bags.get(c) ?? [];
      if (bag.length >= 20) return false;
      const id = nextItem++;
      bag.push(id);
      bags.set(c, bag);
      defOf.set(id, def);
      return true;
    },
    take: (c, item) => {
      const bag = bags.get(c);
      const i = bag?.indexOf(item) ?? -1;
      if (!bag || i < 0) return false;
      bag.splice(i, 1);
      defOf.delete(item);
      return true;
    },
    defOf: (item) => defOf.get(item) ?? -1,
  };
  const vendor = new VendorSystem(wallet, items);
  vendor.define({
    id: "general",
    name: "General Goods",
    buybackRate: 0.3,
    stock: [
      { def: 1, price: 50, quantity: -1 }, // infinite
      { def: 2, price: 100, quantity: 2 }, // finite
    ],
  });
  return { wallet, vendor, bags, defOf };
}

const BUYER = 1;
const BUYER_E = 10;
const VENDOR_E = 11;
// near/far share the global Transform arrays, so they need distinct
// entities — otherwise far's setup would clobber near's positions.
const FAR_BUYER_E = 20;
const FAR_VENDOR_E = 21;
const near = worldAt(
  new Map([
    [BUYER_E, { x: 0, z: 0 }],
    [VENDOR_E, { x: 1, z: 0 }],
  ]),
);
const far = worldAt(
  new Map([
    [FAR_BUYER_E, { x: 0, z: 0 }],
    [FAR_VENDOR_E, { x: 100, z: 0 }],
  ]),
);

describe("VendorSystem", () => {
  it("buying moves gold to the vendor and the item to the bag", () => {
    const { wallet, vendor, bags } = setup();
    vendor.attach(VENDOR_E, "general");
    wallet.grant(BUYER, 200, 1);
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 1, 2), null);
    assert.equal(wallet.balanceOf(BUYER), 150);
    assert.equal(bags.get(BUYER)?.length, 1);
    assert.equal(vendor.list(VENDOR_E)?.stock.find((s) => s.def === 1)?.quantity, -1, "infinite stock untouched");
  });

  it("buy refuses when broke, far, or out of stock", () => {
    const { wallet, vendor } = setup();
    vendor.attach(VENDOR_E, "general");
    vendor.attach(FAR_VENDOR_E, "general");
    wallet.grant(BUYER, 10, 1);
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 1, 2), "not enough gold");
    wallet.grant(BUYER, 1000, 3);
    assert.equal(vendor.buy(far, BUYER, FAR_BUYER_E, FAR_VENDOR_E, 1, 4), "too far from the vendor");
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 999, 5), "the vendor doesn't sell that");
    // Finite stock: two sales, then empty.
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 2, 6), null);
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 2, 7), null);
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 2, 8), "out of stock");
  });

  it("a full bag refunds the gold", () => {
    const { wallet, vendor, bags } = setup();
    vendor.attach(VENDOR_E, "general");
    wallet.grant(BUYER, 1000, 1);
    bags.set(BUYER, Array.from({ length: 20 }, (_, i) => 500 + i)); // full
    assert.equal(vendor.buy(near, BUYER, BUYER_E, VENDOR_E, 1, 2), "your bag is full");
    assert.equal(wallet.balanceOf(BUYER), 1000, "refunded");
  });

  it("selling pays the buyback price and destroys the item", () => {
    const { wallet, vendor, bags, defOf } = setup();
    vendor.attach(VENDOR_E, "general");
    // Give the buyer an item of def 1 (price 50, buyback 30% -> 15).
    bags.set(BUYER, [701]);
    defOf.set(701, 1);
    assert.equal(vendor.sell(near, BUYER, BUYER_E, VENDOR_E, 701, 2), null);
    assert.equal(wallet.balanceOf(BUYER), 15);
    assert.equal(bags.get(BUYER)?.length, 0);
  });

  it("sell refuses unknown items, unwanted defs, and distance", () => {
    const { wallet, vendor, bags, defOf } = setup();
    vendor.attach(VENDOR_E, "general");
    vendor.attach(FAR_VENDOR_E, "general");
    assert.equal(vendor.sell(near, BUYER, BUYER_E, VENDOR_E, 999, 1), "no such item");
    bags.set(BUYER, [702]);
    defOf.set(702, 4242); // not stocked
    assert.equal(vendor.sell(near, BUYER, BUYER_E, VENDOR_E, 702, 2), "the vendor doesn't want that");
    bags.set(BUYER, [703]);
    defOf.set(703, 1);
    assert.equal(vendor.sell(far, BUYER, FAR_BUYER_E, FAR_VENDOR_E, 703, 3), "too far from the vendor");
    assert.equal(wallet.balanceOf(BUYER), 0, "nothing paid");
  });

  it("attaching an unknown template fails; list is a copy", () => {
    const { vendor } = setup();
    assert.equal(vendor.attach(VENDOR_E, "nope"), false);
    assert.equal(vendor.list(VENDOR_E), null);
    vendor.attach(VENDOR_E, "general");
    const view = vendor.list(VENDOR_E)!;
    view.stock[0].quantity = 0;
    assert.notEqual(vendor.list(VENDOR_E)?.stock[0].quantity, 0, "internal stock untouched");
  });
});
