/**
 * "What goes with it" — the question the Modules panel asks before a module
 * is turned off (roadmap EB9).
 *
 * It lists the modules that have to go too, then what that costs: systems
 * out of the tick order, editor panels that disappear, sidecars that stop.
 * The arithmetic is `module-blast.ts`; this is the dialog, kept separate so
 * the list can be rendered in a test without the whole panel and its hosts.
 */

import * as React from "react";
import type { BlastRadius } from "../module-blast.js";
import { Button, SectionTitle } from "./components.js";

export interface BlastDialogProps {
  radius: BlastRadius | null;
  onCancel(): void;
  onConfirm(): void;
  busy?: boolean;
}

function Line({ title, items }: { title: string; items: readonly string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <p className="text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
      <strong style={{ color: "var(--m3-on-surface)" }}>{title}:</strong> {items.join(", ")}
    </p>
  );
}

export function BlastDialog(props: BlastDialogProps): React.JSX.Element | null {
  const r = props.radius;
  if (r === null) return null;
  const going = [r.module, ...r.dependents];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.5)" }}
      role="dialog"
      aria-label={`Turn off ${r.module}`}
      data-testid="blast-dialog"
    >
      <div
        className="flex max-w-lg flex-col gap-2 rounded-lg border p-4 shadow-lg"
        style={{ background: "var(--m3-surface)", borderColor: "var(--m3-outline-variant)" }}
      >
        <SectionTitle>{`Turn off ${r.module}?`}</SectionTitle>
        <p className="text-xs leading-relaxed">
          {r.dependents.length === 1
            ? `1 other module depends on it and goes off too.`
            : `${r.dependents.length} other modules depend on it and go off too.`}
        </p>
        <Line title="Modules" items={going} />
        <Line title="Systems leaving the tick order" items={r.systems} />
        <Line title="Editor panels that disappear" items={r.editorPanels} />
        <Line title="Sidecars that stop" items={r.sidecars} />
        <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          The set is saved now; the running play server keeps its own until you apply it.
        </p>
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={props.onCancel}>Cancel</Button>
          <Button size="sm" disabled={props.busy} onClick={props.onConfirm} data-testid="blast-confirm">
            {`Turn off ${going.length}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
