# TS7: lygia GLSL Functions — REJECTED

## Verdict: REJECT (license gate)

**lygia** (patriciogonzalezvivo/lygia) is dual-licensed under:
- **Prosperity License 3.0**: non-commercial free, commercial = 30-day trial only
- **Patron License**: requires GitHub sponsorship or code contribution

This **fails the permissive-license rule**. The engine requires MIT/Apache-2.0/BSD/CC0.

## What we lose

lygia is a well-designed granular shader library (GLSL/HLSL/Metal/WGSL/CUDA). Useful functions include noise, SDFs, sampling, color spaces.

## Alternative path

**Decision (Joey, 2026-10-10): build our own.** Write needed shader functions in-house, referencing:
- Standard mathematical algorithms (not copyrightable: FBM, color spaces, etc.)
- MIT-licensed sources within lygia's lineage (snoise, psrdnoise — but verify each)
- Inigo Quilez's articles (MIT-licensed code examples)

The shader R&D bundle (SHADER-FX-EXTENDED.md) already documents this approach.

Evaluated srivtx/shader-labs as an alternative — README claims MIT but no LICENSE file exists; also a different tool (interface effects, not general GLSL functions). Not adopted.

## Rule reaffirmed

Permissive license check happens BEFORE integration work, not after. TS7 is the second rejection at the license gate (after NixieFX/TS2).
