# Third-party notices

Code adapted from the projects below keeps their notices here. Each adapted
file names its source in its header comment.

## ProceduralTerrains

Source: https://github.com/ZyFou/ProceduralTerrains (commit 96c094e, 2026-09-24).
Adapted: the procedural sky shader and the time-of-day keyframes
(`src/render/sky/`), and the water's wave field, Fresnel and GGX sun
specular (`src/render/water-material.ts`).

```
MIT License

Copyright (c) 2026 ZyFou

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, 
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Terrain surface textures (not in this repository)

`npm run surfaces:fetch` downloads CC0-1.0 ground textures (Poly Haven,
ambientCG) as prepared by ProceduralTerrains into `public/surfaces/`, which
is git-ignored. The script writes their credits to
`public/surfaces/ATTRIBUTION.md`. CC0 needs no notice; the credit is a courtesy.
