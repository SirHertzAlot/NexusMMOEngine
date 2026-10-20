// Editor entry of the database module (complete-modularity): panels contributed
// instead of hard-wired into the shell. Panel ids preserve the pre-module
// view ids so saved layouts keep working.
import * as React from "react";
import { DatabaseGridPanel, DatabaseQueryPanel, DatabaseAuditPanel } from "../../../apps/editor/src/ui/database-workspace.js";

export const panels = [
  {
    id: "grid",
    workspace: "database",
    title: "Data grid",
    icon: "table_view",
    render: () => <DatabaseGridPanel />,
  },
  {
    id: "query",
    workspace: "database",
    title: "Query",
    icon: "code",
    render: () => <DatabaseQueryPanel />,
  },
  {
    id: "audit",
    workspace: "database",
    title: "Audit log",
    icon: "history",
    render: () => <DatabaseAuditPanel />,
  },
];
