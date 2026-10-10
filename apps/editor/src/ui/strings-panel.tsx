/**
 * Strings panel (roadmap EA25, EDITOR-ARCHITECTURE section 7c.8): the
 * localization tables of content/strings/<lang>.json as one grid, a row per
 * string id and a column per language. Missing translations and messages
 * whose ICU or placeholders differ from the English source are flagged as
 * you type; the pseudo-locale column shows the English source accented and
 * stretched, the way the client renders it with ?lang=pseudo. Save goes
 * through the dev host, which validates again (same rules, shared with the
 * client) and writes nothing when refused.
 */
import * as React from "react";
import { isLangCode, pseudoLocalize, SOURCE_LANG, stringRows, t as format, validateTables, type StringIssue, type StringRow, type StringTables } from "@mmo-engine/scene";
import { issueCount } from "../save-outcome.js";
import { getStrings, saveStrings } from "../strings-client.js";
import { addId, addLang, changedLangs, coverage, removeId, setMessage } from "../strings-model.js";
import { Button, CheckField, Field, Input, Select } from "./components.js";
import { DataTable, type Column } from "./data-table.js";
import { DocBar } from "./doc-bar.js";
import { useDocActions } from "./doc-actions.js";
import { useDocument } from "./use-document.js";
import { useSaveTask } from "./use-save-task.js";
import { BarRow, Pill, SectionLabel } from "./previews.js";
import { stringsStore } from "./strings-selection.js";

type Show = "all" | "missing" | "problems";

/** Values the in-context preview formats messages with. */
const SAMPLE = { count: 2, name: "Aria", title: "The Old Watchtower", giver: "Warden Hale", part: "left arm", spell: "Mend" };

const status = (r: StringRow, langs: readonly string[]): { missing: boolean; problem: boolean } => ({
  missing: langs.some((l) => l !== SOURCE_LANG && r.cells[l].status === "missing"),
  problem: langs.some((l) => r.cells[l].status === "invalid" || r.cells[l].status === "extra"),
});

/** One message, edited in place and committed when you leave it. */
function MessageCell({ lang, row, onCommit }: { lang: string; row: StringRow; onCommit: (text: string) => void }): React.JSX.Element {
  const cell = row.cells[lang];
  const [text, setText] = React.useState(cell.text ?? "");
  React.useEffect(() => setText(cell.text ?? ""), [cell.text]);
  const bad = cell.status === "invalid" || cell.status === "extra";
  return (
    <span className="flex items-center gap-1">
      <input
        value={text}
        aria-label={`${row.id} ${lang}`}
        aria-invalid={bad || undefined}
        placeholder={cell.status === "missing" ? "missing" : undefined}
        title={cell.issues.join("; ") || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== (cell.text ?? "") && onCommit(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(cell.text ?? "");
        }}
        className="m3-focus w-56 rounded border bg-transparent px-1.5 text-[12.5px]"
        style={{ height: 26, borderColor: bad ? "#FFB4AB" : cell.status === "missing" ? "#E8A33D" : "var(--m3-outline-variant)" }}
      />
      {cell.status === "missing" && lang !== SOURCE_LANG && <Pill tone="warn">missing</Pill>}
      {bad && <Pill tone="err">{cell.status === "extra" ? "extra" : "invalid"}</Pill>}
    </span>
  );
}

