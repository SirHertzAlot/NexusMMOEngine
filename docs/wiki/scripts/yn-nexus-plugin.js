/**
 * Yank Note Plugin: Nexus MMO Engine Developer Tools
 *
 * Registers custom command palette actions, status bar telemetry widgets,
 * and 1-click test runners inside Yank Note (purocean/yn).
 *
 * Install in Yank Note: Settings -> Custom Scripts / Plugins, or copy to
 * ~/.yank-note/plugins/yn-nexus-plugin.js
 */

if (typeof window !== "undefined" && window.registerPlugin) {
  window.registerPlugin({
    name: "nexus-mmo-engine-tools",
    register(ctx) {
      // 1. Add Status Bar Item for Engine Simulation Health
      const statusBarItem = ctx.statusBar.addStatusBarItem({
        position: "right",
        priority: 100,
        text: "🎮 Nexus: Offline",
        tooltip: "Click to connect to local engine telemetry (ws://127.0.0.1:3000/telemetry)",
        onClick: () => {
          connectEngineTelemetry();
        },
      });

      let telemetryWs = null;

      function connectEngineTelemetry() {
        if (telemetryWs) {
          telemetryWs.close();
          telemetryWs = null;
          statusBarItem.text = "🎮 Nexus: Disconnected";
          return;
        }

        try {
          telemetryWs = new WebSocket("ws://127.0.0.1:3000/telemetry");
          statusBarItem.text = "🎮 Nexus: Connecting...";

          telemetryWs.onopen = () => {
            statusBarItem.text = "🎮 Nexus: 30.0 Hz | 0.0ms";
            ctx.ui.showToast({ type: "success", message: "Connected to Nexus MMO Engine Telemetry" });
          };

          telemetryWs.onmessage = (event) => {
            try {
              const data = JSON.parse(event.data);
              const hz = (data.hz || 30.0).toFixed(1);
              const p99 = (data.p99 || 0.0).toFixed(1);
              statusBarItem.text = `🎮 Nexus: ${hz} Hz | ${p99}ms`;
            } catch {
              // ignore binary / malformed
            }
          };

          telemetryWs.onclose = () => {
            telemetryWs = null;
            statusBarItem.text = "🎮 Nexus: Offline";
          };

          telemetryWs.onerror = () => {
            telemetryWs = null;
            statusBarItem.text = "🎮 Nexus: Offline";
            ctx.ui.showToast({ type: "warning", message: "Nexus Engine is not currently running locally." });
          };
        } catch (e) {
          ctx.ui.showToast({ type: "error", message: `Telemetry connection failed: ${e.message}` });
        }
      }

      // 2. Action: Run Fast-Path Codec Benchmark
      ctx.commands.registerCommand({
        id: "nexus.runCodecBench",
        title: "Nexus: Run C++ Codec Benchmark",
        handler: () => {
          ctx.terminal.run("node packages/protocol/test/bench/fast-path-pilot.bench.mjs");
        },
      });

      // 3. Action: Run Parity Test Suite
      ctx.commands.registerCommand({
        id: "nexus.runParitySuite",
        title: "Nexus: Run C++ Codec Parity Suite",
        handler: () => {
          ctx.terminal.run("npm test -w @mmo-engine/protocol");
        },
      });

      // 4. Action: Open Business Analysis Hub
      ctx.commands.registerCommand({
        id: "nexus.openBusinessAnalysis",
        title: "Nexus: Open Business Analysis & Competitive Suite",
        handler: () => {
          ctx.workspace.openFile("docs/business-analysis/README.md");
        },
      });
    },
  });
}
