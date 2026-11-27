/**
 * "Make prefab" (roadmap EB3): the form behind the Scenes outliner's
 * button, and the card that says what one instance changes.
 *
 * Prefabs themselves are not new — `prefab.ts` has had the document, the
 * field-by-field override, nesting and the cycle check since the data-driven
 * entities work, and the Gameplay grids edit the files. What was missing is
 * the direction a scene editor actually works in: you arrange a camp in the
 * viewport and want that to become the camp, reusable, without retyping it
 * as JSON. The rules are `prefabAuthorProblems`, so this form refuses
 * exactly what the host would, and the host still has the last word.
 *
 * It says that the prefab file is written straight away, because it is: the
 * scene edit is undoable and the file is not, and a button that quietly
 * leaves a file behind on undo is worse than one that says so.
 */

import * as React from "react";
import {
  findNode,
  instanceOverrides,
  prefabAuthorProblems,
  selectionAnchor,
  topOfSelection,
  type PrefabDoc,
  type SceneDoc,
  type SceneNode,
} from "@mmo-engine/scene";
import { instanceSummary, overrideLabel, suggestPrefabName } from "../scene-prefab.js";
import { Badge, Button, Input, Label, SectionTitle } from "./components.js";

export interface MakePrefabDialogProps {
  open: boolean;
  doc: SceneDoc;
  /** What is selected; nodes inside a chosen node come along rather than twice. */
  ids: readonly string[];
  /** Prefabs that already exist: a clash is a refusal. */
  existing: readonly string[];
  busy?: boolean;
  /** What the host said when it refused, if it did. */
  issues?: ReadonlyArray<{ path: string; message: string }>;
  onCancel(): void;
  onMake(name: string): void;
}

const coords = (v: readonly number[]): string => v.map((n) => Math.round(n * 100) / 100).join(", ");

export function MakePrefabDialog(props: MakePrefabDialogProps): React.JSX.Element | null {
  const took = topOfSelection(props.doc, props.ids);
  const nodes = took.map((id) => findNode(props.doc, id)).filter((n): n is SceneNode => n !== undefined);
  const suggested = suggestPrefabName(nodes.length > 0 ? nodes : [{ id: took[0] ?? "prefab" }], props.existing);
  const [name, setName] = React.useState(suggested);
  const [touched, setTouched] = React.useState(false);
  // The selection changes under the dialog as little as it can, but the
  // suggestion should follow it until somebody types over it.
  React.useEffect(() => {
    if (!touched) setName(suggested);
  }, [suggested, touched]);
  if (!props.open) return null;

  const refusals = name.trim().length === 0 ? [] : prefabAuthorProblems(props.doc, props.ids, name.trim(), props.existing);
  const shown = [...refusals, ...(props.issues ?? [])];
  const anchor = selectionAnchor(props.doc, props.ids);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.5)" }}
      role="dialog"
      aria-label="Make prefab"
      data-testid="make-prefab-dialog"
    >
      <div
        className="flex w-[30rem] flex-col gap-2 rounded-lg border p-4 shadow-lg"
        style={{ background: "var(--m3-surface)", borderColor: "var(--m3-outline-variant)" }}
      >
        <SectionTitle>Make a prefab</SectionTitle>
        <div className="flex flex-col gap-1">
          <Label htmlFor="make-prefab-name">Name</Label>
          <Input
            id="make-prefab-name"
            className="h-9"
            value={name}
            data-testid="make-prefab-name"
            placeholder="lowercase, digits, dashes"
            onChange={(e) => {
              setTouched(true);
              setName(e.target.value);
            }}
          />
        </div>
        <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }} data-testid="make-prefab-takes">
          {took.length === 0
            ? "Nothing is selected."
            : `${took.length} node${took.length === 1 ? "" : "s"} go in — ${took.join(", ")} — with its own children. The prefab's origin is ${coords(anchor)}, where the instance lands.`}
        </p>
        <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
          <code>content/prefabs/{name.trim() || "<name>"}.prefab.json</code> is written now. The scene keeps one node that places it, which Undo takes back — the file stays,
          to place again.
        </p>
        {shown.length > 0 && (
          <ul className="rounded-md border p-2 text-xs" role="alert" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-error)" }}>
            {shown.map((r, i) => (
              <li key={`${r.path}-${i}`}>
                <code>{r.path || "(prefab)"}</code>: {r.message}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={props.onCancel}>Cancel</Button>
          <Button
            size="sm"
            data-testid="make-prefab-create"
            disabled={props.busy || name.trim().length === 0 || refusals.length > 0}
            onClick={() => props.onMake(name.trim())}
          >
            Make prefab
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface PrefabInstanceCardProps {
  node: SceneNode;
  /** The prefab this node places, when there is one by that name. */
  prefab: PrefabDoc | undefined;
  onRevert(component: string, field?: string): void;
}

/**
 * What this instance takes from its prefab and what it says differently.
 * The merge was always there; nothing showed which of a node's fields were
 * the instance's own, so an override read as the prefab's own value and
 * editing the prefab looked like it had done nothing.
 */
export function PrefabInstanceCard(props: PrefabInstanceCardProps): React.JSX.Element {
  const overrides = props.prefab ? instanceOverrides(props.node, props.prefab) : [];
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2" data-testid="prefab-instance">
      <div className="flex items-baseline gap-2">
        <strong className="text-sm">Prefab</strong>
        {props.prefab ? (
          overrides.length > 0 && <Badge tone="info">{overrides.length} overridden</Badge>
        ) : (
          <Badge tone="warn">no such prefab</Badge>
        )}
      </div>
      <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }} data-testid="prefab-instance-summary">
        {instanceSummary(props.node, props.prefab)}
      </p>
      {overrides.map((o) => (
        <div key={`${o.component}.${o.field}`} className="flex items-start gap-2 text-xs">
          {/* Wrapped, not truncated: the prefab's own value is the end of
              the line and the reason the line is there. */}
          <span className="min-w-0 flex-1 break-words">{overrideLabel(o)}</span>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            data-testid={`prefab-revert-${o.component}-${o.field}`}
            onClick={() => props.onRevert(o.component, o.field)}
          >
            Revert
          </Button>
        </div>
      ))}
    </div>
  );
}
