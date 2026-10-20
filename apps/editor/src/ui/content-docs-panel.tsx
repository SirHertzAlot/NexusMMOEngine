/**
 * A designer settings panel over one or more content documents
 * (content-docs.ts): a tab per document, each a form the caller draws with
 * the spec-form pieces, saved on its own through the dev host, which
 * validates it with the game's own schema and writes nothing it refuses.
 *
 *   <ContentDocsPanel note="Read at server start." tabs={[
 *     { doc: "instances", label: "Run rules", render: (f) => <FieldGrid {...f.grid} fields={RUN_FIELDS} /> },
 *   ]} />
 *
 * Undo and Redo walk the edits across tabs; the toolbar's Save, Revert,
 * Import and Export act on the open tab.
 */

import * as React from "react";
import { CONTENT_DOC_FILES, getContentDoc, saveContentDoc, type ContentDocName } from "../content-docs.js";
import type { RulesIssue } from "../rules-control.js";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./components.js";
import { useDocActions } from "./doc-actions.js";
import { DocBar } from "./doc-bar.js";
import { IssueList, type OptionLists } from "./spec-form.js";
import { useSaveTask } from "./use-save-task.js";
import { useTableDrafts } from "./use-table-drafts.js";

/** What a tab's form is drawn with. */
export interface DocForm {
  value: unknown;
  issues: readonly RulesIssue[];
  /** Replace the draft (an edit). */
  onChange: (next: unknown) => void;
  /** The props every spec-form grid over this document takes (add `fields` and `basePath`). */
  grid: { value: unknown; file: string; issues: readonly RulesIssue[]; lists: OptionLists; onChange: (next: unknown) => void };
}

export interface DocTab {
  doc: ContentDocName;
  label: string;
  render: (form: DocForm) => React.ReactNode;
}

export function ContentDocsPanel(props: {
  tabs: readonly DocTab[];
  /** One line above the form: when the game picks a saved change up. */
  note?: string;
  lists?: OptionLists;
}): React.JSX.Element {
  const { tabs } = props;
  const docs = tabs.map((t) => t.doc);
  const drafts = useTableDrafts<ContentDocName, unknown>();
  const [tab, setTab] = React.useState<ContentDocName>(docs[0]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const task = useSaveTask<RulesIssue>();
  const lists = props.lists ?? {};
  const key = docs.join(",");

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const loaded = await Promise.all(docs.map(async (d) => [d, await getContentDoc(d)] as const));
      drafts.load(Object.fromEntries(loaded) as Record<ContentDocName, unknown>);
      task.clear();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    // `docs` is keyed by `key`; drafts.load and task.clear are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const save = React.useCallback(async (): Promise<boolean> => {
    const d = drafts.drafts;
    if (!d) return false;
    const ok = await task.run(() => saveContentDoc(tab, d[tab]), { ok: `Saved content/${CONTENT_DOC_FILES[tab]}` });
    if (ok) drafts.markSaved(tab);
    return ok;
  }, [drafts, tab, task]);

  useDocActions(() => {
    const d = drafts.drafts;
    if (!d) return null;
    return {
      label: `content/${CONTENT_DOC_FILES[tab]}`,
      canSave: drafts.dirtyOf(tab),
      ...drafts.history,
      save: () => void save(),
      canRevert: drafts.dirtyOf(tab),
      revert: () => drafts.revert(tab),
      exportDoc: () => ({ name: tab, data: d[tab] }),
      // The host validates on Save and refuses a bad document, so an import only fills the draft.
      importDoc: (incoming: unknown) => drafts.edit(tab, incoming),
    };
  });

  if (!drafts.drafts) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          {loadError ?? "Loading…"}
          {loadError && (
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const current = tabs.find((t) => t.doc === tab) ?? tabs[0];
  const value = drafts.drafts[current.doc];
  const issues = task.issues.filter((i) => i.file === `${current.doc}.json`);
  const onChange = (next: unknown): void => {
    drafts.edit(current.doc, next);
    task.setStatus(null);
  };
  const form: DocForm = { value, issues, onChange, grid: { value, file: current.doc, issues, lists, onChange } };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((t) => (
          <Button key={t.doc} size="sm" variant={t.doc === current.doc ? "default" : "outline"} onClick={() => setTab(t.doc)}>
            {t.label}
            {drafts.dirtyOf(t.doc) && <span aria-label="unsaved" className="h-2 w-2 rounded-full bg-yellow-400" />}
          </Button>
        ))}
        <span className="ml-auto font-mono text-xs text-muted-foreground">content/{CONTENT_DOC_FILES[current.doc]}</span>
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{current.label}</CardTitle>
          <div className="flex items-center gap-2">
            {task.status && <Badge tone={task.status.tone}>{task.status.text}</Badge>}
            <DocBar
              dirty={drafts.dirtyOf(current.doc)}
              busy={task.busy}
              onSave={() => void save()}
              onRevert={() => {
                drafts.revert(current.doc);
                task.clear();
              }}
              history={drafts.history}
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {props.note && <p className="text-xs text-muted-foreground">{props.note}</p>}
          {current.render(form)}
          <IssueList issues={issues} />
        </CardContent>
      </Card>
    </div>
  );
}
