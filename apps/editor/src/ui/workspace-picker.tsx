// WorkspacePicker – dropdown to switch editor workspaces (EA1)
// Placeholder implementation; will be populated with the list of workspaces later.

import * as React from "react";

export function WorkspacePicker() {
  const [ws, setWs] = React.useState<string>("editor");
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setWs(e.target.value);
    // TODO: update URL hash / layout store
  };
  return (
    <select value={ws} onChange={handleChange} aria-label="Workspace picker">
      <option value="editor">Editor</option>
      <option value="scene">Scene</option>
      <option value="flow">Flow</option>
      <option value="modules">Modules</option>
    </select>
  );
}
