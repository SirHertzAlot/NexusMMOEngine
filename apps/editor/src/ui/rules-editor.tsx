/**
 * Rules panel — form/tree editor over content/rules/*.json (roadmap E11).
 *
 * Lists every rules file, shows the selected one as an editable tree
 * (numbers, booleans, strings, arrays, objects), validates on save with
 * the Zod schemas plus cross-file checks in `@mmo-engine/rules`
 * (host-side, via rules-host.ts) and writes back pretty-printed JSON
 * only when valid. Validation problems come back per path and are
 * shown both as a list and inline at the offending field.
 */

import * as React from "react";
import {
  getRuleFile,
  listRuleFiles,
  RulesSaveError,
  saveRuleFile,
} from "../rules-client.js";
import {
  formatPath,
  groupIssues,
  removeAtPath,
  setAtPath,
  type PathSegment,
  type RuleIssueView,
} from "../rules-tree.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SectionTitle,
} from "./components.js";
import { clearDocActions, registerDocActions } from "./doc-actions.js";

/** What each file sets (content/rules/README.md, one line each). */
const FILE_BLURBS: Record<string, string> = {
  skills: "Skills, families, gain, familiarity and decay.",
  disciplines: "Named paths earned by skill levels, and the techniques they unlock.",
  combat: "Techniques, damage, power and precision coefficients.",
  body: "Body parts, shares, severities and bleeding.",
  death: "Respawn delay and place, what carries over.",
  appearance: "Appearance slots and colour palettes.",
  stats: "Attributes and derived stats.",
  items: "Item physics (mass, edge, point, hardness, …).",
  loot: "Ground ownership, despawn, pickup range, bags.",
  creatures: "Creature kinds: health, aggro, packs, weapons.",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type LeafKind = "string" | "number" | "boolean" | "object" | "array" | "null";

function kindOf(v: unknown): LeafKind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return "object";
  }
}

function blankOf(kind: LeafKind): unknown {
  switch (kind) {
    case "string": return "";
    case "number": return 0;
    case "boolean": return false;
    case "object": return {};
    case "array": return [];
    case "null": return null;
  }
}

const KIND_OPTIONS: LeafKind[] = ["string", "number", "boolean", "object", "array", "null"];

function FieldErrors({ messages }: { messages: string[] | undefined }): React.JSX.Element | null {
  if (!messages || messages.length === 0) return null;
  return <p className="mt-1 text-xs text-red-400">{messages.join("; ")}</p>;
}

interface NodeProps {
  segments: PathSegment[];
  value: unknown;
  onChange: (next: unknown) => void;
  onRemove: (() => void) | null;
  errors: Map<string, string[]>;
  depth: number;
}

