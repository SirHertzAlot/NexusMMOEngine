/**
 * What a resident says (SG3b, R5): a line generated from who they are, where they work, the hour and the
 * day, with no authored script. It is a pure function of the npc, the day and the state of the town, so a
 * resident says the same thing all day to everyone and something else tomorrow; each part is picked by
 * a hash of the npc id and the day. Raids and the small hours have lines of their own.
 */

import type { Npc } from "./occupancy.js";
import { hashOf } from "./schedule.js";

export interface BarkContext {
  /** 0..1, 0 midnight. */
  timeOfDay: number;
  /** The game day number (the line changes with it). */
  day: number;
  /** The town is being raided now. */
  raid?: boolean;
  /** The archetype of the npc's workplace (bakery, smithy...), if any. */
  workplace?: string;
  /** The town's name or id, for local colour. */
  town?: string;
}

const pick = <T>(list: readonly T[], h: number): T => list[h % list.length]!;

const GREET: Record<"morning" | "day" | "evening" | "night", readonly string[]> = {
  morning: ["Good morning.", "Early start, eh?", "Morning, traveller.", "Morning. Mind the road."],
  day: ["Well met.", "Good day.", "Hello there.", "Afternoon, traveller."],
  evening: ["Evening.", "Getting dark soon.", "Good evening to you.", "Evening, stranger."],
  night: ["Shouldn't you be abed?", "Late to be out.", "Quiet tonight.", "Keep your voice down, folk are sleeping."],
};

const WORK: Record<string, readonly string[]> = {
  bakery: ["The bread's fresh from the oven.", "Flour's dear this season.", "I was up before the sun for these loaves."],
  master_bakery: ["The bread's fresh from the oven.", "Folk come from three villages for my loaves."],
  smithy: ["The forge never goes cold.", "Iron's scarce, but I make do.", "Mind the sparks."],
  master_smithy: ["The forge never goes cold.", "I could shoe a horse in my sleep."],
  tavern: ["Ale's cold and the stew is hot.", "Come in for a drink, the fire's lit.", "Plenty of rumours for the price of a pint."],
  inn: ["There's a bed upstairs if you've coin.", "The road's long, the beds are soft.", "Stables are round the back."],
  market: ["Best prices in town, I swear it.", "Fresh and cheap, come and see.", "Everything weighed honest."],
  shop: ["Take a look, no harm in looking.", "What can I find for you?", "Stock came in this week."],
  chapel: ["May the light keep you.", "Peace be with you.", "The door is always open."],
  parish_church: ["May the light keep you.", "The bells will ring soon."],
  guardhouse: ["Keep your blade sheathed in town.", "Nothing to report. Keep it that way.", "We watch the gate day and night."],
  watch_hq: ["Keep the peace and we'll get along.", "The watch is always listening."],
  sawmill: ["Timber's coming down from the hills.", "Mind the saw."],
  fishery: ["The catch was good today.", "Smells of fish, I know. You get used to it."],
  mill: ["The wheel turns, the grain flows.", "Flour dust gets everywhere."],
  farmstead: ["The fields won't tend themselves.", "Rain's what we need.", "A good harvest feeds the town."],
  apothecary: ["Herbs for what ails you.", "A tincture for every trouble."],
  hospital: ["If you're hurt, we can help.", "Rest and clean water, that's all most need."],
};

const WORKER_GENERIC: readonly string[] = ["Work doesn't do itself.", "Busy day.", "Can't stop long, I'm afraid.", "Plenty to do."];
const CLASS: Record<string, readonly string[]> = {
  noble: ["I trust you've business here.", "Do be brief."],
  clergy: ["Bless you.", "Be kind to one another."],
  guard: ["Move along, nothing to see.", "Stay out of trouble."],
  merchant: ["Business is business.", "Coin keeps the town alive."],
};
const CHILD: readonly string[] = ["Hello! Do you have any sweets?", "Want to play?", "I'm not supposed to talk to strangers.", "Look what I found!"];
const BEGGAR: readonly string[] = ["Spare a coin?", "Anything helps, friend.", "Bless you for stopping."];
const IDLE: readonly string[] = ["Nice weather for a stroll.", "Nothing much happening today.", "Town's quiet.", "News travels slow here."];
const RAID: readonly string[] = ["Raiders! Get inside!", "Run! They're at the walls!", "Something terrible is coming!", "Bar the doors!"];

/** The four parts of the day a greeting follows. */
export function partOfDay(timeOfDay: number): "morning" | "day" | "evening" | "night" {
  const h = ((timeOfDay % 1) + 1) % 1 * 24;
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 17) return "day";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

/** What `npc` says now. */
export function barkFor(npc: Npc, ctx: BarkContext): string {
  const seed = hashOf(`${npc.id}|${ctx.day}`);
  if (ctx.raid) return pick(RAID, seed);
  const greeting = pick(GREET[partOfDay(ctx.timeOfDay)], seed >>> 3);
  let line: string;
  if (npc.cohort === "child") line = pick(CHILD, seed >>> 7);
  else if (npc.role === "beggar") line = pick(BEGGAR, seed >>> 7);
  else if (npc.workplace && ctx.workplace) line = pick(WORK[ctx.workplace] ?? WORKER_GENERIC, seed >>> 7);
  else if (CLASS[npc.class] && seed % 3 === 0) line = pick(CLASS[npc.class]!, seed >>> 7);
  else line = pick(IDLE, seed >>> 7);
  // Children and beggars skip the formal greeting about half the time.
  return npc.cohort === "child" || npc.role === "beggar" ? (seed % 2 ? line : `${greeting} ${line}`) : `${greeting} ${line}`;
}
