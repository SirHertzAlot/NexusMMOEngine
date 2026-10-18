/**
 * Labelled forms over a JSON document, driven by field specs
 * (rules-control.ts `FieldSpec`): the Rules tables, the dungeon run rules
 * and the other designer settings panels share them.
 *
 *   <FieldGrid fields={FLAT} value={draft} basePath="" file="loot" issues={issues} lists={{}} onChange={edit} />
 *   <RecordEditor under="bases" noun="base" fields={...} newEntry={() => ({ ... })} ... />
 *
 * An empty field removes its key (the engine default, shown as the
 * placeholder, applies), or stores null for a `nullable` field. `file` is
 * the document's name without `.json`: issues are matched to fields by
 * `<file>.json` and the field's key path (`issuesAt`).
 */

import * as React from "react";
import { fieldText, getAt, isFieldError, issuesAt, parseField, setAt, type FieldSpec, type RulesIssue } from "../rules-control.js";
import { Badge, Button, Input, Label, SectionTitle, Select } from "./components.js";

/** Named option lists an `enum` field can draw from (`options: "techniques"`). */
export type OptionLists = Readonly<Record<string, readonly string[]>>;

export function FieldGrid(props: {
  fields: readonly FieldSpec[];
  value: unknown;
  basePath: string;
  file: string;
  issues: readonly RulesIssue[];
  lists: OptionLists;
  onChange: (next: unknown) => void;
}): React.JSX.Element {
  const { fields, value, basePath, file, issues, onChange } = props;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-3">
      {fields.map((f) => {
        const path = basePath === "" ? f.key : `${basePath}.${f.key}`;
        return (
          <SpecField
            key={path}
            spec={f}
            value={getAt(value, path)}
            issues={issuesAt(issues, file, path)}
            lists={props.lists}
            onChange={(v) => onChange(setAt(value, path, v))}
          />
        );
      })}
    </div>
  );
}

/** A heading, a line of help and a field grid: one section of a long form. */
export function FieldSection(props: React.ComponentProps<typeof FieldGrid> & { title: string; help?: string }): React.JSX.Element {
  const { title, help, ...grid } = props;
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>{title}</SectionTitle>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      <FieldGrid {...grid} />
    </section>
  );
}

export function SpecField(props: {
  spec: FieldSpec;
  value: unknown;
  issues: readonly RulesIssue[];
  lists: OptionLists;
  onChange: (v: unknown) => void;
}): React.JSX.Element {
  const { spec, value, issues, onChange } = props;
  const id = React.useId();
  const placeholder =
    spec.def === undefined ? (spec.nullable ? "none" : "required") : `default ${fieldText(spec, spec.def) || "none"}`;
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
    const options = spec.kind === "bool" ? ["true", "false"] : typeof spec.options === "string" ? (props.lists[spec.options] ?? []) : spec.options;
    control = (
      <Select size="md"
        id={id}
        value={value === undefined || value === null ? "" : String(value)}
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
      <Label htmlFor={id} className="flex items-center gap-1" title={spec.help}>
        {spec.label}
        {spec.restart && (
          <Badge tone="warn" className="px-1.5 py-0 text-[10px]">
            restart
          </Badge>
        )}
      </Label>
      {control}
      {spec.help && <span className="text-[11px] leading-snug text-muted-foreground">{spec.help}</span>}
      {messages.map((m, i) => (
        <span key={i} className="text-xs text-red-400">
          {m}
        </span>
      ))}
    </div>
  );
}

/** A record of named entries (`under.<id>`): a list to pick from, add and remove, and the picked entry's fields. */
export function RecordEditor(props: {
  file: string;
  under: string;
  noun: string;
  fields: readonly FieldSpec[];
  value: unknown;
  issues: readonly RulesIssue[];
  lists: OptionLists;
  /** A new entry's starting values. */
  newEntry: () => Record<string, unknown>;
  /** What a new id must look like (default: lowercase letters, digits and _). */
  idRule?: { pattern: RegExp; hint: string };
  onChange: (next: unknown) => void;
}): React.JSX.Element {
  const { file, under, noun, fields, value, issues, onChange } = props;
  const idRule = props.idRule ?? { pattern: /^[a-z][a-z0-9_]*$/, hint: "lowercase letters, digits, _" };
  const entries = (getAt(value, under) as Record<string, unknown> | undefined) ?? {};
  const ids = Object.keys(entries);
  const [selected, setSelected] = React.useState<string | null>(ids[0] ?? null);
  const [newId, setNewId] = React.useState("");
  const current = selected !== null && selected in entries ? selected : (ids[0] ?? null);

  const idError = newId === "" ? null : !idRule.pattern.test(newId) ? idRule.hint : newId in entries ? "taken" : null;

  const add = (): void => {
    if (newId === "" || idError) return;
    onChange(setAt(value, under, { ...entries, [newId]: props.newEntry() }));
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
          const bad = issuesAt(issues, file, `${under}.${id}`).length > 0;
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
              file={file}
              issues={issues}
              lists={props.lists}
              onChange={onChange}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function IssueList({ issues, title = "Refused — the server wouldn't load this" }: { issues: readonly RulesIssue[]; title?: string }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <div className="rounded-md border border-red-900 bg-red-950/40 p-3">
      <SectionTitle>{title}</SectionTitle>
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
