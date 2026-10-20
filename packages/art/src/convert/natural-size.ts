/**
 * Real-world sizes for imported GLB packs. Their models come in arbitrary
 * units (the same pack holds a rabbit 2 units long and a sheep 766 units
 * long), so the importer rescales each to its natural longest dimension in
 * metres, by name. First match wins; a pack with no match uses its default.
 * Generic words only: no model names.
 */
const NATURAL_M: Array<[RegExp, number]> = [
  // sea
  [/sperm|finback|blue_whale/i, 14], [/whale_tail/i, 3], [/whale|orca/i, 8], [/shark_tooth/i, 0.1], [/shark_fin/i, 0.6], [/shark/i, 3],
  [/dolphin/i, 2.5], [/narwhal/i, 4], [/manatee|walrus/i, 3], [/sea_lion/i, 2], [/seal/i, 1.5], [/penguin/i, 0.7], [/turtle/i, 1],
  [/pelican/i, 1.6], [/gull/i, 0.6], [/eel/i, 1.2], [/jellyfish|trout|piranha|fish/i, 0.4], [/octopus|squid/i, 0.8], [/cuttlefish/i, 0.5],
  [/seahorse/i, 0.15], [/starfish/i, 0.2], [/urchin/i, 0.12], [/crab_(claw|hand)/i, 0.3], [/crab/i, 0.3], [/lobster_tail/i, 0.3], [/lobster/i, 0.4],
  [/nautilus|clam/i, 0.2], [/sponge|anemone/i, 0.4], [/coral/i, 1], [/kelp/i, 3],
  // forest and farm animals
  [/elk|moose/i, 2.4], [/deer/i, 1.8], [/bear_cub/i, 0.8], [/bear/i, 2], [/boar/i, 1.3], [/cougar|bobcat/i, 1.1], [/wolf|coyote/i, 1.2],
  [/fox|badger|raccoon/i, 0.75], [/otter/i, 1.1], [/beaver/i, 0.9], [/porcupine|skunk/i, 0.6], [/hedgehog|chipmunk/i, 0.22],
  [/monkey/i, 0.55], [/squirrel/i, 0.4], [/mouse|rat|shrew/i, 0.12], [/rabbit/i, 0.4], [/weasel|ferret/i, 0.5],
  [/frog|salamander/i, 0.12], [/snake/i, 1], [/owl|hawk|raven|crow/i, 0.55], [/eagle/i, 0.9], [/sparrow|hummingbird|woodpecker|quail/i, 0.18],
  [/pheasant/i, 0.7], [/bat/i, 0.2], [/ant|bee|wasp|hornet|beetle|ladybug|dragonfly|butterfly|snail|caterpillar|centipede|earthworm/i, 0.05],
  [/horse|cow|bull/i, 2.4], [/donkey|llama/i, 1.8], [/pig/i, 1.4], [/bighorn/i, 1.6], [/sheep|goat/i, 1.2], [/turkey/i, 0.9],
  [/chick/i, 0.15], [/hen|rooster|duck|goose/i, 0.55],
  // farm
  [/tree|palm/i, 5], [/field/i, 6], [/scarecrow/i, 2], [/barn|silo|windmill/i, 9], [/tractor/i, 3], [/wagon/i, 3], [/well/i, 1.6], [/fence/i, 2],
  [/wheelbarrow|saddle/i, 1], [/pitchfork|shovel/i, 1.6], [/bucket|watering_can|barrel/i, 0.4], [/horseshoe/i, 0.15],
];
const PACK_DEFAULT_M: Record<string, number> = { "farm-produce": 0.12, "forest-creatures": 0.5, "sea-flora-fauna": 0.5, "farm-animals": 1.2, "farm-tools": 1, "fantasy-props": 1 };

/** Natural longest dimension in metres for a model of this name in this pack, or undefined when unknown. */
export function naturalSizeM(pack: string, name: string): number | undefined {
  // whole words only (`_`-separated): "bee" must not match "beet", nor "ant" a pheasant
  return NATURAL_M.find(([re]) => new RegExp(`(^|_)(${re.source})(_|$)`, "i").test(name))?.[1] ?? PACK_DEFAULT_M[pack];
}
