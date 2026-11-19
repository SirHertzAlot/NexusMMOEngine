# Agent skills — hot-load index

**Workspace-open behaviour (Joey's standing instruction, 2026-11-13):**
when an agent opens this workspace, load this index, then load the
`SKILL.md` of any skill whose trigger matches the work at hand. Each
skill is a self-contained prompt file at `<name>/SKILL.md` with its
own supporting folders. Upstream-vendored skills are recorded in
[UPSTREAM-PROVENANCE.md](./UPSTREAM-PROVENANCE.md).

## House skills

| Skill | Use when |
|---|---|
| `browser-use` | Driving a browser for research, checks, or downloads |
| `computer-control` | Operating the desktop/OS directly |
| `paperclip` | Paperclip control plane: issues, documents, routines, artifacts |
| `blender-vfx` | Stylized VFX built in Blender by an agent over MCP (vendored Blender MCP + Ubuntu LTS install inside) |

## Open 3D Skills (vendored, MIT — moh4696/open-3d-skills)

| Skill | Use when |
|---|---|
| `threejs-scene` | Building a real-time three.js scene/site from code alone |
| `scroll-film` | Scroll-triggered cinematic three.js sequences |
| `alpha-cutout` | Transparent-video / alpha assets that work in Safari |
| `cursor-rig` | Characters/objects that follow the cursor |
| `exploded-view` | Interactive exploded views of machines/assemblies |
| `motion-assets` | Producing motion/video assets from 3D scenes |
| `frame-capture` | Capturing clean 60 fps frames/video of a scene |
| `site-check` | Verifying a built 3D site in the browser before claiming done |

## 3Dviz Pro Max (vendored, MIT — viettranx/3dviz-pro-max)

| Skill | Use when |
|---|---|
| `3dviz-pro-max` | Turning a sentence into an explorable three.js scene: 10-step workflow, 223 recipes, 440 knowledge records, 22 kits, screenshot-verified delivery ("frames, not assurances") |
