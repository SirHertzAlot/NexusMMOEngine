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
| `combat.json` | Techniques (which item property they read, the damage they do, their skill), and the damage, power and precision formulas' coefficients |
| `body.json` | The body's parts (a tree: losing one loses everything below it), their share of health, hit multipliers, what happens at 0, when blows harm, maim or dismember, and bleeding |
| `death.json` | Respawn delay and place, what carries over, whether deaths are recorded |
| `appearance.json` | Which appearance slot draws which body part (hidden when that part is lost) |

The schemas, with every field's meaning and default, are in
`packages/rules/src/schemas.ts`; the reasoning is in
`docs/MASTERY-AND-COMBAT.md`. What data can't say, a game writes as a
hook (`computeDamage`, `resolveLanding`, `skillGain`, `onInjury`,
`onDeath`, `onRespawn`): see `createHooks` in `packages/rules`.

A missing file is the engine default; an empty folder is a neutral game
(one-part body, no skills, no decay).
