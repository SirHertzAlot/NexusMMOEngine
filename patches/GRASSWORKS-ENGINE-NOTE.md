# Three.js Grassworks — grass system candidate

Filed 2026-11-13 on Joey's send ("Looks like we also found our grass
textures"). Source: reel by Muhammad Bilal Khan (@mbilalkhan__,
2026-11-05) announcing a free Demos section for customers of
**Three.js Grassworks** (techredux.co) — a grass system for three.js
built on **WebGPU**. First demo: "Abandoned House," a forest scene
with full source code and assets (9.9 MB download, customers only);
a public playable demo is linked from the caption.

## What it is, precisely

Not a texture pack — a *grass rendering system*: instanced blade
fields (the forest floor in the demo is entirely Grassworks) with a
customer portal, demos, and source. Joey's instinct is about the
look: dense, ground-covering grass that sells a forest floor at
walking height — the layer our current stack is thinnest on.

## Against our current position

- **Adopted today:** cortiz2894's stylized-components (MIT) —
  anime-styled grass/water behind the locked low-poly cel direction.
  Grassworks does not displace it on a reel.
- **The WebGPU question is the real gate.** Our client is R3F on the
  WebGL renderer. Grassworks presumes three.js WebGPU. Adopting it
  means either a WebGPU renderer migration for the client (a
  program-level decision, not a grass decision) or a dual-path grass
  story. Neither is priced yet.
- **Licence lane:** commercial product, terms not yet read. Until
  they are: own-game use is *probably* the product's purpose, but
  nothing ships in the prototype pack from it, and the demo source
  (customers-only) can't be pulled or audited before purchase.
- **Style gate:** the demo's grass reads realistic-dense; our grass
  must sit inside cel/low-poly. Blade colour/shape parameterization
  decides whether it can bend to the style — an evaluation question,
  answerable from the public demo + docs, not from the reel.

## Verdict

**EVALUATE, in this order:** (1) walk the public forest demo and
read the product page/terms (price, licence, WebGPU requirements,
parameter surface); (2) if the look can bend to cel and the terms
are clean, the priced question becomes the WebGPU strategy — bring
that to Joey as its own decision; (3) the Abandoned House demo
source, if purchased, is a full reference implementation to learn
from regardless of adoption. No purchase made; buying is Joey's
call. Until then, stylized-components remains the grass lane and the
terrain bake's detail layers remain the ground-cover mechanism.
