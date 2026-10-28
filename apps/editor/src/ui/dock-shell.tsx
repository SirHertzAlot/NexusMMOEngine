// DockShell – top‑level layout for the modular editor
// Provides a toolbar, workspace picker, and a central work area that can host various panels.
// This is the skeleton for EA1; further panes (admin console, entity inspector, appearance editor) will be
// registered as dock panes by the feature branches.

import * as React from "react";
import { WorkspacePicker } from "./workspace-picker.js";
import { LayoutProvider } from "./layout-store.js";

export function DockShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <LayoutProvider>
      <div className="flex flex-col h-full">
        {/* Toolbar – can be expanded later */}
        <header className="flex items-center p-2 bg-surface-variant" aria-label="Editor toolbar">
          <h1 className="text-lg font-medium mr-4">Nexus MMO Editor</h1>
          <WorkspacePicker />
        </header>
        {/* Main work area */}
        <main className="flex-1 overflow-auto" aria-label="Editor workspace">
          {children}
        </main>
      </div>
    </LayoutProvider>
  );
}
