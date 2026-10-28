# SAB Phases 3–6 — Merge Dossier

Prepared 2026-10-19 from the live PR state on `SirHertzAlot/NexusMMOEngine`.
Scope: phases 3–6 only. Phase 2 (`arlo/sab-phase2`, PR #253) is out of scope except
where it affects merge order — see the order section.

## Read this first: the PRs are closed

All four PRs (#254–#257) are **closed and unmerged**. Each was created on
2026-10-14 around 20:14 UTC and closed within minutes. The branches still exist and
still contain the work, and every branch merges cleanly into its PR base — but none
of the four can be merged as-is. Each one needs to be **reopened** (or re-created
from its branch) before any merge can happen. I could not see who closed them or
why; that history wasn't readable with the access used for this dossier.

Related: Phase 2's PR (#253) is also closed and unmerged, and its commit is not on
`main`. Phases 3 and 4 are built on top of the Phase 2 branch, and Phase 5 is built
on top of Phase 3 — so the practical merge path runs through Phase 2 first.

---

## Phase 3 — Wire encoding from shared-memory views
**PR:** https://github.com/SirHertzAlot/NexusMMOEngine/pull/254 · head `arlo/sab-phase3` → base `arlo/sab-phase2` · closed, unmerged

### What changed
The server's per-tick network encoding used to copy data twice before sending:
first it built one temporary row object per entity, then the message encoder read
those rows back out. Phase 3 makes the encoder read straight from the
shared-memory component stores, cutting out both copies. The bytes on the wire are
**identical** to before — game clients need zero changes. One commit, 8 files
(+1,290/−30), mostly the new encoders plus tests.

### Evidence (from the live PR)
- Protocol tests **38/38**, snapshot tests **6/6**, all passing.
- Byte-equality check **PASS** — encoded output is byte-identical to the old path.
- Benchmarks (2,000 / 10,000 entities): snapshot encoding **11–13% faster**, delta
  encoding **9–16% faster**. The phase's own gate (improvement or neutral, never a
  regression): **PASS**.

### Merge order
**First of the four** (tied with Phase 4 — see below). Phase 5's PR is based on the
Phase 3 branch, so Phase 3 must land before Phase 5. Phases 3 and 4 are independent
of each other (both sit on Phase 2), so either can go first.

### Blockers / conditions
- The PR is closed — reopen (or re-create) it before merging.
- Needs Phase 2's changes in place first (its base branch), or rebase onto `main`.
- Check runs and review threads could not be read with the access used here —
  confirm CI is green and no threads are open before merging.

---

## Phase 4 — Worker sharing + contention test
**PR:** https://github.com/SirHertzAlot/NexusMMOEngine/pull/255 · head `arlo/sab-phase4` → base `arlo/sab-phase2` · closed, unmerged

### What changed
Proves the shared memory can be safely used from background worker threads, using
atomic operations for contested resources — the primitive the scale target needs
(1,000 players + 50,000 NPCs hammering the same shared resources in one region).
Purely additive: 5 new files + 1 test script, zero changes to existing sources
(+1,073/−1). Includes a deliberately racy non-atomic baseline that **loses**
updates, proving the atomics are necessary rather than just faster.

### Evidence (from the live PR)
- Contention tests **12/12** passing (7 new + 5 existing store tests).
- Atomic multi-worker reconciliation: **exact, zero drift, zero violations**;
  access latency p50/p95/p99 **0.18 / 0.36 / 0.72 microseconds**.
- The non-atomic baseline lost **10,085 updates** — the atomics earn their place.
- Phase gate (improvement or neutral, never regression): **PASS**.

### Merge order
**First of the four, tied with Phase 3.** Independent of Phase 3 (both branch from
Phase 2); nothing else in the stack depends on it, so it can land before, after, or
with Phase 3.

### Blockers / conditions
- The PR is closed — reopen (or re-create) it before merging.
- Needs Phase 2's changes in place first (its base branch), or rebase onto `main`.
- Check runs and review threads could not be read with the access used here —
  confirm CI is green and no threads are open before merging.

---

## Phase 5 — Network fast path: sector broadcast + compact codec
**PR:** https://github.com/SirHertzAlot/NexusMMOEngine/pull/256 · head `arlo/sab-phase5` → base `arlo/sab-phase3` · closed, unmerged

### What changed
Two network upgrades in one commit (15 files, +1,358/−12):
1. **Sector broadcast** — instead of sending each player their update
   individually, the server encodes the per-tick update once per map sector and
   broadcasts it once. Same message bytes as before, zero client changes.
2. **Compact fast-path codec ("v1")** — a small fixed-format encoding for the
   highest-frequency position/velocity updates. It's versioned and fails safe;
   everything else keeps the existing format.

### Evidence (from the live PR)
- Phase tests **26/26** passing (fast-path safety 11/11, broadcast transport 8/8,
  gateway sectors 4/4, snapshot fast-path 3/3).
- Fast-path codec: encoding **13.8–21.9× faster**, decoding **8.7–12.2× faster**,
  payloads **3× smaller**.
- Sector broadcast: **6.3–17.4× faster** than per-player sends (1 vs 8 sectors),
  with plain-WebSocket parity confirmed.
- Phase gate (improvement or neutral, never regression): **PASS**.

### Merge order
**Third** — after Phases 3 and 4. Its PR is based on the Phase 3 branch, so Phase
3 must land first. (Phase 4 is independent and can land any time relative to 3
and 5.)

### Blockers / conditions
- The PR is closed — reopen (or re-create) it before merging.
- Needs Phases 2 and 3 in place first (its base chain), or rebase onto `main`.
- Check runs and review threads could not be read with the access used here —
  confirm CI is green and no threads are open before merging.

---

## Phase 6 — Client asset pipeline (background decode, zero-copy use)
**PR:** https://github.com/SirHertzAlot/NexusMMOEngine/pull/257 · head `arlo/sab-phase6` → base `main` · closed, unmerged

### What changed
Moves 3D model decoding off the browser's main thread: background workers decode
compressed models into shared memory, and the main thread builds the geometry
directly from that memory with **zero copying** — no duplicate vertex data, and
decoding never blocks the frame. Includes a main-thread fallback using the same
decode core (byte-identical output either way) and the required browser isolation
headers in the dev config. One commit, 14 files (+1,659/−7), client-side only.

### Evidence (from the live PR)
- Asset-pipeline tests **20/20** passing.
- Full client suite: **313 pass / 0 fail / 1 skip**.
- Main-thread stall during model decode: **6.40ms → 0.42ms (93.4% less)**.
- Phase gate (improvement or neutral, never regression): **PASS**.

### Merge order
**Independent — can land any time**, including first. It targets `main` directly
and touches only the client; it doesn't depend on Phases 2–5 and nothing depends
on it. Listed last here only because the server phases form a chain.

### Blockers / conditions
- The PR is closed — reopen (or re-create) it before merging.
- **Deployment note (from the PR):** browsers only allow this shared-memory
  technique under cross-origin isolation headers (COOP/COEP). The client hosting
  setup needs those headers or the fast path silently won't engage.
- Check runs and review threads could not be read with the access used here —
  confirm CI is green and no threads are open before merging.

---

## Suggested merge order (3–6)

1. **Phase 3** (#254) — Phase 5 depends on it.
2. **Phase 4** (#255) — independent; interchangeable with Phase 3.
3. **Phase 5** (#256) — needs Phase 3.
4. **Phase 6** (#257) — independent of the server stack; can go in any slot.

Practical note: Phases 3–5 sit on the unmerged Phase 2 branch. The cleanest path
is Phase 2 first, then 3 → 4 → 5, with 6 whenever. Each branch was verified to
merge cleanly into its PR base as of this writing (local check; GitHub's own
mergeability display was not readable here).

## What this dossier did not do

This work was read-only: it read the four PRs, their bodies, and the branch
contents, and performed no merge, no approval, no comment, and no write of any
kind. **Merging remains Joey's call, in whatever order he chooses.** Two things
could not be verified with the read access available and should be confirmed
before any merge: the CI check runs on each PR, and the review threads.

## CORRECTION (2026-10-19, verified live via GitHub API)

The dossier's central finding above was **wrong**: all five PRs are **MERGED, not closed/unmerged**. GitHub marks merged PRs as `state: closed`, and the dossier read `closed` without checking the `merged` flag. Joey (SirHertzAlot) merged each PR himself within minutes of its creation on 2026-10-14:

- #253 (Phase 2) → merged into `arlo/sab-phase1`
- #254 (Phase 3) → merged into `arlo/sab-phase2`
- #255 (Phase 4) → merged into `arlo/sab-phase2`
- #256 (Phase 5) → merged into `arlo/sab-phase3`
- #257 (Phase 6) → merged into **`main`** (merge commit `a4746a5c`, in main's history)

No PR needs reopening — a merged PR cannot be reopened.

**Current remote state (2026-10-19):** remote `main` is at `e8a7f162` (Merge PR #324) — roughly 70 PRs ahead of where this dossier was written. It contains Phase 1 and **Phase 6** (done, nothing left). It does **not** contain phases 2–5. Those live on stacked branches: remote `arlo/sab-phase2` (@ `ac979a9c`) holds phases 2+3+4; remote `arlo/sab-phase3` (@ `efd9fcc9`) holds phases 2+3+5.

**Path to main for phases 2–5:** two NEW PRs (the old ones can't be reused): `arlo/sab-phase2` → `main` (brings 2+3+4), then `arlo/sab-phase3` → `main` (brings 5). CI state was unreadable via the API (403 on check endpoints — an App-permission limit, not a red signal); review threads are clean (zero reviews/comments on all five). Mergeability into today's main is unconfirmed — main has drifted substantially and the branches will likely need main merged in first; GitHub computes this when the new PRs are opened.

**Merging remains Joey's call. Nothing was merged, pushed, or created in this verification.**