function NodeEditor({ segments, value, onChange, onRemove, errors, depth }: NodeProps): React.JSX.Element {
  const path = formatPath(segments);
  const messages = errors.get(path);
  const [newKey, setNewKey] = React.useState("");
  const [addKind, setAddKind] = React.useState<LeafKind>("string");

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
        {entries.map(([k, v]) => (
          <div key={k} className="rounded bg-background/60 p-1.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">{k}</span>
              <button
                type="button"
                aria-label={`Remove ${[...segments, k].join(".")}`}
                onClick={() => onChange(removeAtPath(value, [k]))}
                className="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-red-400"
              >
                ×
              </button>
            </div>
            <NodeEditor
              segments={[...segments, k]}
              value={v}
              onChange={(nv) => onChange(setAtPath(value, [k], nv))}
              onRemove={() => onChange(removeAtPath(value, [k]))}
              errors={errors}
              depth={depth + 1}
            />
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="new field name"
            aria-label={`New field name under ${path || "root"}`}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={newKey.trim() === "" || newKey in value}
            onClick={() => {
              onChange(setAtPath(value, [newKey.trim()], ""));
              setNewKey("");
            }}
          >
            Add field
          </Button>
        </div>
        <FieldErrors messages={messages} />
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
        {value.map((item, i) => (
          <div key={i} className="rounded bg-background/60 p-1.5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-muted-foreground">[{i}]</span>
              <button
                type="button"
                aria-label={`Remove ${path}[${i}]`}
                onClick={() => onChange(removeAtPath(value, [i]))}
                className="rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-red-400"
              >
                ×
              </button>
            </div>
            <NodeEditor
              segments={[...segments, i]}
              value={item}
              onChange={(nv) => onChange(setAtPath(value, [i], nv))}
              onRemove={() => onChange(removeAtPath(value, [i]))}
              errors={errors}
              depth={depth + 1}
            />
          </div>
        ))}
        {value.length === 0 && (
          <p className="text-xs text-muted-foreground">Empty list.</p>
        )}
        <div className="flex items-center gap-2">
          <select
            value={addKind}
            onChange={(e) => setAddKind(e.target.value as LeafKind)}
            aria-label={`New item kind for ${path}`}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => onChange([...value, blankOf(addKind)])}>
            Add item
          </Button>
        </div>
        <FieldErrors messages={messages} />
      </div>
    );
  }

  // Leaves: number / boolean / string / null, with a kind switcher.
  const kind = kindOf(value);
  return (
    <div>
      <div className="flex items-center gap-2">
        {typeof value === "number" || typeof value === "string" ? (
          <Input
            type={typeof value === "number" ? "number" : "text"}
            value={value}
            onChange={(e) => {
              if (typeof value === "number") {
                const n = e.target.valueAsNumber;
                onChange(Number.isNaN(n) ? e.target.value : n);
              } else {
                onChange(e.target.value);
              }
            }}
            aria-label={path || "root value"}
            className="h-8 text-xs"
          />
        ) : typeof value === "boolean" ? (
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => onChange(e.target.checked)}
            aria-label={path || "root value"}
            className="h-4 w-4"
          />
        ) : (
          <span className="font-mono text-xs text-muted-foreground">null</span>
        )}
        <select
          value={kind}
          onChange={(e) => onChange(blankOf(e.target.value as LeafKind))}
          aria-label={`Kind of ${path || "root"}`}
          title="Change this value's kind (replaces it with a blank)"
          className="h-8 rounded-md border border-input bg-background px-1 text-xs text-muted-foreground"
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        {onRemove !== null && depth > 0 && (
          <span className="text-[11px] text-muted-foreground">remove with × above</span>
        )}
      </div>
      <FieldErrors messages={messages} />
    </div>
  );
}

