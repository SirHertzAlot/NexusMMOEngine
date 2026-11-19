# Juicy damage numbers: a combat-feedback pipeline

Filed 2026-11-12 from @mii_misan's reel "Juicy Damage Numbers" (posted
2026-08-15, instagram.com/reel/DcDs7f9uaqo/). Seed of
[`MIISAN-GENERICS.md`](MIISAN-GENERICS.md); it is GENERIC 2's sibling there.
The tutorial's ten steps are already a pipeline: name the stages, make the
parameters data, and any combat event flows through it.

## The ten steps as stages

| # | Tutorial step | Stage |
| --- | --- | --- |
| 1 | Bold readable font | **Typeface**: one outlined display font, legible at speed |
| 2 | Pop it in | **Birth**: scale curve overshoots, settles |
| 3 | Float it up | **Drift**: constant upward velocity |
| 4 | Fade it out | **Death**: opacity curve out, never a blink-cut |
| 5 | Give it gravity | **Arc**: gravity bends the drift into a parabola |
| 6 | Size = damage | **Magnitude map**: value to font scale (log-ish, capped) |
| 7 | Colour = type | **Type map**: damage/heal/poison/block/miss to colour and treatment |
| 8 | The crit | **Emphasis**: crit overrides scale, tilt, shake, camera weight |
| 9 | Stack fast hits | **Accumulation**: rapid hits on one target merge |
| 10 | Never overlap | **Arbitration**: per-target lanes spread spawns left/right |

## The process (client side, presentation only)

The server already decides damage; the client renders combat events.

```
combat event (target, value, type, crit)
  -> CLASSIFY   type map + magnitude map + emphasis class   [data]
  -> ARBITRATE  target's lane allocator: free lane, or merge into
                the open accumulator                         [layout]
  -> SPAWN      pooled floater, styled from the recipe       [pool]
  -> ANIMATE    birth punch -> drift + arc -> fade           [data]
  -> RETIRE     back to the pool at the end of the fade      [pool]
```

## The recipe (data, art-package schema style)

- `font`: display face, outline width and colour
- `lifetimeMs`, `birthScale {from, overshoot, settleMs}`
- `drift {riseSpeed, gravity, spreadDeg}`, `fade {startAt, curve}`
- `magnitude {curve: log, minScale, maxScale, referenceValue}`
- `types`: per type colour, prefix/suffix glyphs, miss/block treatment
- `crit {scaleMul, tiltDeg, shakeAmp, shakeMs}`
- `accumulate {windowMs, mode: sum | stack}`
- `lanes {count, spacing, alternate}`
- `budgets {maxPerTarget, maxGlobal, mergeBeyond}`: the scale guard

## Arbitration at MMO scale

Dozens of attackers can hit one target, so arbitration is the system:

- Each target owns a few lanes (e.g. 3) above its nameplate; a spawn takes the
  freest lane, alternating left/right of centre.
- Hits inside the accumulation window merge into the open floater and
  re-punch it (sum for DoTs and multi-hit, stack offsets vertically).
- Past `maxPerTarget`, new events fold into the accumulator silently. Past
  `maxGlobal` or a camera-distance cutoff, numbers aggregate to a
  per-second total per target. The player's own damage is a priority class
  and always gets full treatment.

## Performance

Pooled floaters (HUD canvas/WebGL text layer or billboarded sprites; the
pipeline is the same either way), a fixed global budget, zero allocation per
event after warm-up, curves evaluated per floater per frame. Cost is
O(visible floaters), capped by budget.

## Verdict

Adopt as the spec for the client's combat-feedback system (the presentation
half of the existing server-side combat module). The recurring pattern:
tutorial list, named stages, parameters as data, pooled runtime with an
arbitrator.
