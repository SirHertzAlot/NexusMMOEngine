# Four-Tier Rack: Joey's Cluster Design (2026-10-17)

*Design note, not a build order. Captures Joey's own rack sketch from the 2026-10-17 design session plus the engineering constraints worked out alongside it. Prices are Oct 2026 snapshots from that session — re-verify before buying; DRAM/GDDR prices are moving weekly. "Joey's" = his stated decision. "Recommended" = assistant's working recommendation, still his call. Supersedes the concept in `dense-cluster-research.md` (kept as the BD liquid-cooled chassis study) as the current design of record.*

**One-line summary:** four tiers — 895i/SE compute nodes, 395i AI workers, a 4U Tesla V100 GPU box, TrueNAS NAS — on one 25GbE spine. Proxmox owns virtualization (IaaS), Slurm owns batch, LLM inference is a shared API. Nothing exotic; every piece buyable used today except the 395i boards (mid-2026).

**Joey's decisions that anchor this:**
- Build BD nodes now as the PoC; run them until the game outgrows them — stop hunting for the ideal hardware first ([source:9]).
- The goal is one big mesh of compute that handles massive tasks cooperatively, iterated and expanded on price — not a one-shot final build ([source:15], [source:17]).
- The rack must host IaaS with built-in LLM support for custom models that make the MMO engine (and its tech) easier to use ([source:12]).
- Direction is futuristic and compact with good peripherals — the BD concept's spirit, minus the science-project chassis ([source:19]).

---

## Tier 1 — 895i/SE compute nodes (the batch mesh)

**Role:** sim bakes, game servers, the embarrassingly-parallel mesh. The sim-lab design already says "parallel sweeps as hosts × seeds" — core count and RAM matter; nodes barely talk while running.

**Per node:** BD895i SE ($423.90 board-only, Oct 2026) or BD795i SE (~$399), 16C/32T Zen 4. One used Mellanox ConnectX-4 Lx dual-port 25GbE NIC ($30–70) in the x16 slot — this is what turns the 2.5GbE bottleneck into a real spine.

**Hard constraints (unchanged from the chassis study):** 96GB non-ECC ceiling (two SODIMM slots), no ECC, no BMC/IPMI (plan WoL + a managed PDU), no GPU per node (slot is spent on the NIC).

**Why this tier works:** 25GbE is comfortable headroom for batch staging — you do *not* need InfiniBand/RoCE, which is for tightly-coupled MPI work (fluid dynamics, distributed training) where nodes chat thousands of times per second. For your bakes, 10GbE would be plenty; 25GbE is headroom.

**Buy advice from the study:** prototype 4 nodes in 2U first; buy the RAM last (prices moving weekly).

## Tier 2 — 395i AI workers (mid-2026)

**Role:** LLM inference on-package, no discrete GPU per node. Minisforum BD395i MAX (lands mid-2026): 16 Zen 5 cores, 40-CU RDNA 3.5 iGPU, up to **128GB unified LPDDR5X** the iGPU can directly use, 10GbE onboard. Apple-Silicon-style architecture in Mini-ITX: 70B-class models living in unified memory with no dGPU. Board price ≥$1,500 (est.).

**Correction that matters:** the AI value is *on-package* (unified memory + iGPU), **not** the USB4 ports. There is no USB4 switch — USB4 networking is point-to-point only — so node-to-node traffic still rides the 25GbE spine. USB4 = great I/O (40Gbps external NVMe for model storage, fast peripherals), not fabric.

**Soldered RAM:** buy the 128GB config upfront — no upgrading later. Correct tradeoff for a unified-memory inference node.

**Roadmap, as sketched:** BD nodes now → evaluate 395i mid-2026 → EPYC 4004 if ECC + server management is ever needed at real scale. Each phase bought with knowledge from the previous one; nothing becomes e-waste — older nodes drop into the batch mesh as workers.

## Tier 3 — 4U V100 muscle (the heavy box)

**Role:** the deep-learning muscle everything calls into over the spine. GPU: **Tesla V100 32GB PCIe** — $400–500 from overseas sellers, ~$880 refurbished from US sellers with a return window. 32GB HBM2 at 900GB/s, passive datacenter cooling, Volta. Two cards ≈ 64GB VRAM for ~$1,000 — less than a single used RTX 3090 (now ~$1,000 on eBay; the older "$700–800" figure is stale — the DRAM shortage is inflating everything with GDDR on it). 6–8 cards in one box = **192–256GB VRAM**: 70B models at high quants with room to spare, or pipeline-parallel setups touching 405B-class at low quants.

