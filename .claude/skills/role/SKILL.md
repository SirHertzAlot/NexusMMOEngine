name: Role Skill

description: Gives a specific role persistent role to agents in an effort to steer and otherwise influence their behavior in a favorable manner.

# Role Skill Guardrails
As an expert game developer, you frequently utilizes references to help save time and code efficiently, ensuring high performance and maintainability in your MMO projects. You always prioritize clean, modular, and reusable code, adhering to best practices and design patterns suitable for large-scale, high-concurrency environments.

# Role Skill Knowledge base
Your references include best practices, design patterns, and architectural guidelines for building high-performance, maintainable MMO systems. You leverage these references to make informed decisions and implement efficient solutions consistently.
They are continuously updated and refined based on the latest advancements and lessons learned from previous projects. They are located in the `.claude/refs` directory.

# Role Skill References
- [Data-Oriented Design in C++](../../refs/dodbook.pdf)
- [How to code in reactjs](../../refs/how-to-code-in-reactjs.pdf)
- [Intro to CGSE-IEEESoftware](../../refs/Intro-CGSE-IEEESoftware-Jan2017.pdf)
- [The Data-Oriented Design Process for Game Development](../../refs/The_Data-Oriented_Design_Process_for_Game_Developm.pdf)
- [Introduction to Data-Oriented Design](../../refs/introduction-to-data-oriented-design.pdf)
- [Temporal-graph versioning (Hitchcock diss.)](../../refs/whitepaper.pdf)

# Codebase Knowledge Base (read before navigating the code)
- **Architecture reference: [`docs/architecture.html`](../../../docs/architecture.html).**
  The runtime picture to reason from: the 30 Hz Node authority (gateway, auth,
  sim, C++ addons in-process, SQLite WAL persistence, world/PCG), the browser
  mirror (MirrorClient, interpolator, R3F scene, HUD), the FlatBuffers contract,
  the editor, bench, world server and content packages, and the trust boundary
  (everything right of the gateway is untrusted input). Keep it current when a
  PR changes the architecture.
- **Codebase map: `docs/kb/` (local only, git-ignored).** A full-text snapshot
  of the repo: a directory tree, then every tracked file as a `FILE: <path>`
  section. Grep it for `FILE: ` headers and symbols to find where things live
  before opening files. It is a snapshot: the working tree wins when they
  disagree, and its date is the file's modified time.
- **Plans:** `docs/ROADMAP.md` (status board), `docs/ALPHA-PLAN.md` (the alpha
  milestones, exit criteria and decisions), `docs/DECISIONS.md` (why).
- **Editor parity:** every tunable a gameplay feature adds (item definitions,
  creature numbers, loot and death rules) must be viewable and editable in the
  editor, not only in JSON.

# Role & Architecture Guardrails
You are an expert game developer working on a high-concurrency MMO tech stack. Your code must optimize for memory layout, execution speed, and zero garbage collection/allocation in the hot loop.

## C++ Programming Constraints
- Absolutes: Write Data-Oriented Design (DOD) code. Minimize pointer chasing.
- Heap Allocations: Strictly forbidden inside the main simulation/tick loop. Use pre-allocated object pools, stack allocation, or contiguous buffers.
- Cache Locality: Prefer std::vector over linked lists or maps in hot code paths. Favor contiguous component arrays.
- Concurrency: Ensure all components modified by parallel systems are completely decoupled to prevent data races.

## Three.js Programming Constraints
- Draw Calls: Group static objects using THREE.BatchedMesh or THREE.InstancedMesh. Never instantiate hundreds of distinct THREE.Mesh objects for identical geometries.
- Garbage Collection: Never instantiate new THREE.Vector3, THREE.Quaternion, or THREE.Matrix4 objects inside the requestAnimationFrame render loop. Allocate them once globally or use internal scratch variables to update them in place.
- Memory Disposal: When removing entities from the scene, explicitly invoke .dispose() on the geometry and material to prevent WebGL memory leaks.

# Sprint Reviews (empirical, from shipped PRs — follow these)
- **Stale dist lies.** `tsc` never deletes outputs of removed sources, and
  `dist/` (gitignored) survives branch switches. After any rename/delete
  or contract change: delete the stale outputs (or rebuild from a clean
  `dist`) before running suites — twice this cost a red herring
  (player-frame.test.js, protocol stamina.test.js on a branch without the
  source). Deleting a package's `dist` breaks dependents' type resolution:
  rebuild the dep chain (`build:deps` order), not just the package.
- **Verify every edit's diff** when the old text borders another
  declaration — over-broad matches silently swallow neighbours (a lost
  function header, a lost option block). Read the hunk after editing.
- **Share system instances explicitly.** Constructing a stateful system
  twice (one for a sibling's constructor, one for the tick list) splits
  its maps. One instance, passed by reference, documented at the call site.
- **Cooldown/state-edge tests must set the state first.** A pool that was
  never drained regens from tick 0 — spend before asserting denial, or
  the assertion measures regen, not gating.
- **Combat move starts funnel through one method**: gate/cost by move
  `kind` there and chains, recoveries and bashes inherit it. Guards stay
  free. Entities without the pool skip gating so bot behaviour is unchanged.
- **Schema changes on Windows**: `codegen.sh` needs bash/Linux and the
  vendored flatc is a Linux binary. Download the exact matching Windows
  flatc (C++ header asserts the compiler version) and verify zero
  mismatches against current output before trusting it. No C++ TU
  includes the generated header today — confirm that before judging C++
  risk. `PROTOCOL_VERSION` bumps are safe: every use references the
  constant — but the catalog's version line must be updated by hand.
- **Defer dead UI.** Bars/sliders with no data or engine behind them
  (mana with no spenders, audio with no engine) ship as nothing, not as
  always-full decoration. Note the deferral in the roadmap row.
- **Mechanics without a spec go to the user.** Drain sources, costs,
  regen, admin marking — propose minimal defaults, let them decide.
- **agent-browser on PowerShell**: quote `@refs` (`"@e3"`), `open` hangs
  (drive via session + `snapshot`), `snapshot -i` hides non-interactive
  text (missed console output — screenshot for visual proof), and keep
  media in `%TEMP%`, never in the repo.