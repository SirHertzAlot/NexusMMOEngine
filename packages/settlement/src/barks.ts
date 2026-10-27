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

/** Specialized greeting by character barkTone (§12). */
const TONE_GREET: Record<string, readonly string[]> = {
  warm: ["Welcome, friend!", "Always good to see a friendly face.", "Blessings on your day.", "Good to see you."],
  gruff: ["What do you want?", "Make it quick.", "Speak up, then.", "Hmph."],
  laconic: ["Aye.", "Hullo.", "Morning.", "'Evening."],
  earnest: ["Greetings! Hope the day treats you well.", "A good day to you, traveler.", "Peace and good fortune.", "Well met, friend."],
  guarded: ["Who's asking?", "Mind yourself.", "Keep walking.", "Watching you."],
  cheerful: ["Grand day, isn't it!", "Cheer up, friend!", "Sun's shining on us today!", "Hello there!"],
  wry: ["Still alive, are we?", "Another day in paradise.", "Could be worse, I suppose.", "Back again?"],
  mean: ["What do you want?", "Make it quick.", "Speak up, then.", "Hmph."],
  "short-tempered": ["What do you want?", "Make it quick.", "Speak up, then.", "Hmph."],
  "kind-hearted": ["Welcome, friend!", "Always good to see a friendly face.", "Blessings on your day.", "Good to see you."],
  "even-keeled": ["Well met.", "Good day.", "Hello there."],
  grim: ["Move along.", "Quiet day.", "Mind yourself."],
};

/** Lines keyed by descriptor ids or barkPools (§8, §12). */
const DESCRIPTOR_BARKS: Record<string, readonly string[]> = {
  mean: ["Don't get in my way.", "You're wasting my time.", "Get lost."],
  demeanor_mean: ["Don't get in my way.", "You're wasting my time.", "Get lost."],
  "kind-hearted": ["Take care out there.", "Let me know if you need a hand.", "Safe travels, friend."],
  demeanor_kind: ["Take care out there.", "Let me know if you need a hand.", "Safe travels, friend."],
  "short-tempered": ["I haven't got all day.", "Don't test my patience.", "What is it now?"],
  demeanor_short_tempered: ["I haven't got all day.", "Don't test my patience.", "What is it now?"],
  "even-keeled": ["One step at a time.", "Steady as she goes.", "No need to rush."],
  demeanor_even_keeled: ["One step at a time.", "Steady as she goes.", "No need to rush."],
  dutiful: ["Orders are orders.", "The post must be held.", "Duty comes before all else."],
  moral_dutiful: ["Orders are orders.", "The post must be held.", "Duty comes before all else."],
  cynical: ["Trust nobody, and you'll never be surprised.", "Promises are cheap around here."],
  moral_cynical: ["Trust nobody, and you'll never be surprised.", "Promises are cheap around here."],
  "loves-a-fight": ["Itching for a good brawl.", "Quiet days make my sword hand twitch.", "A good skirmish clears the mind."],
  drive_loves_a_fight: ["Itching for a good brawl.", "Quiet days make my sword hand twitch.", "A good skirmish clears the mind."],
  peaceable: ["May violence stay far from our walls.", "A quiet hearth is worth more than glory."],
  drive_peaceable: ["May violence stay far from our walls.", "A quiet hearth is worth more than glory."],
  gossip: ["Have you heard the talk about the old ruins?", "Word travels fast around here."],
  social_gossip: ["Have you heard the talk about the old ruins?", "Word travels fast around here."],
  taciturn: ["...", "Not much for talking.", "Quiet days are best."],
  social_taciturn: ["...", "Not much for talking.", "Quiet days are best."],
  generous: ["Share what you have, that's what I say.", "There's always enough to go around."],
  social_generous: ["Share what you have, that's what I say.", "There's always enough to go around."],
  miserly: ["Nothing in this life comes free.", "Count every coin twice."],
  social_miserly: ["Nothing in this life comes free.", "Count every coin twice."],
  ambitious: ["There's greater things waiting for me.", "One day they'll know my name."],
  drive_ambitious: ["There's greater things waiting for me.", "One day they'll know my name."],
  curious: ["I wonder what lies beyond the horizon.", "There is always something new to uncover."],
  drive_curious: ["I wonder what lies beyond the horizon.", "There is always something new to uncover."],
};

/** Personal lines keyed by character backstory want/flaw fragment ids (§12). */
const PERSONAL_BARKS: Record<string, readonly string[]> = {
  "flaw:distrust": ["Keep your hands where I can see them.", "I don't trust strangers easily."],
  "flaw:wrath": ["Cross me, and you'll regret it.", "My temper runs hot today."],
  "flaw:greed": ["Gold is the only thing that never lies.", "A heavy purse makes a light heart."],
  "want:wealth": ["Looking for opportunities to turn a profit.", "Every coin saved is a step forward."],
  "want:mastery": ["Every day I strive to perfect my craft.", "Practice makes the master."],
  "want:travel": ["One day I'll see what lies across the sea.", "The road is always calling."],
  "want:peace": ["All I want is a quiet life without trouble.", "May peace last in our time."],
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

  // Profile-driven tone greeting, falling back to time-of-day greeting
  let greeting: string;
  const tone = npc.character?.profile?.barkTone;
  if (tone && TONE_GREET[tone]) {
    greeting = pick(TONE_GREET[tone]!, seed >>> 3);
  } else {
    greeting = pick(GREET[partOfDay(ctx.timeOfDay)], seed >>> 3);
  }

  // Check for character-specific lines (descriptors and personal wants/flaws)
  const characterLines: string[] = [];
  if (npc.character) {
    for (const dId of npc.character.descriptorIds) {
      if (DESCRIPTOR_BARKS[dId]) characterLines.push(...DESCRIPTOR_BARKS[dId]!);
    }
    const want = npc.character.backstory?.wantId;
    if (want && PERSONAL_BARKS[want]) characterLines.push(...PERSONAL_BARKS[want]!);
    const flaw = npc.character.backstory?.flawId;
    if (flaw && PERSONAL_BARKS[flaw]) characterLines.push(...PERSONAL_BARKS[flaw]!);
  }

  let line: string;
  // If character lines are available and seed selects character flavor (half the time for non-special roles)
  if (characterLines.length > 0 && npc.cohort !== "child" && npc.role !== "beggar" && seed % 2 === 0) {
    line = pick(characterLines, seed >>> 7);
  } else if (npc.cohort === "child") {
    line = pick(CHILD, seed >>> 7);
  } else if (npc.role === "beggar") {
    line = pick(BEGGAR, seed >>> 7);
  } else if (npc.workplace && ctx.workplace) {
    line = pick(WORK[ctx.workplace] ?? WORKER_GENERIC, seed >>> 7);
  } else if (CLASS[npc.class] && seed % 3 === 0) {
    line = pick(CLASS[npc.class]!, seed >>> 7);
  } else if (characterLines.length > 0) {
    line = pick(characterLines, seed >>> 7);
  } else {
    line = pick(IDLE, seed >>> 7);
  }

  // Children, beggars, and laconic characters skip the formal greeting about half the time.
  const skipGreeting = npc.cohort === "child" || npc.role === "beggar" || tone === "laconic";
  return skipGreeting ? (seed % 2 ? line : `${greeting} ${line}`) : `${greeting} ${line}`;
}
