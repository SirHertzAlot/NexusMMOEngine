# 05. Business Case & Cloud Infrastructure Economics

This document details the financial model, cloud operating expenditures (OpEx), infrastructure unit economics, and player conversion advantages of the **Nexus MMO Engine**.

---

## 1. The Financial Crisis in Traditional Multiplayer Infrastructure

For standard multiplayer games built on commercial engines (Unreal Engine 5 dedicated servers, Unity headless instances), cloud hosting represents the primary existential risk to studio profitability.

### The Monolithic Server Dilemma
- An Unreal Engine 5 dedicated server instance consumes between **$1.5\text{ GB}$ and $3.5\text{ GB}$ of RAM** and saturates a modern CPU core with as few as **50 to 100 concurrent players**.
- To host a mid-sized game with **10,000 Concurrent Users (CCU)**:
  - Studio requires $\approx 100\text{ to } 130$ dedicated cloud instances (e.g., AWS `c6i.xlarge` or GCP `c2-standard-4` at $\approx \$86.40/\text{month}$ per instance).
  - Total Monthly Server OpEx: **$\approx \$11,000\text{ to }\$15,000/\text{month}$** ($\approx \$130,000\text{ to }\$180,000/\text{year}$).
  - Hosting Unit Cost: **$\approx \$1.10\text{ to }\$1.50\text{ per CCU / month}$**.
- When player counts fluctuate, idle server headroom must be provisioned for peak spikes, dramatically inflating baseline costs.

---

## 2. Nexus MMO Engine: Unit Economics & Density Breakdown

The Nexus MMO Engine replaces monolithic server clusters with a decoupled **Edge / Core Split Architecture**:

```mermaid
flowchart TD
    subgraph CloudInfra ["Nexus Cloud Infrastructure (10,000 Concurrent Users)"]
        subgraph EdgeNodes ["Edge Ingress Layer (Low Memory, High I/O)"]
            E1["Edge Node 1 (c6g.large, $28/mo) - 5,000 Sockets"]
            E2["Edge Node 2 (c6g.large, $28/mo) - 5,000 Sockets"]
        end
        
        subgraph CoreNodes ["Core Simulation Layer (Compute Density)"]
            C1["Core Region 1 (c6i.xlarge, $86/mo) - 2,000 Players + 50k Entities"]
            C2["Core Region 2 (c6i.xlarge, $86/mo) - 2,000 Players + 50k Entities"]
            C3["Core Region 3 (c6i.xlarge, $86/mo) - 2,000 Players + 50k Entities"]
            C4["Core Region 4 (c6i.xlarge, $86/mo) - 2,000 Players + 50k Entities"]
            C5["Core Region 5 (c6i.xlarge, $86/mo) - 2,000 Players + 50k Entities"]
        end
        
        subgraph PersistTier ["Persistence & DB Cluster"]
            DB["Embedded SurrealDB / Distributed Store ($120/mo)"]
        end
        
        EdgeNodes <--> CoreNodes
        CoreNodes <--> PersistTier
    end
```

### Monthly Cost Model (10,000 CCU Baseline)

| Infrastructure Component | Instance Specifications | Instance Count | Monthly Cost / Node | Total Monthly Cost |
| :--- | :--- | :---: | :---: | :---: |
| **Edge Ingress Gateways** | 2 vCPU, 4 GB RAM (`c6g.large`) | 2 | $\$28.00$ | $\$56.00$ |
| **Core 30Hz Simulation Nodes** | 4 vCPU, 8 GB RAM (`c6i.xlarge`) | 5 | $\$86.40$ | $\$432.00$ |
| **Persistence & System of Record** | Distributed DB Storage / Backups | 1 | $\$120.00$ | $\$120.00$ |
| **Total Cloud Hosting OpEx** | — | **8 instances** | — | **$\$608.00 / \text{month}$** |

### Comparative Economics Summary

| Metric | **Unreal Engine 5 Dedicated** | **Nexus MMO Engine** | **Multiplier Advantage** |
| :--- | :---: | :---: | :---: |
| **Instances Needed (10k CCU)** | 133 instances | **8 instances** | **16.6x fewer servers** |
| **Total Monthly OpEx** | $\$11,491 / \text{month}$ | **$\$608 / \text{month}$** | **94.7% cost reduction** |
| **Annual Server Expense** | $\$137,892 / \text{year}$ | **$\$7,296 / \text{year}$** | **$\$130,596 savings / yr** |
| **Monthly Cost Per CCU** | $\$1.15\text{ / CCU}$ | **$\$0.06\text{ / CCU}$** | **19.2x cheaper per player** |

---

## 3. Player Acquisition Funnel: Frictionless Web Economics

In addition to back-end server savings, the Nexus MMO Engine dramatically alters the front-end player acquisition economics through its **zero-install, instant URL delivery model**.

```mermaid
flowchart LR
    subgraph TraditionalFunnel ["Traditional Desktop Client Funnel"]
        Ad1["Marketing Impression / Click"] --> Store1["App Store / Steam Page"]
        Store1 --> Down1["Download 50 GB Installer (60% Drop)"]
        Down1 --> Inst1["Install & Driver Setup (25% Drop)"]
        Inst1 --> Play1["First Gameplay Session"]
    end

    subgraph NexusFunnel ["Nexus Web-Native Funnel"]
        Ad2["Marketing Impression / Click"] --> WebLink["Instant Web Link (mmo.domain.com)"]
        WebLink --> Stream["Streaming WebGL Assets (5s)"]
        Stream --> Play2["First Gameplay Session (85% Conversion)"]
    end
```

### Customer Acquisition Cost (CAC) Multiplier
- **Traditional Desktop MMO Funnel:**
  - Standard industry statistics indicate that requiring a player to download a 30GB–60GB desktop client causes an **immediate 60% to 75% drop-off** between registration and first login.
  - Effective CAC typically ranges from **$\$15.00 to $\$35.00$ per acquired player**.
- **Nexus MMO Web-Native Funnel:**
  - A player clicks a link on Discord, Reddit, YouTube, or Twitch and is actively walking, exploring, and interacting inside the world **within 5 to 10 seconds**.
  - Drop-off is minimized to $< 15\%$, reducing effective CAC to **$\$2.00 to $\$5.00$ per acquired player**.
  - Yields a **3x to 7x higher return on marketing ad spend (ROAS)**.

---

## 4. Monetization & Middleware Licensing Strategy

1. **First-Party Persistent Game Titles:**
   - Launching proprietary online worlds with negligible server maintenance overhead ($< \$1,000/\text{month}$ for full regional clusters), guaranteeing instant profitability even with modest player bases.
2. **Engine & Addon Middleware Licensing:**
   - Licensing the `@mmo-engine/synthesis` procedural modeling pipeline and `@mmo-engine/addon-codec` AVX2 data plane to external studios building multiplayer titles.
3. **Turnkey Private World Hosting:**
   - Offering fully managed persistent MMO worlds for corporate simulations, education, virtual events, and indie developers with automated billing based on active player hours.
