# 10. Developer Tooling & Interactive Documentation Ecosystem (Yank Note & Data Apps)

This chapter outlines the recommended developer tooling and interactive documentation ecosystem for the **Nexus MMO Engine**, detailing the incorporation of **Yank Note** ([`purocean/yn`](https://github.com/purocean/yn)) as an extensible, programmer-first Markdown knowledge base and interactive data application host.

---

## 1. Motivation & Ecosystem Philosophy

The Nexus MMO Engine is documented using pure, version-controlled Markdown (`docs/WIKI.md`, `docs/wiki/`, `docs/DECISIONS.md`, and `docs/ROADMAP.md`). While standard text editors and static web generators can view these files, complex distributed game engines benefit from an **interactive documentation environment** that integrates:

1. **Local-First File Integrity:** Works directly with the repository's `.md` files without intermediate databases, cloud lock-in, or proprietary formatting.
2. **In-Note Executable REPL:** Allows engineers to run engine build commands, unit tests, and performance benchmarks directly from documentation pages.
3. **Interactive Diagrams & Architectural Models:** Flawlessly renders supported Mermaid architectures (`flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`, `xychart-beta`), Draw.io schemas, and PlantUML models.
4. **Interactive Data Dashboards (Data Apps):** Hosts embedded HTML applets, React + Vite data widgets, and real-time engine telemetry monitors.
5. **Zero-Knowledge Encrypted Notes (`.c.md`):** Client-side encrypted documents for staging deployment credentials, region access tokens, and infrastructure secrets without leaking plain text into repository history.

To fulfill these requirements, **Yank Note** (`purocean/yn`) is incorporated into our recommended developer toolchain.

---

## 2. Core Capabilities of Yank Note (`purocean/yn`)

| Feature | Developer Benefit | In-Engine Application |
| :--- | :--- | :--- |
| **Monaco Editor Kernel** | VS Code editing experience with multi-cursor, syntax highlighting, and code folding. | Seamless editing of engine wiki documents and FlatBuffers schemas. |
| **Runnable Code Blocks** | In-note execution of Node.js, Python, and shell scripts with inline output display. | 1-click execution of test suites (`npm test -w @mmo-engine/protocol`) and benchmarks directly from docs. |
| **HTML Applets & Reveal.js** | Embeds interactive web components, custom HTML/JS widgets, and presentations. | Embedding real-time simulation visualizers and telemetry monitors. |
| **Plugin Architecture** | Thin, powerful JavaScript plugin API via `window.registerPlugin`. | Custom engine inspector plugins, webrpc schema browsers, and build shortcuts. |
| **Document Encryption** | Frontend client-side encryption for `.c.md` files. | Safely keeping private staging configs, production keys, and deployment profiles locally. |
| **Integrated Terminal** | Embedded sidebar terminal bound to project working directory. | Rapid command-line operations without switching application focus. |

---

## 3. Architecture: Interactive Telemetry & Data Apps

Using the `/building-data-apps` paradigm, Yank Note's HTML applet support allows technical designers and live-ops engineers to embed rich data apps directly inside documentation notes:

```mermaid
flowchart LR
    subgraph EngineCore["Authoritative Engine Core (30 Hz)"]
        SIM["Simulation Worker (C++ SAB Plane)"]
        GATEWAY["uWebSockets.js Gateway"]
        TELEM["Telemetry Broadcaster (/telemetry)"]
        SIM --> GATEWAY
        GATEWAY --> TELEM
    end

    subgraph YankNote["Yank Note Environment (purocean/yn)"]
        WIKI["Engine Wiki (docs/wiki/*.md)"]
        APPLET["Interactive Data Applet (React/ECharts or HTML5)"]
        PLUGIN["Custom Engine Plugin (window.registerPlugin)"]
        
        WIKI --> APPLET
        PLUGIN --> APPLET
    end

    TELEM -- "WebSocket (JSON/Fast-Path)" --> APPLET
```

### 3.1 Embedding an Engine Telemetry Applet in a Note
In any documentation note (e.g. `docs/wiki/05-networking-and-edge.md`), an interactive live-ops monitor can be embedded via an HTML applet block:

````markdown
```html
<div id="telemetry-card" style="padding: 16px; background: #161b22; border-radius: 8px; color: #f0f6fc; font-family: sans-serif;">
  <h3 style="margin-top: 0; color: #58a6ff;">Live Engine Telemetry</h3>
  <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px;">
    <div style="background: #21262d; padding: 10px; border-radius: 6px;">
      <small style="color: #8b949e;">Tick Rate</small>
      <div id="metric-tick" style="font-size: 20px; font-weight: bold; color: #3fb950;">30.0 Hz</div>
    </div>
    <div style="background: #21262d; padding: 10px; border-radius: 6px;">
      <small style="color: #8b949e;">Tick Duration (p99)</small>
      <div id="metric-latency" style="font-size: 20px; font-weight: bold; color: #f0883e;">1.8 ms</div>
    </div>
    <div style="background: #21262d; padding: 10px; border-radius: 6px;">
      <small style="color: #8b949e;">Active Entities</small>
      <div id="metric-entities" style="font-size: 20px; font-weight: bold; color: #a371f7;">51,256</div>
    </div>
  </div>
  <button onclick="connectTelemetry()" style="background: #238636; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Connect Telemetry Stream</button>
</div>

<script>
function connectTelemetry() {
  const ws = new WebSocket("ws://127.0.0.1:3000/telemetry");
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    document.getElementById("metric-tick").innerText = (data.hz || 30.0).toFixed(1) + " Hz";
    document.getElementById("metric-latency").innerText = (data.p99 || 1.8).toFixed(1) + " ms";
    document.getElementById("metric-entities").innerText = (data.entities || 0).toLocaleString();
  };
}
</script>
```
````

---

## 4. Custom Yank Note Plugin for Nexus MMO Engine

Developers can install a custom engine integration plugin in Yank Note (`<home>/yank-note/plugins/plugin-nexus-engine.js`) to provide status-bar shortcuts, test triggers, and server health indicators:

```javascript
// plugin-nexus-engine.js - Nexus MMO Engine Integration Plugin for Yank Note
window.registerPlugin({
  name: "nexus-mmo-engine",
  register: (ctx) => {
    // 1. Status Bar Item for Engine Simulation State
    ctx.statusBar.tapMenus((menus) => {
      menus["nexus-status"] = {
        id: "nexus-status",
        position: "right",
        title: "⚡ Nexus: Ready",
        onClick: async () => {
          try {
            const res = await fetch("http://127.0.0.1:3000/health");
            const data = await res.json();
            ctx.ui.useToast().show("info", `Engine Active: ${data.entities} entities, Tick: ${data.tick}`);
          } catch (e) {
            ctx.ui.useToast().show("error", "Engine Gateway Offline (port 3000)");
          }
        },
      };
    });

    // 2. Editor Action: Quick Run Active Test File
    ctx.editor.addCommand({
      id: "nexus-run-test",
      label: "Nexus: Run Active Test File",
      keybindings: [ctx.monaco.KeyMod.CtrlCmd | ctx.monaco.KeyCode.F9],
      run: (editor) => {
        const filePath = ctx.editor.getCurrentFilePath();
        if (filePath && filePath.endsWith(".test.ts")) {
          ctx.terminal.sendText(`npx tsx --test "${filePath}"\n`);
          ctx.ui.useToast().show("info", `Executing ${filePath}...`);
        } else {
          ctx.ui.useToast().show("warning", "Current file is not a *.test.ts document.");
        }
      },
    });
  },
});
```

---

## 5. Setting Up Yank Note with Nexus MMO Engine

1. **Install Yank Note:**
   - Download the prebuilt release for Windows / macOS / Linux from [github.com/purocean/yn/releases](https://github.com/purocean/yn/releases).
2. **Open Engine Repository as Workspace:**
   - In Yank Note, select **File $\to$ Open Folder...** and choose `c:/Users/user/Downloads/mmo-engine-full/docs`.
   - All documentation chapters, decision logs, and roadmaps will appear in the native navigation sidebar.
3. **Configure Executable Code Snippets:**
   - Navigate to **Settings $\to$ Extensions $\to$ Code Runner**.
   - Ensure `node` and `npm` executables are mapped in PATH.
   - Code blocks with language `bash`, `powershell`, or `javascript` can now be executed directly with a single click.
4. **Mermaid Rendering Standard:**
   - Always format Mermaid diagrams using the supported grammar standards (`flowchart TD`, `graph TD`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram`, `erDiagram`, `xychart-beta`).
   - Avoid unsupported experimental diagrams (e.g. `quadrantChart`) to guarantee 100% rendering fidelity across both Yank Note and web documentation viewers.
