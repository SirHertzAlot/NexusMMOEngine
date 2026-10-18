/**
 * Gameplay Tables (roadmap ED1, EG2): edit content/rules' item bases,
 * creatures, combat, body and Medicine, loot, death, ingress,
 * gathering, movement, skill training and social rules as labelled forms.
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
  BODY_PART_FIELDS,
  BODY_SECTIONS,
  COMBAT_SECTIONS,
  CREATURE_AI_SECTIONS,
  MOVEMENT_SECTIONS,
  SKILLS_SECTIONS,
  SOCIAL_SECTIONS,
  CREATURE_FIELDS,
  TECHNIQUE_FIELDS,
  DEATH_FIELDS,
  INGRESS_FIELDS,
  GATHERING_FIELDS,
  ITEM_BASE_FIELDS,
  ITEMS_FIELDS,
  LOOT_FIELDS,
  TABLES,
  createRulesControl,
  getAt,
  newEntry,
  type FieldSectionSpec,
  type FieldSpec,
  type RulesIssue,
  type RulesSnapshot,
  type Table,
} from "../rules-control.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./components.js";
import { FieldGrid, FieldSection, IssueList, ListEditor, RecordEditor } from "./spec-form.js";
import { useDocActions } from "./doc-actions.js";
import { useTableDrafts } from "./use-table-drafts.js";

const control = createRulesControl();

const TABLE_LABELS: Record<Table, string> = {
  items: "Item bases",
  creatures: "Creatures",
  combat: "Combat",
  body: "Body and Medicine",
  loot: "Loot",
  death: "Death",
  ingress: "Ingress limits",
  gathering: "Gathering",
  movement: "Movement and stamina",
  skills: "Skills and training",
  social: "Social and characters",
};

/** Record tables: the key their entries live under, and the fields of one entry. */
const RECORDS: Partial<Record<Table, { under: string; fields: FieldSpec[]; noun: string }>> = {
  items: { under: "bases", fields: ITEM_BASE_FIELDS, noun: "base" },
  creatures: { under: "creatures", fields: CREATURE_FIELDS, noun: "creature" },
  combat: { under: "techniques", fields: TECHNIQUE_FIELDS, noun: "technique" },
};

/** List tables: entries in an array that carry their own id. */
const LISTS: Partial<Record<Table, { under: string; fields: FieldSpec[]; noun: string; newEntry: (id: string) => Record<string, unknown> }>> = {
  body: { under: "parts", fields: BODY_PART_FIELDS, noun: "part", newEntry: (id) => ({ id, name: id, parent: null, share: 0.05 }) },
};

/** Long tables, drawn in titled sections instead of one flat grid. */
const SECTIONS: Partial<Record<Table, FieldSectionSpec[]>> = {
  combat: COMBAT_SECTIONS,
  body: BODY_SECTIONS,
  movement: MOVEMENT_SECTIONS,
  creatures: CREATURE_AI_SECTIONS,
  skills: SKILLS_SECTIONS,
  social: SOCIAL_SECTIONS,
};

/** A new record entry's starting values. */
function newRecord(table: Table, bases: string[]): Record<string, unknown> {
  if (table === "combat") return { property: "edge", damageKind: "cut" };
  return newEntry(table as "items" | "creatures", bases);
}

/** Flat fields of each table (beside its records, for items). */
const FLAT: Record<Table, FieldSpec[]> = {
  items: ITEMS_FIELDS,
  creatures: [],
  combat: [],
  body: [],
  loot: LOOT_FIELDS,
  death: DEATH_FIELDS,
  ingress: INGRESS_FIELDS,
  gathering: GATHERING_FIELDS,
  movement: [],
  skills: [],
  social: [],
};

/** Rules ids (packages/rules schemas.ts): lower camel or kebab case. */
const RULES_ID = { pattern: /^[a-z][a-zA-Z0-9-]*$/, hint: "lower camel or kebab case" };

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
  const parts = ((getAt(drafts.body, "parts") as Array<{ id?: unknown }> | undefined) ?? []).map((p) => String(p.id ?? ""));
  const lists = { techniques: snap.techniques, skills: snap.skills, parts };
  const sections = SECTIONS[table];
  const list = LISTS[table];

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
            <FieldGrid fields={flat} value={draft} basePath="" file={table} issues={issues} lists={lists} onChange={edit} />
          )}
          {sections?.map((sec) => (
            <FieldSection key={sec.title} title={sec.title} help={sec.help} fields={sec.fields} value={draft} basePath="" file={table} issues={issues} lists={lists} onChange={edit} />
          ))}
          {list && (
            <ListEditor key={table} file={table} under={list.under} noun={list.noun} fields={list.fields} value={draft} issues={issues} lists={lists} newEntry={list.newEntry} onChange={edit} />
          )}
          {record && (
            <RecordEditor
              key={table}
              file={table}
              under={record.under}
              noun={record.noun}
              fields={record.fields}
              value={draft}
              issues={issues}
              lists={lists}
              newEntry={() => newRecord(table, bases)}
              idRule={RULES_ID}
              onChange={edit}
            />
          )}
          <IssueList issues={issues} />
        </CardContent>
      </Card>
    </div>
  );
}