export function RulesPanel(): React.JSX.Element {
  const [files, setFiles] = React.useState<string[] | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [content, setContent] = React.useState<unknown>(null);
  const [pristine, setPristine] = React.useState<unknown>(null);
  const [missing, setMissing] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [issues, setIssues] = React.useState<RuleIssueView[]>([]);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    listRuleFiles("")
      .then((names) => {
        if (live) setFiles(names);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const dirty =
    content !== null &&
    pristine !== null &&
    JSON.stringify(content) !== JSON.stringify(pristine);

  async function onSelect(name: string): Promise<void> {
    if (dirty && !window.confirm("Discard unsaved changes to this file?")) return;
    setSelected(name);
    setLoading(true);
    setError(null);
    setIssues([]);
    setSavedNote(null);
    try {
      const res = await getRuleFile("", name);
      setContent(res.content);
      setPristine(res.content);
      setMissing(res.missing);
    } catch (err) {
      setContent(null);
      setPristine(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function onSave(): Promise<void> {
    if (selected === null || content === null) return;
    setSaving(true);
    setError(null);
    setSavedNote(null);
    try {
      await saveRuleFile("", selected, content);
      setPristine(content);
      setIssues([]);
      setMissing(false);
      setSavedNote("Saved — validated, written back pretty-printed.");
    } catch (err) {
      if (err instanceof RulesSaveError) {
        setIssues(err.issues);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  const fileName = selected === null ? "" : `${selected}.json`;
  const mine = issues.filter((i) => i.file === fileName);
  const others = issues.filter((i) => i.file !== fileName);
  const errors = groupIssues(mine);

  // Toolbar Save target for the open rules file (no undo stack —
  // edits apply directly, so Undo/Redo stay disabled).
  React.useEffect(() => {
    if (selected === null || content === null) return;
    const target = {
      label: `rules "${selected}.json"`,
      canSave: dirty,
      canUndo: false,
      canRedo: false,
      save: () => void onSave(),
      undo: () => undefined,
      redo: () => undefined,
    };
    registerDocActions(target);
    return () => clearDocActions(target);
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Rules files</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {error !== null && files === null ? (
            <p className="text-xs text-red-400">{error}</p>
          ) : files === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            files.map((f) => (
              <button
                key={f}
                onClick={() => void onSelect(f)}
                className={
                  "flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-1.5 text-left text-xs hover:bg-accent " +
                  (selected === f ? "border-primary bg-accent" : "border-border")
                }
              >
                <span className="font-mono font-medium">{f}.json</span>
                <span className="text-muted-foreground">{FILE_BLURBS[f] ?? ""}</span>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{selected === null ? "Rules" : `${fileName}`}</CardTitle>
            <div className="flex items-center gap-2">
              {dirty && <Badge tone="warn">unsaved changes</Badge>}
              {missing && selected !== null && <Badge tone="info">new file (defaults shown)</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {selected === null ? (
            <p className="text-xs text-muted-foreground">
              Pick a rules file on the left. Every gameplay tunable lives in
              one of these files; the engine refuses to start while any of
              them is invalid, and this editor only writes valid files.
            </p>
          ) : loading || content === null ? (
            <p className="text-xs text-muted-foreground">
              {loading ? "Loading…" : (error ?? "No content.")}
            </p>
          ) : (
            <>
              {missing && (
                <p className="text-xs text-muted-foreground">
                  {fileName} is missing on disk — showing the engine default.
                  Saving writes the file.
                </p>
              )}
              {mine.length > 0 && (
                <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
                  <span className="font-semibold">
                    Not saved — {mine.length} problem{mine.length === 1 ? "" : "s"}:
                  </span>
                  <ul className="mt-1 list-disc pl-5 font-mono">
                    {mine.map((i, n) => (
                      <li key={n}>{i.path === "" ? "(file)" : i.path}: {i.message}</li>
                    ))}
                  </ul>
                  {others.length > 0 && (
                    <p className="mt-2 font-sans">
                      Plus {others.length} problem{others.length === 1 ? "" : "s"} in
                      other files ({[...new Set(others.map((i) => i.file))].join(", ")}) —
                      those must be fixed too before anything saves.
                    </p>
                  )}
                </div>
              )}
              {error !== null && <p className="text-xs text-red-400">{error}</p>}
              {savedNote !== null && <p className="text-xs text-green-400">{savedNote}</p>}
              <div>
                <SectionTitle>Values</SectionTitle>
                <div className="mt-2">
                  <NodeEditor
                    segments={[]}
                    value={content}
                    onChange={(nv) => {
                      setContent(nv);
                      setSavedNote(null);
                    }}
                    onRemove={null}
                    errors={errors}
                    depth={0}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={() => void onSave()} disabled={saving || !dirty}>
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outline"
                  disabled={saving || !dirty}
                  onClick={() => {
                    setContent(pristine);
                    setIssues([]);
                    setError(null);
                    setSavedNote(null);
                  }}
                >
                  Revert
                </Button>
                <span className="text-xs text-muted-foreground">
                  Validated with the rules schemas on save; pretty-printed with
                  2 spaces.
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        <Label>How validation works</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Save sends the whole file to the dev host, which checks it against
          that file&apos;s Zod schema plus the cross-file checks (skill ids
          that exist, body shares that add up, techniques and item bases that
          line up) and writes it back only when every rules file is valid.
        </p>
      </div>
    </div>
  );
}
