/**
 * "New module" (roadmap EB8): the form behind the Modules panel's button.
 *
 * A module is four things in agreement — a manifest the registry accepts, a
 * server entry whose keys match the system names it declares, an optional
 * editor entry, and the name in the enabled set — and getting one of them
 * slightly wrong fails the boot. The form asks only for what cannot be
 * generated, shows the refusals from `module-scaffold.ts` (the same rules
 * the host applies, so the button never offers something the route would
 * reject), and afterwards says what is left to do.
 */

import * as React from "react";
import { refuseScaffold, type ScaffoldRefusal } from "../module-scaffold.js";
import { Button, Input, Label, SectionTitle } from "./components.js";

export interface NewModuleDialogProps {
  open: boolean;
  /** The modules that already exist: a name clash and an unknown dependency are both refusals. */
  existing: readonly string[];
  onCancel(): void;
  onCreate(req: { name: string; description: string; dependsOn: string[]; systems: string[]; editor: boolean }): void;
  busy?: boolean;
  /** What the host said when it refused, if it did. */
  issues?: ReadonlyArray<{ path: string; message: string }>;
}

/** A comma or space separated list, with the empties dropped. */
export function parseList(raw: string): string[] {
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function NewModuleDialog(props: NewModuleDialogProps): React.JSX.Element | null {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [dependsOn, setDependsOn] = React.useState("core");
  const [systems, setSystems] = React.useState("");
  const [editor, setEditor] = React.useState(false);
  if (!props.open) return null;

  const req = {
    name: name.trim(),
    description,
    dependsOn: parseList(dependsOn),
    systems: parseList(systems),
    editor,
  };
  // Nothing is said about an empty form: the refusals appear as it is filled.
  const refusals: ScaffoldRefusal[] = name.trim().length === 0 ? [] : refuseScaffold(req, props.existing);
  const shown = [...refusals, ...(props.issues ?? [])];

  const field = (label: string, value: string, set: (v: string) => void, hint: string, testid: string): React.JSX.Element => (
    <div className="flex flex-col gap-1">
      <Label>{label}</Label>
      <Input className="h-9" value={value} data-testid={testid} onChange={(e) => set(e.target.value)} placeholder={hint} />
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.5)" }}
      role="dialog"
      aria-label="New module"
      data-testid="new-module-dialog"
    >
      <div
        className="flex w-[30rem] flex-col gap-2 rounded-lg border p-4 shadow-lg"
        style={{ background: "var(--m3-surface)", borderColor: "var(--m3-outline-variant)" }}
      >
        <SectionTitle>New module</SectionTitle>
        {field("Name", name, setName, "lowercase, digits, dashes", "new-module-name")}
        {field("Description", description, setDescription, "what it is for — the Modules panel shows this", "new-module-description")}
        {field("Depends on", dependsOn, setDependsOn, "core", "new-module-depends")}
        {field("Systems", systems, setSystems, "one id per system, comma separated", "new-module-systems")}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={editor} data-testid="new-module-editor" onChange={(e) => setEditor(e.target.checked)} />
          Also add an editor entry with one panel
        </label>
        {shown.length > 0 && (
          <ul className="rounded-md border p-2 text-xs" role="alert" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-error)" }}>
            {shown.map((r, i) => (
              <li key={`${r.path}-${i}`}>
                <code>{r.path || "(module)"}</code>: {r.message}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={props.onCancel}>Cancel</Button>
          <Button
            size="sm"
            data-testid="new-module-create"
            disabled={props.busy || name.trim().length === 0 || refusals.length > 0}
            onClick={() => props.onCreate(req)}
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
