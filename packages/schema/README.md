# @mmo-engine/schema

The shared ECS data model — the **single source of truth** for the C++ ↔ JS
contract (DRY: one `.fbs` file generates both languages).

- `mmo_engine.fbs` — the only hand-edited contract file. Changes are
  **additive only**: new tables/fields; never reuse field ids.
- `generated/` — gitignored output of `npm run codegen` (`scripts/codegen.sh`):
  `cpp/` (FlatBuffers C++ headers) and `ts/` (TypeScript bindings).

See the repo README for the contract-change workflow.
