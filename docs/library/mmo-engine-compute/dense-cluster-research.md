# Dense Compute Cluster: Minisforum BD-Boards in One Liquid-Cooled Rack Chassis

*Exploratory research — not a build order. Researched 2026-10-16/17 via four parallel streams. Prices are Oct 2026 snapshots; DRAM/NAND prices are moving weekly. "Verified" = confirmed from a primary source (spec page, manual, review). "Estimate" = market inference, marked as such.*

**One-line summary:** 8× Minisforum BD boards in a custom 4U liquid-cooled chassis with a 25GbE spine is technically sound and genuinely buildable — but at October 2026 component prices it's a ~$17k passion project that buys 128 Zen 4 cores you could get for ~$3k in a used dual-Epyc 2U. The concept's economics assumed 2024 DRAM prices. It still wins on perf/watt, single-thread speed, one-neat-chassis density, and the build itself being the point.

---

## 1. Board options

No "BD890i" exists — the Dragon Range refresh is the **BD895i SE**. No Strix Point (Ryzen AI 300) Mini-ITX MoDT board exists either. The Strix Halo board (**BD395i MAX**) was shown at CES 2026, expected mid-2026.

| Board | CPU | TDP | LAN | PCIe x16 | Bifurcation | M.2 | RAM max | Price (board only) |
|---|---|---|---|---|---|---|---|---|
| BD795i SE | Ryzen 9 7945HX (16C/32T) | 100W | 1× 2.5GbE | 5.0 x16 | Not documented | 2× PCIe 4.0 | 96GB DDR5 SODIMM | ~$399 |
| BD895i SE | Ryzen 9 8945HX (16C/32T) | ~100W | 1× 2.5GbE | 5.0 x16 | Not documented | 2× PCIe 4.0 | 96GB DDR5 SODIMM | $423.90 (US store) |
| BD790i | Ryzen 9 7945HX (16C/32T) | ~100W | 1× 2.5GbE | 5.0 x16 | Not documented | 2× PCIe 5.0 | 96GB DDR5 SODIMM | ~$519 |
| BD790i X3D | Ryzen 9 7945HX3D (128MB L3) | 100W | 1× 2.5GbE | 5.0 x16 | Not documented | 2× PCIe 5.0 | 96GB DDR5 SODIMM | ~$599 |
| BD790i SE | Ryzen 9 7940HX (16C/32T) | ~100W | 1× 2.5GbE | 5.0 x16 | Not documented | 2× PCIe 4.0 | 96GB DDR5 SODIMM | ~$359 (launch) |
| BD770i | Ryzen 7 7745HX (8C/16T) | 45W (75W BIOS mode) | 1× 2.5GbE | 5.0 x16 | Not documented | 2× PCIe 5.0 | 64GB DDR5 SODIMM | ~$399 |
| BD395i MAX *(mid-2026)* | Ryzen AI Max+ 395 (16C/32T Zen 5) | 45–120W configurable | **1× 10GbE + 1× 2.5GbE** | x16 physical, likely x4 electrical | Unknown | 2× M.2 | **128GB soldered LPDDR5X (not upgradable)** | ≥$1,500 (est.) |

Sources: Minisforum store/listings, Notebookcheck BD795i SE review (100W PL1/PL2, RTL8125), VideoCardz (BD895i SE launch), Liliputing + Notebookcheck (BD395i MAX), Tom's Hardware (BD790i X3D), manuals.plus (BD790i X3D manual).

**Picks for this project:** **BD795i SE** (~$399, best $/core) or **BD895i SE** ($423.90, newest — safest fleet buy for longevity). Skip the X3D (128MB L3 wasted on cluster work, 50% more). The BD395i MAX is worth revisiting mid-2026 — onboard 10GbE changes the networking story — but soldered RAM and ≥$1,500 are serious trade-offs.

**Hard constraints on every BD board:** no ECC (treat as unsupported), **no BMC/IPMI** (no remote KVM/power — plan WoL + a managed PDU), 96GB SODIMM ceiling, standard 24-pin ATX + 8-pin EPS power per board.

**Bifurcation — honest status:** conflicting evidence. Some forum users (ServeTheHome, Level1Techs) report bifurcation modes working on BD790i/BD770i; Minisforum documents it nowhere and its BIOS is famously locked down (no PBO/EXPO per its own FAQ). **Do not design around bifurcation.** It doesn't matter much anyway — a single dual-port NIC is one PCIe endpoint and needs no bifurcation.

---

## 2. The networking problem (and the fix)

