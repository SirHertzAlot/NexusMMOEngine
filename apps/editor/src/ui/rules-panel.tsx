/**
 * Gameplay Tables (roadmap ED1): edit content/rules' item bases,
 * creatures, loot and death rules.
 *
 * Each table is edited as a draft of its JSON file. An empty field
 * removes its key, so the engine default (shown as the placeholder)
 * applies. Save sends the draft to the dev host, which validates it the
 * way the server loads it and refuses it with every issue by field; a
 * running server picks a saved table up without a restart (the few
 * fields that can't change live say so).
 */

import * as React from "react";
import { DocBar } from "./doc-bar.js";
import {
  CREATURE_FIELDS,
  DEATH_FIELDS,
  INGRESS_FIELDS,
  GATHERING_FIELDS,
  ITEM_BASE_FIELDS,
  ITEMS_FIELDS,
  LOOT_FIELDS,
  TABLES,
  createRulesControl,
  fieldText,
  getAt,
  isFieldError,
  issuesAt,
  newEntry,
  parseField,
  setAt,
  type FieldSpec,
  type RulesIssue,
  type RulesSnapshot,
  type Table,
} from "../rules-control.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, SectionTitle, Select } from "./components.js";
import { useDocActions } from "./doc-actions.js";
import { useTableDrafts } from "./use-table-drafts.js";

const control = createRulesControl();

const TABLE_LABELS: Record<Table, string> = {
  items: "Item bases",
  creatures: "Creatures",
  loot: "Loot",
  death: "Death",
  ingress: "Ingress limits",
  gathering: "Gathering",
};

/** Record tables: the key their entries live under, and the fields of one entry. */
const RECORDS: Partial<Record<Table, { under: string; fields: FieldSpec[]; noun: string }>> = {
  items: { under: "bases", fields: ITEM_BASE_FIELDS, noun: "base" },
  creatures: { under: "creatures", fields: CREATURE_FIELDS, noun: "creature" },
};

/** Flat fields of each table (beside its records, for items). */
const FLAT: Record<Table, FieldSpec[]> = {
  items: ITEMS_FIELDS,
  creatures: [],
  loot: LOOT_FIELDS,
  death: DEATH_FIELDS,
  ingress: INGRESS_FIELDS,
  gathering: GATHERING_FIELDS,
};

/** A save's outcome, shown on the table it was for. */
type Status = { tone: "ok" | "bad" | "info"; text: string; table?: Table } | null;

