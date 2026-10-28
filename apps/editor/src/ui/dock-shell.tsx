// DockShell – top‑level layout for the modular editor
// Provides a toolbar, workspace picker, and a central work area that can host various panels.
// Registered with Admin Console dock pane (left sidebar, ⚙️) and Appearance Editor bottom dock pane (🎨).

import * as React from "react";
import { WorkspacePicker } from "./workspace-picker.js";
import { LayoutProvider } from "./layout-provider.js";
import { AdminConsole } from "./AdminConsole.js";
import { AppearanceEditor } from "./AppearanceEditor.js";
import { DockPanel } from "./components.js";

export function DockShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [activeTab, setActiveTab] = React.useState<string>("admin");
  const [leftVisible, setLeftVisible] = React.useState<boolean>(true);
  const [bottomTab, setBottomTab] = React.useState<string>("appearance");
  const [bottomVisible, setBottomVisible] = React.useState<boolean>(true);

  return (
    <LayoutProvider>
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <header className="flex items-center p-2 bg-surface-variant" aria-label="Editor toolbar">
          <h1 className="text-lg font-medium mr-4">Nexus MMO Editor</h1>
          <WorkspacePicker />
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setBottomVisible((v) => !v)}
              className="rounded px-2 py-1 text-xs font-medium"
              style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
              title="Toggle Appearance & Equipment Bottom Pane"
            >
              🎨 Appearance
            </button>
            <button
              onClick={() => setLeftVisible((v) => !v)}
              className="rounded px-2 py-1 text-xs font-medium"
              style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface)" }}
              title="Toggle Admin Console Sidebar"
            >
              ⚙️ Admin
            </button>
          </div>
        </header>
        {/* Main work area & bottom dock */}
        <div className="flex flex-1 min-h-0 flex-col">
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
          </div>
          {bottomVisible && (
            <div className="h-56 flex-none border-t border-outline-variant" aria-label="Bottom Dock Pane">
              <DockPanel
                tabs={[
                  { id: "appearance", label: "Appearance & Equipment", icon: "🎨" },
                ]}
                active={bottomTab}
                onTab={setBottomTab}
              >
                <AppearanceEditor />
              </DockPanel>
            </div>
          )}
        </div>
      </div>
    </LayoutProvider>
  );
}