**Caveats, honestly:** Volta is aging — no FP8, and some tools are deprecating it (llama.cpp is fine; check your vLLM version's compute-capability floor before committing). 250W passive cards need genuine front-to-back rack airflow. Prices are climbing on AI demand — sooner beats later on tested units.

**Rock bottom alternative:** Tesla P40 24GB at ~$150–250 — but Pascal's software friction is real; at $400–500 the V100 is worth the step up.

**Chassis:** Supermicro 4029GP-TRT2-class 4U 8-GPU barebones (8× double-width PCIe slots, built in the V100 era for exactly this; show up used regularly — board, PSUs, fans included; you add CPUs/RAM/GPUs). Dual Xeon Scalable or EPYC Rome boards are cheap used and have the PCIe lane count.

**Engineering checklist (non-negotiable):**
- **Power:** 8× 250W = 2,000W in GPUs alone; ~2.6–2.8kW system draw. A 120V/15A circuit gives 1,440W continuous — not even close. This box needs **208/240V circuits** and 2–4 redundant 2000W+ PSUs. Plan the electrical before the hardware.
- **Cooling/noise:** passive cards mean the chassis fans do everything — 8+ counter-rotating 80mm fans at **60–70 dBA** under load. This is a garage/basement machine, not a home-office machine.
- **NVLink:** V100 PCIe cards support 2-way NVLink bridges (300GB/s pairs) — cheap used, worth grabbing for tensor-parallel pairs within the box; pipeline parallelism across all 8 rides PCIe, fine for inference.
- **Host:** don't starve it — dual sockets, **256–512GB DDR4 ECC (cheap used)** so the host can stage models, run the API layer, and feed all 8 cards.

## Tier 4 — NAS (the part that makes it a cluster)

**Role:** the fourth tier, not an accessory. Slurm jobs need every node seeing the same filesystem paths; Proxmox needs shared storage for VM migration; the inference box wants fast model weights. Without shared storage the rack is boxes with cables.

**Shape:** **TrueNAS Scale** on a used 2U 12-bay chassis (Supermicro 826/836 class — cheap used, sips power next to everything else). 8–12 HDDs in **RAIDZ2** for bulk, an **NVMe pair for cache/metadata**, a 25GbE NIC so storage traffic rides the same spine. Serves NFS rack-wide: job data, VM images, backups, the game asset library.

**Two-tier it mentally:** bulk on spinning rust (cheap terabytes, the NAS), hot on NVMe (model weights, active datasets — either in the NAS or local per node, depending on how hot).

---

## The spine and the software (one logical fabric)

**Network:** one 25GbE spine tying all four tiers together. (The chassis study priced a quiet MikroTik switch ~$750 — recheck current pricing.)

**Three layers, each owning its job:**
- **Proxmox** — virtualization / IaaS layer. Tenants get VMs, virtual networking, storage. This is the IaaS primitive from day one.
- **Slurm** — batch. Sees CPU cores *and* the 8 V100s as schedulable resources (GRES) alongside each other. Jobs queue, the scheduler packs them by fair-share, nothing starves. This is the "right amount of resources" mechanism — a queue with policy, not hope.
- **Inference as an API** — the 4U box runs vLLM or llama.cpp behind an OpenAI-compatible endpoint. Nothing else in the rack sees a GPU — BD nodes, 395i workers, engine tooling all make HTTP calls. **The muscle is a URL.** That's what keeps every device fed without hand-managing GPU affinity.

**Distributed inference over the spine:** llama.cpp RPC mode / pipeline-parallel setups can spread a big model across the rack's GPUs and even the 395i iGPUs — no single card needs to be fully loaded. Great for throughput (batch jobs, background agents); weaker for latency-sensitive interactive chat, where tensor parallelism wants faster interconnects than 25GbE. For the engine-assistant use case (mostly batch and copilot-style), a fine tradeoff.

## Starter shape (from the session)

Start smaller than the full vision; scale the tier that bottlenecks first:
- **Compute:** 4× 895i/SE nodes (grow for more bake throughput)
- **AI workers:** 2× 395i boards (mid-2026; grow when the models get bigger)
- **Muscle:** 1× 4U box with 2–6 V100s to start (fill to 8 when 70B-scale work demands it)
- **Storage:** 1× TrueNAS 2U
- **Spine:** 1× 25GbE switch

Nothing in the starter config gets thrown away as it grows.

---

## Alternatives considered (2026-10-17, not Joey's verdicts)

- **AMD EPYC 4004** (assistant's top rank): same Zen 4 on AM5, ECC, up to 192GB DDR5/node. ASRock Rack 1U2N2G-AM5/2T = 2 independent nodes per 1U, dual 10GbE per node, BMC/IPMI — 32 cores/U matching the BD concept's density, minus the science project. Supermicro MicroCloud H13 = 10 nodes/3U. EPYC 4005 refresh exists on the same socket.
- **Used Ampere Altra** (80-core Q80-30 ~$299): best cores-per-watt-per-dollar, but ARM — the sim stack would need ARM builds.
- Joey took no position; the four-tier BD-anchored design above is the current direction.

## Open decisions (all Joey's)

- [ ] Greenlight to buy anything — nothing purchased; dense-cluster research and this doc are both pre-purchase.
- [ ] Electrical: is 208/240V available where the 4U box will live? (Blocks tier 3.)
- [ ] Noise placement: garage/basement for the 4U box — where does the rack physically live?
- [ ] Inference stack: vLLM vs llama.cpp (check vLLM's Volta compute-capability floor if vLLM).
- [ ] 395i: revisit pricing/availability mid-2026; commit to the 128GB soldered config at buy time.
- [ ] PoC part-price spec — offer from the session still open ("want me to spec out that PoC build with real part prices?").
- [ ] Live benches on the actual BD board before any purchase (all board verdicts so far are proxy-based).

*Related: `dense-cluster-research.md` (the original BD liquid-cooled chassis study — buildable ~$17.4k, loses on $/core to used enterprise gear; the RAM analysis there is what pushed the design toward this rack).*
