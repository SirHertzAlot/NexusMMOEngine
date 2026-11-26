// Editor entry of the ecs module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { EcsInspectorPanel } from "../../../apps/editor/src/ui/ecs-inspector.js";
import { ForgeEntityInspector } from "../../../apps/editor/src/ui/forge-inspector.js";
import { ForgeSystemsPanel } from "../../../apps/editor/src/ui/forge-systems.js";
import { ForgeIntegrationsPanel } from "../../../apps/editor/src/ui/forge-integrations.js";
import { ForgeConsolePanel } from "../../../apps/editor/src/ui/forge-console.js";
import { BlenderLinkPanel } from "../../../apps/editor/src/ui/blender-panel.js";

export const panels = [
  {
    id: "ecs",
    workspace: "scene",
    title: "Viewport",
    icon: "view_in_ar",
    render: () => <EcsInspectorPanel />,
  },
  {
    // The 2026 design language on a real screen (docs/EDITOR-UI-2026.md).
    // Same session hook as the panel above, different presentation.
    id: "ecs-forge",
    workspace: "scene",
    title: "Inspector (Forge)",
    icon: "dashboard_customize",
    render: () => <ForgeEntityInspector />,
  },
  {
    // Every system, its component signature from the committed ECS graph,
    // and what it costs on the running tick (docs/EDITOR-UI-2026.md §2.3).
    id: "ecs-systems",
    workspace: "scene",
    title: "Systems",
    icon: "schema",
    render: () => <ForgeSystemsPanel />,
  },
  {
    // One status list for what the editor is wired to, and what it is not
    // (docs/EDITOR-UI-2026.md §2.6). The styling mockup's Integrations tab.
    id: "ecs-integrations",
    workspace: "debug",
    title: "Integrations",
    icon: "hub",
    render: () => <ForgeIntegrationsPanel />,
  },
  {
    // What Blender has pushed through the live link (docs/BLENDER-LINK.md).
    id: "ecs-blender",
    workspace: "artaudio",
    title: "Blender link",
    icon: "deployed_code",
    render: () => <BlenderLinkPanel />,
  },
  {
    // One console over every stream the editor already produced
    // (docs/EDITOR-UI-2026.md §2.6). Both mockups carry this tab.
    id: "ecs-console",
    workspace: "debug",
    title: "Console",
    icon: "terminal",
    render: () => <ForgeConsolePanel />,
  },
];
