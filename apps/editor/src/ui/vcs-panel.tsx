/**
 * Changes panel (roadmap EA18): files git sees as changed, grouped by
 * document type, with a semantic diff per document, stage, commit, and
 * pull/push behind an explicit confirm. Conflicted documents resolve by
 * stable id; a true conflict lists both values to pick from.
 */
import * as React from "react";
import {
  vcsCommit, vcsDiff, vcsLocks, vcsResolve, vcsStage, vcsStatus, vcsSync, vcsUnstage,
  type VcsConflict, type VcsDiff, type VcsFile,
} from "../vcs-client.js";
import { Badge, Button, Input, notify } from "./components.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function ChangesPanel(): React.JSX.Element {
  const [branch, setBranch] = React.useState("");
  const [files, setFiles] = React.useState<VcsFile[]>([]);
  const [locks, setLocks] = React.useState<Record<string, { owner: string }>>({});
  const [open, setOpen] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<VcsDiff | null>(null);
  const [conflicts, setConflicts] = React.useState<VcsConflict[]>([]);
  const [message, setMessage] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState("");

  const refresh = React.useCallback(() => {
    vcsStatus().then((s) => (setBranch(s.branch), setFiles(s.files), setError(""))).catch((e) => setError(msg(e)));
    vcsLocks().then((l) => setLocks(l.locks)).catch(() => undefined);
  }, []);
  React.useEffect(refresh, [refresh]);

  const run = (p: Promise<unknown>, done?: string): void => {
    p.then(() => (done && notify(done), refresh())).catch((e) => (setError(msg(e)), refresh()));
  };
  const show = (f: VcsFile): void => {
    setOpen(f.path);
    setConflicts([]);
    setDiff(null);
    if (f.localOnly) return;
    vcsDiff(f.path).then(setDiff).catch((e) => setError(msg(e)));
  };
  const resolve = (path: string, choices?: Record<string, "ours" | "theirs">): void => {
    vcsResolve(path, choices)
      .then((r) => (setConflicts(r.resolved ? [] : (r.conflicts ?? [])), r.resolved && notify(`Merged ${path} by id`), refresh()))
      .catch((e) => setError(msg(e)));
  };

  const groups = new Map<string, VcsFile[]>();
  for (const f of files) groups.set(f.docType, [...(groups.get(f.docType) ?? []), f]);
  const staged = files.filter((f) => f.staged).length;

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge>{branch || "no branch"}</Badge>
        <span className="text-xs text-muted-foreground">{files.length} changed, {staged} staged</span>
        <Button size="sm" variant="outline" onClick={refresh}>Refresh</Button>
      </div>
      {error && <div className="rounded border border-destructive p-2 text-xs text-destructive">{error}</div>}
      {[...groups].map(([type, list]) => (
        <section key={type}>
          <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">{type}</div>
          {list.map((f) => (
            <div key={f.path} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                aria-label={`stage ${f.path}`}
                checked={f.staged}
                disabled={f.localOnly || f.conflicted}
                onChange={() => run(f.staged ? vcsUnstage([f.path]) : vcsStage([f.path]))}
              />
              <button className="truncate text-left font-mono text-xs underline-offset-2 hover:underline" onClick={() => show(f)}>{f.path}</button>
              <span className="text-xs text-muted-foreground">{f.status}</span>
              {f.localOnly && <Badge>local only</Badge>}
              {locks[f.path] && <Badge>locked: {locks[f.path].owner}</Badge>}
              {f.conflicted && <Button size="sm" onClick={() => (setOpen(f.path), resolve(f.path))}>Merge by id</Button>}
            </div>
          ))}
        </section>
      ))}
      {open && (
        <section className="rounded border border-border p-2">
          <div className="mb-1 font-mono text-xs">{open}</div>
          {diff?.mode === "semantic" && (diff.summary?.length ? <ul className="font-mono text-xs">{diff.summary.map((l) => <li key={l}>{l}</li>)}</ul> : <em className="text-xs">no changes</em>)}
          {diff?.mode === "text" && <pre className="max-h-64 overflow-auto text-xs">{diff.text}</pre>}
          {conflicts.map((c) => (
            <div key={c.path} className="mt-2 text-xs">
              <div className="font-mono">{c.path}</div>
              <div>ours: <code>{JSON.stringify(c.ours)}</code> <Button size="sm" variant="outline" onClick={() => resolve(open, { [c.path]: "ours" })}>Keep ours</Button></div>
              <div>theirs: <code>{JSON.stringify(c.theirs)}</code> <Button size="sm" variant="outline" onClick={() => resolve(open, { [c.path]: "theirs" })}>Take theirs</Button></div>
            </div>
          ))}
        </section>
      )}
      <div className="flex gap-2">
        <Input value={message} placeholder="Commit message" onChange={(e) => setMessage(e.target.value)} />
        <Button disabled={!staged || !message.trim()} onClick={() => run(vcsCommit(message).then(() => setMessage("")), "Committed")}>Commit</Button>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Confirm pull / push
        </label>
        <Button variant="outline" disabled={!confirm} onClick={() => run(vcsSync("pull"), "Pulled")}>Pull</Button>
        <Button variant="outline" disabled={!confirm} onClick={() => run(vcsSync("push"), "Pushed")}>Push</Button>
      </div>
    </div>
  );
}
