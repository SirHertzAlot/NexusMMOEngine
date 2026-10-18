# Game rules

Our game's rules, as data. The engine reads every file here at boot
(`MMO_RULES` points elsewhere), fills whatever a file leaves out from the
engine's neutral defaults, checks everything, and **refuses to start** on
a bad file, naming each problem by file and field:

```
[server] invalid rules:
  skills.json: decay: Unrecognized key: "ratePerWeak"
  body.json: parts[1].parent: no part "neck"
```

| File | What it sets |
|---|---|
| `skills.json` | Skills and their families, related skills, how fast skills rise (challenge, slower at the top, anti-farming), item familiarity, and deterioration |
| `disciplines.json` | Named paths a character earns by skill levels, and the techniques they unlock |
| `combat.json` | Techniques (which item property they read, the damage they do, their skill), and the damage, power and precision formulas' coefficients, and the guard's contest (`defence`, with the margin a parry needs to disarm) |
| `body.json` | The body's parts (a tree: losing one loses everything below it), their share of health, hit multipliers, what happens at 0, which part holds each hand, when blows harm, maim or dismember, bleeding and clotting, healing, what injuries cost (`penalties`), fall damage, and Medicine (`treatment`: how long bandaging, closing a stump and setting a maimed part take and how often they work) |
| `death.json` | Respawn delay and place, what carries over, whether deaths are recorded |
| `appearance.json` | Which appearance slot draws which body part (hidden when that part is lost) |
| `items.json` | Each item base's physics (mass, reach, edge, point, hardness, balance, durability), the hand it is held in, the technique a plain attack uses, and the models it can show as; how much a composed item's power adds; fists |
| `needs.json` | Hunger and thirst: each meter's size, how fast it drains per minute, the health lost per second once it is empty, and how much faster both drain while running or swimming |
| `spells.json` | Spells (the mana they cost, cast time, cooldown, who they can target and how far, what they do), and the mana pool and regeneration used when `stats.json` binds no `maxMana` / `manaRegen` stat |
| `gathering.json` | Gathering from tree stands, ore veins and fishing spots: how far from a node's edge a player reaches, one gather per how many seconds, the most of one material a pouch holds, and how hard a gather trains its skill per material tier (each node's material, stock and regrow time are its scene's `ResourceNode` component) |
| `movement.json` | How characters move: walk, swim and fly speeds (creature and bot speeds are shares of the walk), jump speed and gravity, breath and drowning, the flight ceiling, and the stamina that dodging, attacking, jumping, swimming and running cost, with the regen delay and fallback regen. Hot-reloads into a running server |
| `social.json` | Parties, guilds, chat and character slots: party size, invite and offline timeouts; guild size, invite timeout, message-of-the-day length and officer log length; say range, chat line length (up to 500), block list size and per-channel chat cooldowns; characters per account. Hot-reloads into a running server |
| `loot.json` | Items on the ground and in bags: how long a drop belongs to whoever earned it, when it disappears, pickup range, bag size, the most items on the ground at once |

The schemas, with every field's meaning and default, are in
`packages/rules/src/schemas.ts`; the reasoning is in
`docs/MASTERY-AND-COMBAT.md`. What data can't say, a game writes as a
hook (`computeDamage`, `resolveLanding`, `skillGain`, `onInjury`,
`onDeath`, `onRespawn`): see `createHooks` in `packages/rules`.

A missing file is the engine default; an empty folder is a neutral game
(one-part body, no skills, no decay).
