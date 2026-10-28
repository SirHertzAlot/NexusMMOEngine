// DockShell – top‑level layout for the modular editor
// Provides a toolbar, workspace picker, and a central work area that can host various panels.
// Registered with Admin Console dock pane (left sidebar, ⚙️).

import * as React from "react";
import { WorkspacePicker } from "./workspace-picker.js";
import { LayoutProvider } from "./layout-provider.js";
import { AdminConsole } from "./AdminConsole.js";
import { EntityInspector } from "./EntityInspector.js";
import { DockPanel } from "./components.js";

export function DockShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [activeTab, setActiveTab] = React.useState<string>("entity-inspector");
  const [leftVisible, setLeftVisible] = React.useState<boolean>(false);
  const [rightVisible, setRightVisible] = React.useState<boolean>(true);

  return (
    <LayoutProvider>
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <header className="flex items-center p-2 bg-surface-variant" aria-label="Editor toolbar">
          <h1 className="text-lg font-medium mr-4">Nexus MMO Editor</h1>
          <WorkspacePicker />
          <button
            onClick={() => setLeftVisible((v) => !v)}
            className="rounded px-2 py-1 text-xs font-medium"
            style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
            title="Toggle Admin Console Sidebar"
          >
            ⚙️ Admin
          </button>
          <button
            onClick={() => setRightVisible((v) => !v)}
            className="rounded px-2 py-1 text-xs font-medium ml-2"
            style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
            title="Toggle Entity Inspector Sidebar"
          >
            🔎 Entity Inspector
          </button>
        </header>
        {/* Main work area */}
        <div className="flex flex-1 min-h-0">
          {leftVisible && (
            <aside className="w-80 flex-none border-r border-outline-variant" aria-label="Admin Console Dock">
              <DockPanel
                tabs={[
                  { id: "admin", label: "Admin Console", icon: "settings" },
                ]}
                active={activeTab}
                onTab={setActiveTab}
              >
                <AdminConsole />
              </DockPanel>
            </aside>
          )}
          <main className="flex-1 overflow-auto" aria-label="Editor workspace">
            {children}
          </main>
          {rightVisible && (
            <aside className="w-96 flex-none border-l border-outline-variant" aria-label="Entity Inspector Dock">
              <DockPanel
                tabs={[
                  { id: "entity-inspector", label: "Entity Inspector", icon: "search" },
                ]}
                active={activeTab}
                onTab={setActiveTab}
              >
                <EntityInspector />
              </DockPanel>
            </aside>
          )}
        </div>
      </div>
    </LayoutProvider>
  );
}
