# Vendored upstream skills — provenance

Skills in this folder that come from upstream open-source projects,
vendored 2026-11-13 on Joey's direction so the workspace's agents can
hot-load them on open. Each skill keeps its upstream layout
(`<skill-name>/SKILL.md` + its agents/assets/scripts folders).

## Open 3D Skills (MIT)

- Source: https://github.com/moh4696/open-3d-skills (MIT, © 2026
  exploraX). Found via @githubsignals reel, 2026-11-01.
- Vendored: the full `skills/` set — alpha-cutout, cursor-rig,
  exploded-view, frame-capture, motion-assets, scroll-film,
  site-check, threejs-scene.
- Not vendored: the upstream repo's plugin manifests, examples, and
  installer (the repo's own `.agents/skills/` convention is the
  loader here).

## Blender MCP (MIT) — inside `blender-vfx/vendor/blender-mcp/`

- Source: https://github.com/ahujasid/blender-mcp (MIT, © 2025
  Siddharth Ahuja), vendored 2026-11-13 with its LICENSE and
  TERMS_AND_CONDITIONS.md. House rule: telemetry consent stays OFF.
- The `blender-vfx` skill around it is ours; its technique section is
  distilled from Good Good 3D's workflow reel (2026-09-19) — a
  technique, not code.

## 3Dviz Pro Max (MIT)

- Source: https://github.com/viettranx/3dviz-pro-max (MIT,
  © 2026 Viettranx). Found via @githubsignals reel, 2026-11-07.
- Vendored: the skill core under `3dviz-pro-max/` (SKILL.md,
  recipes, knowledge records, kit modules).
- Not vendored: the upstream `evidence/` capture archive and site
  assets (≈400 MB of screenshots/recordings — reference media, not
  prompt content). Full upstream remains at the source repo.