export function RulesPanel(): React.JSX.Element {
  const [snap, setSnap] = React.useState<RulesSnapshot | null>(null);
  const tables = useTableDrafts<Table, unknown>();
  const { drafts, load: loadTables } = tables;
  const [table, setTable] = React.useState<Table>("items");
  const [issues, setIssues] = React.useState<RulesIssue[]>([]);
  const [status, setStatus] = React.useState<Status>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const fresh = await control.load();
      setSnap(fresh);
      loadTables(fresh.tables);
      setIssues([]);
      setStatus(null);
    } catch (err) {
      setStatus({ tone: "bad", text: (err as Error).message });
    }
  }, [loadTables]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Toolbar Save target for the open table; Undo and Redo walk the edits across tables.
  useDocActions(() => {
    if (!snap || !drafts) return null;
    return {
      label: `rules table "${table}.json"`,
      canSave: tables.anyDirty,
      ...tables.history,
      save: () => void save(),
      canRevert: tables.dirtyOf(table),
      revert: () => tables.revert(table),
      exportDoc: () => ({ name: `rules-${table}`, data: drafts[table] }),
      // The host validates the whole rules set on Save and refuses a bad one, so an import only fills the draft.
      importDoc: (incoming: unknown) => tables.edit(table, incoming),
    };
  });

  if (!snap || !drafts) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          {status ? status.text : "Loading content/rules…"}
        </CardContent>
      </Card>
    );
  }

  const draft = drafts[table];
  const dirty = tables.dirtyOf;
  const edit = (next: unknown): void => {
    tables.edit(table, next);
    setStatus(null);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await control.save(table, draft);
      if (res.ok) {
        tables.markSaved(table);
        setIssues([]);
        setStatus({ tone: "ok", text: `Saved ${table}.json — a running server applies it on its next tick.`, table });
      } else {
        setIssues(res.issues);
        setStatus({ tone: "bad", text: `Not saved: ${res.issues.length} issue${res.issues.length === 1 ? "" : "s"} below.`, table });
      }
    } catch (err) {
      setStatus({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const revert = (): void => {
    tables.revert(table);
    setIssues([]);
    setStatus(null);
  };

  const record = RECORDS[table];
  const flat = FLAT[table];
  const bases = Object.keys((getAt(drafts.items, "bases") as Record<string, unknown> | undefined) ?? {});

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABLES.map((t) => (
          <Button key={t} size="sm" variant={t === table ? "default" : "outline"} onClick={() => setTable(t)}>
            {TABLE_LABELS[t]}
            {dirty(t) && <span aria-label="unsaved" className="h-2 w-2 rounded-full bg-yellow-400" />}
          </Button>
        ))}
        <span className="ml-auto font-mono text-xs text-muted-foreground">content/rules/{table}.json</span>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{TABLE_LABELS[table]}</CardTitle>
          <div className="flex items-center gap-2">
            {status && (status.table ?? table) === table && <Badge tone={status.tone}>{status.text}</Badge>}
            <DocBar dirty={dirty(table)} busy={busy} onSave={() => void save()} onRevert={revert} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {flat.length > 0 && (
            <FieldGrid
              fields={flat}
              value={draft}
              basePath=""
              table={table}
              issues={issues}
              techniques={snap.techniques}
              onChange={edit}
            />
          )}
          {record && (
            <RecordEditor
              key={table}
              table={table}
              under={record.under}
              noun={record.noun}
              fields={record.fields}
              value={draft}
              issues={issues}
              techniques={snap.techniques}
              bases={bases}
              onChange={edit}
            />
          )}
          <IssueList issues={issues} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- records

function RecordEditor(props: {
  table: Table;
  under: string;
  noun: string;
  fields: FieldSpec[];
  value: unknown;
  issues: RulesIssue[];
  techniques: string[];
  bases: string[];
  onChange: (next: unknown) => void;
}): React.JSX.Element {
  const { table, under, noun, fields, value, issues, onChange } = props;
  const entries = (getAt(value, under) as Record<string, unknown> | undefined) ?? {};
  const ids = Object.keys(entries);
  const [selected, setSelected] = React.useState<string | null>(ids[0] ?? null);
  const [newId, setNewId] = React.useState("");
  const current = selected !== null && selected in entries ? selected : (ids[0] ?? null);

  const idError =
    newId === "" ? null : !/^[a-z][a-z0-9_]*$/.test(newId) ? "lowercase letters, digits, _" : newId in entries ? "taken" : null;

  const add = (): void => {
    if (newId === "" || idError) return;
    onChange(setAt(value, under, { ...entries, [newId]: newEntry(table as "items" | "creatures", props.bases) }));
    setSelected(newId);
    setNewId("");
  };
  const remove = (id: string): void => {
    const rest = { ...entries };
    delete rest[id];
    onChange(setAt(value, under, rest));
    setSelected(null);
  };

  return (
    <div className="grid grid-cols-[12rem_1fr] gap-4">
      <div className="flex flex-col gap-1">
        <SectionTitle>{noun}s</SectionTitle>
        {ids.map((id) => {
          const bad = issuesAt(issues, table, `${under}.${id}`).length > 0;
          return (
            <button
              key={id}
              onClick={() => setSelected(id)}
              className={
                "flex items-center justify-between rounded-md px-2 py-1 text-left font-mono text-sm " +
                (id === current ? "bg-accent text-accent-foreground" : "hover:bg-accent/50")
              }
            >
              {id}
              {bad && <span className="h-2 w-2 rounded-full bg-red-500" aria-label="has issues" />}
            </button>
          );
        })}
        <div className="mt-2 flex gap-1">
          <Input
            className="h-9 font-mono"
            placeholder={`new ${noun} id`}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button size="sm" variant="outline" onClick={add} disabled={newId === "" || idError !== null}>
            Add
          </Button>
        </div>
        {idError && <span className="text-xs text-red-400">{idError}</span>}
      </div>
      <div className="flex flex-col gap-3">
        {current === null ? (
          <p className="text-sm text-muted-foreground">No {noun}s yet.</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-semibold">
                {under}.{current}
              </span>
              <Button size="sm" variant="danger" onClick={() => remove(current)}>
                Remove {noun}
              </Button>
            </div>
            <FieldGrid
              key={current}
              fields={fields}
              value={value}
              basePath={`${under}.${current}`}
              table={table}
              issues={issues}
              techniques={props.techniques}
              onChange={onChange}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- fields

function FieldGrid(props: {
  fields: FieldSpec[];
  value: unknown;
  basePath: string;
  table: Table;
  issues: RulesIssue[];
  techniques: string[];
  onChange: (next: unknown) => void;
}): React.JSX.Element {
  const { fields, value, basePath, table, issues, onChange } = props;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-3">
      {fields.map((f) => {
        const path = basePath === "" ? f.key : `${basePath}.${f.key}`;
        return (
          <Field
            key={path}
            spec={f}
            value={getAt(value, path)}
            issues={issuesAt(issues, table, path)}
            techniques={props.techniques}
            onChange={(v) => onChange(setAt(value, path, v))}
          />
        );
      })}
    </div>
  );
}

function Field(props: {
  spec: FieldSpec;
  value: unknown;
  issues: RulesIssue[];
  techniques: string[];
  onChange: (v: unknown) => void;
}): React.JSX.Element {
  const { spec, value, issues, onChange } = props;
  const id = React.useId();
  const placeholder = spec.def === undefined ? "required" : `default ${fieldText(spec, spec.def) || "none"}`;
  // Typed text the field's kind can't hold stays local until it can.
  const [text, setText] = React.useState(fieldText(spec, value));
  const [local, setLocal] = React.useState<string | null>(null);
  React.useEffect(() => {
    setText(fieldText(spec, value));
    setLocal(null);
  }, [spec, value]);

  const messages = [...(local ? [local] : []), ...issues.map((i) => i.message)];
  const ring = messages.length > 0 ? "border-red-500" : "";

  let control: React.JSX.Element;
  if (spec.kind === "bool" || spec.kind === "enum") {
    const options = spec.kind === "bool" ? ["true", "false"] : spec.options === "techniques" ? props.techniques : spec.options;
    control = (
      <Select size="md"
        id={id}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(parseField(spec, e.target.value))}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  } else {
    control = (
      <Input
        id={id}
        className={`h-9 ${spec.kind === "number" ? "text-right" : ""} ${ring}`}
        inputMode={spec.kind === "number" ? "decimal" : undefined}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseField(spec, e.target.value);
          if (isFieldError(v)) setLocal(v.error);
          else {
            setLocal(null);
            onChange(v);
          }
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="flex items-center gap-1">
        {spec.label}
        {spec.restart && (
          <Badge tone="warn" className="px-1.5 py-0 text-[10px]">
            restart
          </Badge>
        )}
      </Label>
      {control}
      {messages.map((m, i) => (
        <span key={i} className="text-xs text-red-400">
          {m}
        </span>
      ))}
    </div>
  );
}

function IssueList({ issues }: { issues: RulesIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <div className="rounded-md border border-red-900 bg-red-950/40 p-3">
      <SectionTitle>Refused — the server wouldn't load this</SectionTitle>
      <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
        {issues.map((i, n) => (
          <li key={n}>
            <span className="text-muted-foreground">
              {i.file}
              {i.path ? ` · ${i.path}` : ""}
            </span>{" "}
            <span className="text-red-300">{i.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
