# `@mmo-engine/kit-economy`

The trade, the things worth taking, and the people who live in the world. It
is a kit, not a part of the engine: nothing in `@mmo-engine/engine-core`
imports it, and a game that wants a different economy does not have to work
around this one.

## What is in it

Eight systems, in the order a host ticks them:

| System | What it does |
| --- | --- |
| `GatheringSystem` | A node worth mining, the pouch it fills, and the regrow |
| `ChestSystem` | A container worth opening, what it holds, and the refill |
| `BreakSystem` | A barrel, crate, urn or building part worth breaking, and repairing one |
| `WalletSystem` | Gold: what a character has, and every change to it |
| `TradeSystem` | Two players swapping goods, and the escrow between them |
| `VendorSystem` | A shopkeeper's stock, prices and restocking |
| `AuctionSystem` | Listings, bids, settlement and expiry |
| `ResidentSystem` | A baked town's people living a day in the world |

Plus what persists (`SqliteWalletStore`, `SqliteGatheringStore`), what a
master teaches (`lessonTerms` and the curve behind it), and
`defaultDungeonWorld`, which fills a dungeon run's world slot
(`DungeonWorldContext` in the engine) with the three of these a run dresses
itself with.

## How a host finds them

By port, never by class. The gateway asks its `PortSet` for `gathering`,
`chests`, `breaks`, `wallet`, `trade`, `vendors`, `auction` or `residents` and
takes whatever answers, and the server's entry point asks the service registry
for a `GatheringService`, `ChestService` or `BreakService` — a different and
narrower demand, because a host reaching a system is not a player reaching a
node.

A port nothing offers is a feature that run lacks, not an error. Drop
`modules/economy` and there is no gold, no trade, no shop and no auction house,
and the gateway answers those requests unsupported; the rest of the world runs.

## What the host keeps, and why

This is the part worth reading before you fork anything. Four things stayed
with the engine on purpose, and a system here takes each as an argument rather
than owning it:

- **`places.db`** (`PlacesStore`). A break and an opened chest ride the range
  snapshot, and recall seeds them back. That is the region's business with the
  world server, not a game's.
- **The respawn pool.** Everything that respawns shares one, so a chest, a
  barrel and a creature cannot disagree about what a handle means.
- **`CollapseSystem`.** A broken part is what topples a building, and toppling
  is the world's business. `BreakSystem` reports the break; the host decides
  what falls down.
- **The loot table and the item ledger.** What a kill or a smashed crate drops
  is content the host rolls.

## Changing it

In rising order of cost, which is the engine's usual framing — the cheapest
layer that expresses what you want:

1. **Data.** Prices, stock, regrow times, the lesson curve and what a profession
   teaches are all content: `content/vendors.json`, `content/lessons.json`,
   `content/rules/gathering.json`, the resource-node specs a scene carries.
2. **Module wiring.** `modules/economy/`, `modules/gathering/`, `modules/props/`
   and `modules/residents/` build these systems and hand them the host's
   pieces. Change what a module passes, or disable it, without touching this
   package.
3. **One system.** Each file here is one system and imports no other system in
   this package except through the barrel, so you can replace `VendorSystem`
   alone: write yours, offer the `vendors` port, and have your module build it
   instead. Nothing else in the kit or the engine needs to know.
4. **The kit.** Fork it, or ignore it and write your own. The engine's side of
   the contract is the ports, the three services, and the shared vocabulary in
   `engine-core/src/vocabulary.ts` — all of it declared where neither side owns
   it.

Nothing here limits what your game may do. The costs above are what each change
takes, not permission to make it.