**The problem:** every Dragon Range BD board has exactly one 2.5GbE port. 8 nodes × 2.5GbE = a 20GbE-aggregate chassis that chokes on any serious distributed work (storage, NVMe-oF, distributed training, fast dataset staging). There is no "high-throughput spine" without add-in NICs.

**The fix — per node:** one used **Mellanox ConnectX-4 Lx MCX4121A-ACAT** (dual-port 25GbE SFP28, PCIe 3.0 x8) in the x16 slot. Used: **$30–70/node** (eBay). Power ~10–12W. Linux `mlx5` inbox drivers — no OFED/firmware headaches. PCIe is backward compatible; x8 card in a 5.0 x16 slot is a non-issue. (ConnectX-5 25G is the same price class new/refurb ~$167; 100G-capable CX-5 MCX516A is $300–400/node — not worth it per node; see §5.)

**The x16 trade-off, stated plainly:** the NIC eats the only x16 slot, so **no GPU per node**. Fine for headless compute (the 7945HX's iGPU covers console); if a node needs CUDA, that node keeps 2.5GbE management only. Budget one such node if needed.

**M.2 NICs are a dead end here:** BD790i M.2 slots are reportedly **x2 lanes electrically** (ServeTheHome forum user report) — a ConnectX-4 Lx there tops out ~16Gbps, below 25G line rate. Plus a ribbon-cabled NIC dangling in a dense chassis is a reliability liability. **Put the spine NIC in the x16 slot.**

**Onboard 2.5GbE role:** keep it as the management network (Proxmox cluster comms, WoL, SSH) — physically separate from the data spine. That's actually good design.

---

## 3. Liquid cooling

**Critical finding: the 7945HX on these boards is BARE DIE (no IHS)** — soldered BGA with exposed dies (per hands-on reports on smallformfactor.net). Waterblock mounting is direct-die: standoff height must be exact or you crack the die. Budget extreme care (or one sacrificial test board) on the first mount.

**Blocks that fit the 52×52mm hole pattern and are sold today:**
- **Koolance GPU-230** (~$60–70) — 45×45mm cold plate, adjustable bracket covers the 73.5mm diagonal, low restriction (0.8 psi @ 5 LPM). Top pick. https://koolance.com/video-card-vga-chipset-water-block-gpu-230
- **Koolance GPU-220** (~$50–60) — same plate, slightly more restrictive. Budget alternative.
- **Liquid Extasy BD790i block** (~€90–150 est.) — German maker already lists a block *designed for the BD790i*; only purpose-built option. Confirm VRM coverage and bare-die kit before relying on it. liquidextasy.de
- Dead ends: EK VGA Supremacy (EOL, secondhand only), Alphacool NexXxoS GPX (discontinued).

**Loop topology: SERIAL, not parallel.** 8 blocks serial ≈ 4–7 psi + rads + 16 QD fittings ≈ 8–12 psi total — manageable. Parallel divides flow (1 GPM ÷ 8 branches = 0.125 GPM/block, below the ~0.5 GPM turbulence threshold) and starves mismatched branches. Target **≥1.0 GPM total loop flow**.

**Radiators:** rule of thumb **120mm per 100W**. Per node ~115–125W (CPU + VRM + SSD + pump share) → 8 nodes ≈ 1,000W → **1,200mm of rad** (e.g., 3× 480mm slim, or 4× 360mm). Slim 30mm rads in push — thick rads only pay off with push-pull and noise. Expect ~10°C water-to-air delta.

**Pumps:** **2× D5 PWM in series** on a dual top (~11 psi combined head, partial redundancy if one dies). Run fixed 60–80% PWM. ~$85 each + $150–250 dual top/res.

**Serviceability:** **Koolance QD3 quick-disconnect pairs on every node's in/out lines** (~$32–37/pair → ~$280 for 8 nodes) so a tray pulls without draining. Serial chain + per-node QDs beats a distribution manifold (which reintroduces parallel flow-balancing pain).

**⚠️ The real design risk — VRM cooling.** The stock cooler cools CPU *and* VRM (6+2 phase) together. Remove it and the MOSFETs are naked in a low-airflow rack box; ~100W sustained will cook them. No monoblock exists for this board. Mitigation, ranked: (1) stick-on MOSFET heatsinks + a dedicated fan bar with **fan-failure alarming** (~$15/board) — proven, but makes chassis airflow load-bearing; (2) commission VRM blocks from Liquid Extasy (they machine for this board already); (3) keep the stock M.2 active cooler (separate assembly — keep it, PCIe 5.0 SSDs run hot). **Design rule: guarantee airflow across every VRM zone; put a thermistor on at least one VRM heatsink per zone during prototyping.**

**Coolant/practice:** clear premix (EK CryoFuel Clear / Mayhems X1) — never dyed/opaque (clogs microfins). All copper/brass/nickel, no aluminum. 24h pump-only leak test (PSU jumpered, nothing else powered). Coolant temp sensor driving fan curves (target ≤10–12°C above ambient), plus a flow indicator.

**Cooling BOM (8 nodes, estimates ±30%):** 8× blocks $520 + 2× D5 $170 + dual top/res $180 + 3× 480mm rads $300 + 12× fans $144 + 8× QD3 pairs $280 + ~40 fittings $280 + tubing $40 + coolant $60 + sensors/valves $50 + VRM heatsinks/fans $120 + misc $80 ≈ **$2,220**.

---

## 4. Chassis concept

**Recommended: flat trays — 2 boards per 2U tray, 4 trays = 8 nodes in 4U.** Boards lie flat; two side-by-side (340mm) + NICs on flat PCIe risers + cabling ≈ 420mm — fits the ~440mm rack interior. Stack height per tray (~45mm: board + low-profile block) fits 2U (88.9mm) easily. Trays slide out on drawer rails for service. (Blade/vertical mounting packs tighter but needs custom card-edge power and makes VRM cooling worse — not for build #1. Prototype with 4 nodes in 2U first.)

**Radiator placement:** a 4U front face fits one 360mm rad — not the three-to-four needed. Plan front (1× 360) + top (1× 360–480) + rear/bottom (1× 360), or split into **two independent 4-node loops** (nicer operationally: half the cluster stays up during loop service).

**Power — honest math (all-core worst case):** 8× (100–120W CPU + ~30W board/RAM) + 8× 15W NICs + 8× 7W NVMe + ~60W pump/fans ≈ **1,280–1,440W DC** → ~1,380–1,550W AC. Size **2,000W of 12V** for headroom. Stagger power-on (inrush!) via PDU sequencing or BIOS "restore on AC."

**Power architecture — ranked:**
1. **8× individual 400W FlexATX Gold (~$65 each = $520) — the pragmatic choice.** Each board gets proper 24-pin + 8-pin with correct ATX sequencing/PWR_OK per node. Dead PSU kills one node, not eight. Downsides: 8 small fans, 8 AC inlets (you're buying a rack PDU anyway).
2. **2× 1200W CRPS + breakout + per-node DC-ATX/picoPSU (~$400–500)** — elegant, one/two big efficient fans, cleaner cabling. Downsides: mining-grade breakout quality variance; picoPSU clones are the reliability weak link at 150W+ sustained. Worth it if you enjoy power-electronics craft.
3. **One big ATX PSU with splitters — DON'T.** Single PS_ON/PWR_OK = all 8 boards power as one unit (no per-node control/WoL/stagger); 8 boards' current through splitters melts connectors. Fire-hazard-adjacent.

Front-panel power/reset per node wired to each board's system-panel header; managed PDU is mandatory (no BMC).

---

## 5. Spine/mesh architecture

**Per-chassis switch: MikroTik CRS504-4XQ-IN (~$750 new).** 4× 100G QSFP28, ~25W typical, **near-silent** (ServeTheHome: "often run nearly silently") — homelab-sane, unlike datacenter Spectrum boxes. 2× 100G→4×25G breakout DACs (~$130–160 each) = 16× 25G lanes: 8 for nodes, rest for uplink/spare.

**Why not used Mellanox SN2100/SN2700?** SN2100 (16×100G) ~$500–700 used, SN2700 (32×100G) ~$800–1,200 used — but 94–150W and **~60–70 dBA** of 40mm-fan datacenter scream. Fine for a garage; miserable anywhere else. Skip unless a 4th chassis forces a central spine.

**25G vs 100G per node:** 25G/node costs ~$47/port (switch share) + ~$20 DAC + ~$40 NIC; 100G/node ~$188/port + ~$40 DAC + ~$350 NIC — **4–5× more** for headroom 8 nodes don't need yet (25G = 3.1 GB/s/node). **Go 25G per node.**

**Inter-chassis (2–3 chassis):** direct 100G QSFP28 DACs between chassis switches (~$30–60 each) — chain or triangle, no extra hardware. Graduate to spine-leaf (used SN2700 or new CRS518-16XS-2XQ at $1,595) at 4+ chassis or for dual-homed redundancy.

**Networking BOM per 8-node chassis: ~$1,100–1,250** (8× NICs ~$320 + switch $750 + 2× breakout DACs ~$300 + 8× SFP28 DACs ~$160).

---

## 6. Cluster software (homelab HPC/AI-bake, not enterprise)

| Option | In short | Wins when |
|---|---|---|
| **Proxmox VE cluster** (recommended) | Debian-based hypervisor, web UI, one-click clustering, HA, LXC+KVM, huge homelab community | First build — 8 nodes clustered in an afternoon; mixed VMs/containers |
| Plain Debian + Ansible | Nothing between you and the metal | Workloads are embarrassingly parallel batch scripts; fastest to "running" |
| Slurm | The real HPC batch scheduler (job arrays, fair-share, MPI) | Genuine multi-node batch queues become the bottleneck |
| Talos Linux + K8s | Immutable, API-driven, cattle-not-pets | You want K8s skills and containerized pipelines; "resume skill" path |

**Recommendation:** Proxmox VE cluster first (Ansible fallback for pure batch). Graduate to Slurm only if queue semantics become the bottleneck.

---

## 7. Cost/benefit gut-check

**8-node BOM (64GB/node, 2TB NVMe, 25GbE) — Oct 2026:**

| Item | Cost |
|---|---|
| 8× BD795i SE ($399) | $3,192 |
| 8× 64GB DDR5 SODIMM kits (~$900 — **2026 price spike**) | ~$7,200 |
| 8× 2TB Gen4 NVMe (~$320) | $2,560 |
| 8× used CX-4 Lx 25GbE | $320 |
| 8× waterblocks + fittings/QDs | $1,120 |
| 8× FlexATX 400W | $520 |
| 8× PCIe risers | $120 |
| Switch (CRS504) + DACs/breakouts | $1,210 |
| 3× 480mm rads + 2× D5 + res + fans + coolant + misc | $874 |
| Custom 4U chassis (extruded alu + panels) | ~$400 |
| Managed PDU | ~$150 |
| **Total** | **~$17,700** |

128C/256T Zen 4, 512GB RAM, 16TB NVMe, 25GbE fabric. (96GB/node → ~$23k. 1TB SSDs save ~$1,100.)

**Alternative A — used enterprise:** a used 2U dual-Epyc 7742 (128C/256T — *same core count*) with a few hundred GB DDR4 ECC typically lands **~$2,500–4,000** on eBay. Per-core: **~$27 vs ~$136** for the BD cluster. You get BMC/IPMI, ECC, 8-channel memory, zero fabrication — but a 7-year-old platform, ~600–800W, screaming fans, weaker single-thread.

**Alternative B — 8× off-the-shelf Minisforum mini-PCs:** ~$1,600–1,900/node all-in at today's RAM/SSD prices → **~$13–15k**, zero fabrication — but stuck at 2.5GbE (no fabric), 8 power bricks, 8 little fans.

**Where the BD cluster wins:** perf/watt (16 Zen 4 cores at ~110W vs 180–225W Rome parts), single-thread speed (real gap for interactive/render work), one neat 4U chassis, a real 25GbE fabric, modern DDR5/PCIe5 platform, and the build being the point (considerable, and real).
**Where it loses:** cost/core and cost/GB are *brutally* worse than used Epyc right now (the 2026 DRAM spike hits 8 SODIMM pairs hardest); no BMC is a genuine management handicap; no ECC; 96GB/node ceiling; multi-weekend fabrication project.

**Blunt verdict:** at October 2026 prices this is a **~$17k passion project**. The concept's economics were built for 2024 DRAM prices; the ~6× SODIMM spike moved the goalposts. It makes sense **only if** Joey values perf/watt + single-thread + one-neat-chassis + 25GbE fabric + the build itself. If the goal is maximum cores-per-dollar for batch bakes: buy the used Epyc box and keep the other $14k. If he proceeds: **prototype 4 nodes in 2U first**, power with 8× FlexATX (boring, correct), run Proxmox VE, buy RAM last (prices move weekly), and re-check the board market mid-2026 — the Strix Halo BD395i MAX (10GbE onboard) could rewrite the networking section.

---

## Open verification items (before any spend)

1. Liquid Extasy BD790i block: availability, price, VRM coverage, bare-die mounting kit.
2. Single-board thermal test: Koolance GPU-230 on the bare die at 100W sustained.
3. Measured total loop restriction → confirm dual D5 holds ≥1 GPM with 8 blocks + 16 QDs.
4. BD795i SE vs BD895i SE street availability for a fleet buy (check Minisforum store).
5. VRM thermistor validation during prototype: prove the fan-bar keeps MOSFETs sane.

*No purchases made, no accounts created during this research.*