export function StringsPanel(): React.JSX.Element {
  const doc = useDocument<StringTables>();
  const task = useSaveTask<StringIssue>();
  const { row: picked } = stringsStore.use();
  const [filter, setFilter] = React.useState("");
  const [show, setShow] = React.useState<Show>("all");
  const [pseudo, setPseudo] = React.useState(true);
  const [newId, setNewId] = React.useState("");
  const [newText, setNewText] = React.useState("");
  const [newLang, setNewLang] = React.useState("");

  const load = React.useCallback((): void => {
    task.setStatus({ tone: "info", text: "loading…" });
    getStrings()
      .then((b) => {
        doc.load(b.tables);
        task.clear();
      })
      .catch((e: unknown) => task.setStatus({ tone: "bad", text: e instanceof Error ? e.message : String(e) }));
  }, []);
  React.useEffect(() => load(), [load]);

  const tables = doc.value;
  const saved = doc.saved;
  const live = React.useMemo(() => (tables ? validateTables(tables) : []), [tables]);
  const save = async (): Promise<void> => {
    if (!tables || !saved) return;
    if (await task.run(() => saveStrings(changedLangs(tables, saved)), { ok: (langs) => `Saved ${langs.join(", ")} to content/strings/`, refused: (i) => `Not saved: ${issueCount(i.length)}` })) {
      doc.markSaved(tables);
    }
  };
  useDocActions(() => {
    if (!tables) return null;
    return {
      label: "string tables",
      canSave: doc.dirty && live.length === 0,
      ...doc.history,
      problems: live.map((i) => ({ severity: "error" as const, where: `${i.lang}${i.id ? `:${i.id}` : ""}`, message: i.message })),
      save: () => void save(),
      revert: doc.revert,
      canRevert: doc.dirty,
      exportDoc: () => ({ name: "strings", data: tables }),
      importDoc: (incoming: unknown) => {
        const found = validateTables(incoming as StringTables);
        if (found.length > 0) throw new Error(`invalid strings: ${found.slice(0, 3).map((i) => `${i.lang}${i.id ? `:${i.id}` : ""} ${i.message}`).join("; ")}`);
        doc.edit(incoming as StringTables);
      },
    };
  });

  if (!tables) {
    const failed = task.status?.tone === "bad";
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]" data-testid="strings-panel">
        <p>Strings: {task.status?.text ?? "loading…"}</p>
        {failed && <Button size="sm" variant="outline" onClick={load}>Retry</Button>}
      </div>
    );
  }

  const langs = Object.keys(tables).sort((a, b) => (a === SOURCE_LANG ? -1 : b === SOURCE_LANG ? 1 : a.localeCompare(b)));
  const all = stringRows(tables, langs);
  const needle = filter.trim().toLowerCase();
  const rows = all.filter((r) => {
    const s = status(r, langs);
    if (show === "missing" && !s.missing) return false;
    if (show === "problems" && !s.problem) return false;
    return needle === "" || r.id.toLowerCase().includes(needle) || langs.some((l) => (r.cells[l].text ?? "").toLowerCase().includes(needle));
  });
  const missingCount = all.filter((r) => status(r, langs).missing).length;
  const problemCount = all.filter((r) => status(r, langs).problem).length;
  const row = all.find((r) => r.id === picked) ?? null;
  const issues = task.issues.length > 0 ? task.issues : live;
  const canAddId = isNewId(tables, newId);
  const canAddLang = isLangCode(newLang) && !(newLang in tables);

  const columns: Array<Column<StringRow>> = [
    { id: "id", header: "id", mono: true, nowrap: true, cellClass: () => "text-xs", cell: (r) => r.id },
    ...langs.map<Column<StringRow>>((l) => ({
      id: l,
      header: l === SOURCE_LANG ? "en · source" : l,
      interactive: true,
      cell: (r) => <MessageCell lang={l} row={r} onCommit={(text) => doc.edit(setMessage(tables, l, r.id, text))} />,
    })),
    ...(pseudo
      ? [{ id: "pseudo", header: "pseudo", nowrap: true, cellClass: () => "text-xs text-muted-foreground", cell: (r: StringRow) => (r.cells[SOURCE_LANG].text === undefined ? "" : pseudoLocalize(r.cells[SOURCE_LANG].text)) } as Column<StringRow>]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2" data-testid="strings-panel">
      <div className="flex flex-wrap items-center gap-2">
        <DocBar dirty={doc.dirty} busy={task.busy} saveBlocked={live.length > 0} history={doc.history} onSave={() => void save()} onRevert={doc.revert}>
          <Button size="sm" variant="outline" disabled={task.busy} onClick={load}>Reload</Button>
        </DocBar>
        <span className="text-xs" style={{ color: task.status?.tone === "bad" ? "#FFB4AB" : "var(--m3-on-surface-variant)" }} role="status">
          {task.status?.text ?? ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Pill tone={missingCount > 0 ? "warn" : "ok"}>Missing · {missingCount}</Pill>
          <Pill tone={problemCount > 0 ? "err" : "ok"}>Problems · {problemCount}</Pill>
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Filter">
          <Input aria-label="Filter strings" placeholder="id or text" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ height: 32, width: 200 }} />
        </Field>
        <Field label="Show">
          <Select size="sm" aria-label="Show strings" value={show} onChange={(e) => setShow(e.target.value as Show)}>
            <option value="all">all strings</option>
            <option value="missing">missing a translation</option>
            <option value="problems">with problems</option>
          </Select>
        </Field>
        <CheckField label="Pseudo-locale column" checked={pseudo} onChange={setPseudo} className="pb-2" />
        <span className="ml-auto flex items-end gap-2">
          <Field label="New id"><Input aria-label="New string id" placeholder="ui.bag.title" value={newId} onChange={(e) => setNewId(e.target.value)} style={{ height: 32, width: 160 }} /></Field>
          <Field label="English text"><Input aria-label="New string text" value={newText} onChange={(e) => setNewText(e.target.value)} style={{ height: 32, width: 180 }} /></Field>
          <Button
            size="sm"
            variant="outline"
            disabled={!canAddId}
            onClick={() => {
              doc.edit(addId(tables, newId, newText));
              stringsStore.set({ row: newId });
              setNewId("");
              setNewText("");
            }}
          >
            Add string
          </Button>
          <Field label="New language"><Input aria-label="New language code" placeholder="de" value={newLang} onChange={(e) => setNewLang(e.target.value)} style={{ height: 32, width: 80 }} /></Field>
          <Button size="sm" variant="outline" disabled={!canAddLang} onClick={() => { doc.edit(addLang(tables, newLang)); setNewLang(""); }}>
            Add language
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          selected={picked}
          onPick={(r) => stringsStore.set({ row: r.id })}
          columns={columns}
          ariaLabel="String tables"
          emptyText="No strings match."
          menuLabel={(r) => `${r.id} actions`}
          menu={(r) => [{ label: "Delete string", icon: "delete", danger: true, run: () => doc.edit(removeId(tables, r.id)) }]}
        />
      </div>
      <div className="grid max-h-52 shrink-0 grid-cols-3 gap-2 overflow-auto">
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-2 text-sm font-medium">Languages</p>
          {langs.map((l) => (
            <BarRow key={l} label={l === SOURCE_LANG ? "en · source" : l} pct={coverage(tables, l) * 100} text={`${Math.round(coverage(tables, l) * 100)} %`} bar={coverage(tables, l) === 1 ? "#9CD67D" : "#B9C3FF"} />
          ))}
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }} data-testid="strings-context">
          <SectionLabel>{row ? row.id : "In context"}</SectionLabel>
          {row ? <RowPreview row={row} tables={tables} langs={langs} /> : <p className="text-xs text-muted-foreground">Pick a string to see it formatted, in each language and in the pseudo-locale.</p>}
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--m3-surface-2)" }} role="list" aria-label="Problems">
          <SectionLabel>{issues.length === 0 ? "No problems" : issueCount(issues.length)}</SectionLabel>
          {issues.slice(0, 40).map((i, k) => (
            <button key={k} role="listitem" className="m3-focus block w-full text-left text-xs" style={{ color: "#FFB4AB" }} onClick={() => i.id && stringsStore.set({ row: i.id })}>
              {i.lang}:{i.id || "(table)"} {i.message}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const isNewId = (tables: StringTables, id: string): boolean => id.trim() !== "" && !(id in (tables[SOURCE_LANG] ?? {}));

/** The picked string formatted with sample values in each language and in the pseudo-locale, with how much longer the pseudo text is. */
function RowPreview({ row, tables, langs }: { row: StringRow; tables: StringTables; langs: readonly string[] }): React.JSX.Element {
  const en = row.cells[SOURCE_LANG].text;
  const pseudo = en === undefined ? undefined : pseudoLocalize(en);
  const lines: Array<[string, string | undefined, string[]]> = [
    ...langs.map<[string, string | undefined, string[]]>((l) => [l, row.cells[l].text === undefined ? undefined : format(tables[l], row.id, SAMPLE), row.cells[l].issues]),
    ["pseudo", pseudo === undefined ? undefined : format({ [row.id]: pseudo }, row.id, SAMPLE), []],
  ];
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      {lines.map(([l, text, why]) => (
        <div key={l}>
          <span className="mr-1.5 font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{l}</span>
          {text === undefined ? <Pill tone="warn">missing</Pill> : <span>{text}</span>}
          {l === "pseudo" && text !== undefined && en !== undefined && (
            <span className="ml-1.5 text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
              +{Math.round(((text.length - format({ [row.id]: en }, row.id, SAMPLE).length) / Math.max(1, format({ [row.id]: en }, row.id, SAMPLE).length)) * 100)}% longer
            </span>
          )}
          {why.map((w) => <div key={w} className="text-[11px]" style={{ color: "#FFB4AB" }}>{w}</div>)}
        </div>
      ))}
    </div>
  );
}
