/**
 * Strings (roadmap EA25): the client's string tables, `content/strings/<lang>.json`.
 * English is the source; every other language shows, per string, whether it is
 * translated, missing, stale (English changed since it was translated), has
 * different arguments than the source, or is much longer. The pseudo-locale
 * previews every string accented and stretched (the client shows the same with
 * ?lang=pseudo). Extraction compares the ids the client's t() calls use with
 * en.json. Save validates every message (ICU syntax) on the host and writes
 * nothing when refused.
 */
import * as React from "react";
import {
  formatMessage,
  messageArgs,
  parseMessage,
  stringsStatus,
  textHash,
  type StringStatus,
  type StringsBundle,
} from "@mmo-engine/scene";
import { getStrings, saveStrings, UiSaveError, type StringsBundleSet } from "../ui-client.js";
import { clearDocActions, registerDocActions } from "./doc-actions.js";
import { MIcon } from "./components.js";

const btn = "m3-focus rounded-full px-3 py-1 text-[13px] font-medium";
const outline = { border: "1px solid var(--m3-outline-variant)" } as const;
const fieldStyle: React.CSSProperties = { background: "var(--m3-surface-1)", color: "var(--m3-on-surface)", border: "1px solid var(--m3-outline-variant)" };
const TONE: Record<StringStatus | "extra", string> = {
  ok: "#6FCF97",
  missing: "#E8A33D",
  stale: "#E8A33D",
  mismatch: "#F2705E",
  long: "#E8A33D",
  extra: "#90909A",
};
const FILTERS = ["all", "missing", "stale", "mismatch", "long", "extra"] as const;
type Filter = (typeof FILTERS)[number];
const LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/** Sample values to show a message with: numbers for count-like names, the name itself otherwise. */
function sampleArgs(text: string, given: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (const a of messageArgs(text)) out[a] = given[a] ?? (/^(n|count|num|amount)/i.test(a) ? 3 : `‹${a}›`);
  } catch {
    /* a broken message has no arguments to sample */
  }
  return out;
}
function preview(text: string, lang: string, args: Record<string, string>, pseudo = false): string {
  try {
    return formatMessage(text, sampleArgs(text, args), { lang, pseudo });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
function syntaxError(text: string): string | null {
  try {
    parseMessage(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// What the left dock needs from the panel: the languages (with a status line) and the id groups.
interface StringsUi {
  lang: string;
  group: string | null;
  langs: Array<{ lang: string; note: string }>;
  groups: Array<[string, number]>;
}
let sui: StringsUi = { lang: "en", group: null, langs: [], groups: [] };
const slisteners = new Set<() => void>();
const setSui = (p: Partial<StringsUi>): void => {
  sui = { ...sui, ...p };
  slisteners.forEach((l) => l());
};
const useSui = (): StringsUi =>
  React.useSyncExternalStore(
    (fn) => {
      slisteners.add(fn);
      return () => void slisteners.delete(fn);
    },
    () => sui,
  );

/** Left dock of the Strings view: languages and the id groups (bag, chat, …), both filter the table. */
export function StringsOutline(): React.JSX.Element {
  const u = useSui();
  return (
    <div className="flex flex-col gap-1">
      <p className="px-3 pt-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Languages</p>
      {u.langs.map((l) => (
        <button key={l.lang} className="m3-focus flex h-9 items-center gap-2 rounded-full px-3 text-sm" aria-pressed={l.lang === u.lang} style={l.lang === u.lang ? { background: "var(--m3-secondary-container)" } : undefined} onClick={() => setSui({ lang: l.lang })}>
          <MIcon name="translate" size={18} />
          <span className="font-mono">{l.lang}</span>
          <span className="ml-auto text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{l.note}</span>
        </button>
      ))}
      <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Groups</p>
      {[[null, u.groups.reduce((n, g) => n + g[1], 0)] as [string | null, number], ...u.groups].map(([g, n]) => (
        <button key={g ?? "all"} className="m3-focus flex h-8 items-center gap-2 rounded-full px-3 text-sm" aria-pressed={g === u.group} style={g === u.group ? { background: "var(--m3-secondary-container)" } : undefined} onClick={() => setSui({ group: g })}>
          <span className="font-mono">{g ?? "all"}</span>
          <span className="ml-auto text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>{n}</span>
        </button>
      ))}
    </div>
  );
}

export function StringsPanel(): React.JSX.Element {
  const [data, setData] = React.useState<StringsBundleSet | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, StringsBundle>>({});
  const [saved, setSaved] = React.useState<Record<string, string>>({});
  const { lang, group } = useSui();
  const setLang = (l: string | ((cur: string) => string)): void => setSui({ lang: typeof l === "function" ? l(sui.lang) : l });
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [pseudo, setPseudo] = React.useState(false);
  const [row, setRow] = React.useState<string | null>(null);
  const [args, setArgs] = React.useState<Record<string, string>>({});
  const [status, setStatus] = React.useState("loading…");
  const [problems, setProblems] = React.useState<string[]>([]);
  const [newId, setNewId] = React.useState("");
  const [newText, setNewText] = React.useState("");
  const [newLang, setNewLang] = React.useState("");

  const load = React.useCallback((): void => {
    setStatus("loading…");
    getStrings()
      .then((d) => {
        setData(d);
        setDrafts(structuredClone(d.langs));
        setSaved(Object.fromEntries(Object.entries(d.langs).map(([l, b]) => [l, JSON.stringify(b)])));
        setLang((cur) => (cur in d.langs ? cur : Object.keys(d.langs).find((l) => l !== "en") ?? "en"));
        setStatus("");
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  }, []);
  React.useEffect(load, [load]);

  const dirtyLangs = Object.keys(drafts).filter((l) => JSON.stringify(drafts[l]) !== saved[l]);
  const save = React.useCallback(async (): Promise<void> => {
    const done: Record<string, string> = {};
    const refused: string[] = [];
    for (const l of dirtyLangs.sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : a.localeCompare(b)))) {
      try {
        await saveStrings(l, drafts[l]);
        done[l] = JSON.stringify(drafts[l]);
      } catch (e) {
        if (e instanceof UiSaveError) refused.push(...e.issues.map((i) => `${l}: ${i.path} ${i.message}`));
        else refused.push(`${l}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setSaved((s) => ({ ...s, ...done }));
    setProblems(refused);
    setStatus(refused.length ? `${refused.length} problem${refused.length === 1 ? "" : "s"}: nothing was written for ${refused.length === 1 ? "that language" : "those languages"}` : `saved ${Object.keys(done).join(", ")} to content/strings`);
  }, [dirtyLangs, drafts]);

  React.useEffect(() => {
    if (!data) return;
    const target = { label: "string tables", canSave: dirtyLangs.length > 0, canUndo: false, canRedo: false, save: () => void save(), undo: () => undefined, redo: () => undefined };
    registerDocActions(target);
    return () => clearDocActions(target);
  });

  // Tell the left dock what to list.
  React.useEffect(() => {
    const e = drafts.en;
    if (!e) return;
    const total = Object.keys(e.messages).length;
    const ls = ["en", ...Object.keys(drafts).filter((l) => l !== "en").sort()].map((l) => ({
      lang: l,
      note: l === "en" ? `${total}` : `${stringsStatus(e, drafts[l]).counts.missing} missing`,
    }));
    const g = new Map<string, number>();
    for (const id of Object.keys(e.messages)) g.set(id.split(".")[0], (g.get(id.split(".")[0]) ?? 0) + 1);
    const groups = [...g].sort((a, b) => a[0].localeCompare(b[0]));
    if (JSON.stringify([ls, groups]) !== JSON.stringify([sui.langs, sui.groups])) setSui({ langs: ls, groups });
  });

  if (!data || !drafts.en) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-[13px]">
        <p>Strings: {status}</p>
        {status !== "loading…" && (
          <button className={btn} style={outline} onClick={load}>Retry</button>
        )}
      </div>
    );
  }

  const en = drafts.en;
  const langs = ["en", ...Object.keys(drafts).filter((l) => l !== "en").sort()];
  const tr = lang === "en" ? null : drafts[lang];
  const st = tr ? stringsStatus(en, tr) : null;
  const statusOf = new Map(st?.rows.map((r) => [r.id, r.status]));
  const extra = new Set(st?.extra ?? []);
  const ids = [...Object.keys(en.messages), ...(st?.extra ?? [])];
  const q = query.trim().toLowerCase();
  const shown = ids.filter((id) => {
    if (group !== null && !id.startsWith(`${group}.`)) return false;
    if (q && !id.toLowerCase().includes(q) && !(en.messages[id] ?? "").toLowerCase().includes(q) && !(tr?.messages[id] ?? "").toLowerCase().includes(q)) return false;
    if (filter === "all") return true;
    if (filter === "extra") return extra.has(id);
    return statusOf.get(id) === filter;
  });
  const selected = row && (row in en.messages || extra.has(row)) ? row : null;

  const update = (l: string, f: (b: StringsBundle) => StringsBundle): void => {
    setDrafts((d) => ({ ...d, [l]: f(d[l]) }));
    setProblems([]);
  };
  const setSource = (id: string, text: string): void => update("en", (b) => ({ ...b, messages: { ...b.messages, [id]: text } }));
  const setTranslation = (id: string, text: string): void =>
    update(lang, (b) => {
      const messages = { ...b.messages };
      const source = { ...(b.source ?? {}) };
      if (text === "") {
        delete messages[id];
        delete source[id];
      } else {
        messages[id] = text;
        if (en.messages[id] !== undefined) source[id] = textHash(en.messages[id]);
      }
      return { ...b, messages, source };
    });
  const markReviewed = (id: string): void => update(lang, (b) => ({ ...b, source: { ...(b.source ?? {}), [id]: textHash(en.messages[id] ?? "") } }));
  const addString = (id: string, text: string): void => {
    update("en", (b) => ({ ...b, messages: { ...b.messages, [id]: text } }));
    setRow(id);
  };
  const removeString = (id: string): void => {
    for (const l of Object.keys(drafts)) {
      if (id in drafts[l].messages) {
        update(l, (b) => {
          const messages = { ...b.messages };
          const source = { ...(b.source ?? {}) };
          delete messages[id];
          delete source[id];
          return { ...b, messages, source };
        });
      }
    }
  };
  const addLang = (): void => {
    if (!LANG_RE.test(newLang) || newLang in drafts) {
      setStatus(`"${newLang}" is not a new language code like fr or pt-BR`);
      return;
    }
    setDrafts((d) => ({ ...d, [newLang]: { version: 1, lang: newLang, messages: {}, source: {} } }));
    setLang(newLang);
    setNewLang("");
    setStatus("");
  };
  const idErr = newId !== "" && !/^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*$/.test(newId) ? "ids are words joined by dots, like hud.bag.title" : newId in en.messages ? "that id exists" : null;
  const sel = selected;
  const selSrc = sel ? en.messages[sel] ?? "" : "";
  const selTr = sel && tr ? tr.messages[sel] ?? "" : "";
  const selArgs = sel ? (() => { try { return [...messageArgs(selSrc)]; } catch { return []; } })() : [];
  const dirty = dirtyLangs.length > 0;

  return (
    <div className="flex flex-col gap-3 p-3" style={{ color: "var(--m3-on-surface)" }}>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={{ color: "var(--m3-on-surface-variant)" }}>content/strings/</span>
        <span>{Object.keys(en.messages).length} strings · {langs.length} language{langs.length === 1 ? "" : "s"}</span>
        <span className="ml-auto flex items-center gap-2">
          {dirty && <span style={{ color: "#E8A33D" }}>unsaved: {dirtyLangs.join(", ")}</span>}
          <button className={btn} style={outline} disabled={!dirty} onClick={() => { setDrafts(structuredClone(data.langs)); setSaved(Object.fromEntries(Object.entries(data.langs).map(([l, b]) => [l, JSON.stringify(b)]))); setProblems([]); }}>Revert</button>
          <button className={btn} style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)", opacity: dirty ? 1 : 0.5 }} disabled={!dirty} onClick={() => void save()}>Save</button>
        </span>
      </div>
      {status && <div className="text-[12px]" style={{ color: "var(--m3-on-surface-variant)" }}>{status}</div>}
      {problems.length > 0 && (
        <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label="string problems">
          {problems.map((p, k) => (
            <li key={k} className="font-mono">{p}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))" }} role="tablist" aria-label="Languages">
        {langs.map((l) => {
          const c = l === "en" ? null : stringsStatus(en, drafts[l]).counts;
          const total = Object.keys(en.messages).length;
          return (
            <button
              key={l}
              role="tab"
              aria-selected={l === lang}
              onClick={() => setLang(l)}
              className="m3-focus rounded-xl p-2.5 text-left text-[12px]"
              style={{ background: l === lang ? "var(--m3-secondary-container)" : "var(--m3-surface-2)", border: l === lang ? "1px solid var(--m3-primary)" : "1px solid transparent" }}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold">{l}</span>
                <span style={{ color: "var(--m3-on-surface-variant)" }}>{l === "en" ? "source" : `${c!.ok + c!.long + c!.mismatch + c!.stale} / ${total} translated`}</span>
              </div>
              {c && (
                <div className="mt-1 flex flex-wrap gap-x-2">
                  {(["missing", "stale", "mismatch", "long"] as const).map((k) => (
                    <span key={k} style={{ color: c[k] ? TONE[k] : "var(--m3-on-surface-variant)" }}>{k} {c[k]}</span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
        <div className="flex items-center gap-1 rounded-xl p-2" style={{ background: "var(--m3-surface-2)" }}>
          <input className="m3-focus w-20 rounded-md px-2 py-1 font-mono text-[13px]" style={fieldStyle} placeholder="fr" aria-label="New language code" value={newLang} onChange={(e) => setNewLang(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addLang()} />
          <button className={btn} style={outline} onClick={addLang}>Add language</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input className="m3-focus rounded-full px-4 py-1.5 text-sm" style={{ ...fieldStyle, minWidth: 220 }} placeholder="Filter strings" aria-label="Filter strings" value={query} onChange={(e) => setQuery(e.target.value)} />
        {FILTERS.filter((f) => lang !== "en" || f === "all").map((f) => (
          <button
            key={f}
            className="m3-focus rounded-full px-3 py-1 text-xs"
            aria-pressed={f === filter}
            style={f === filter ? { background: "var(--m3-secondary-container)" } : outline}
            onClick={() => setFilter(f)}
          >
            {f}{f !== "all" && st ? ` · ${f === "extra" ? st.extra.length : st.counts[f]}` : ""}
          </button>
        ))}
        <button
          className="m3-focus ml-auto flex items-center gap-1 rounded-full px-3 py-1 text-xs"
          aria-pressed={pseudo}
          style={pseudo ? { background: "var(--m3-secondary-container)" } : outline}
          onClick={() => setPseudo((p) => !p)}
        >
          <MIcon name="translate" size={15} />Pseudo-locale
        </button>
        {pseudo && (
          <button className="m3-focus rounded-full px-3 py-1 text-xs" style={outline} onClick={() => window.open("http://localhost:5173/?lang=pseudo", "_blank", "noopener")}>
            Open client in pseudo
          </button>
        )}
      </div>

      <div className="max-h-[420px] overflow-auto rounded-xl" style={{ background: "var(--m3-surface-2)" }}>
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {["id", "en · source", ...(lang !== "en" ? [lang] : []), ...(pseudo ? ["pseudo"] : []), "status"].map((h) => (
                <th key={h} className="sticky top-0 whitespace-nowrap px-2 text-left font-medium" style={{ background: "var(--m3-surface-2)", color: "var(--m3-on-surface-variant)", height: 32 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((id) => {
              const s = extra.has(id) ? "extra" : lang === "en" ? "ok" : (statusOf.get(id) ?? "ok");
              const src = en.messages[id];
              const err = lang === "en" ? syntaxError(src ?? "") : syntaxError(tr?.messages[id] ?? "");
              return (
                <tr key={id} data-string={id} onClick={() => setRow(id)} className="cursor-pointer" style={{ borderBottom: "1px solid #2a2b31", background: id === selected ? "#2b2f4a" : undefined }}>
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">{id}</td>
                  <td className="px-2 py-1">
                    {src === undefined ? <span style={{ color: "var(--m3-on-surface-variant)" }}>(not in en.json)</span> : lang === "en" ? (
                      <input className="m3-focus w-full rounded px-1.5 py-0.5 text-[12.5px]" style={{ ...fieldStyle, minWidth: 240, borderColor: err ? "#F2705E" : undefined }} value={src} aria-label={`English ${id}`} onChange={(e) => setSource(id, e.target.value)} onFocus={() => setRow(id)} />
                    ) : (
                      <span>{src}</span>
                    )}
                  </td>
                  {lang !== "en" && (
                    <td className="px-2 py-1">
                      <input className="m3-focus w-full rounded px-1.5 py-0.5 text-[12.5px]" style={{ ...fieldStyle, minWidth: 240, borderColor: err ? "#F2705E" : undefined }} value={tr?.messages[id] ?? ""} placeholder={s === "missing" ? "untranslated" : ""} aria-label={`${lang} ${id}`} onChange={(e) => setTranslation(id, e.target.value)} onFocus={() => setRow(id)} />
                    </td>
                  )}
                  {pseudo && <td className="px-2 py-1 font-mono text-xs">{src === undefined ? "" : preview(src, "en", {}, true)}</td>}
                  <td className="whitespace-nowrap px-2 py-1 text-xs" style={{ color: err ? TONE.mismatch : TONE[s] }}>{err ? "syntax" : s}</td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-center" style={{ color: "var(--m3-on-surface-variant)" }}>No strings match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {sel && (
        <div className="flex flex-col gap-2 rounded-xl p-3 text-[12.5px]" style={{ background: "var(--m3-surface-2)" }} aria-label={`Details of ${sel}`}>
          <p className="font-mono text-xs">{sel}{data.used[sel] ? ` · used in ${data.used[sel].join(", ")}` : ""}</p>
          <label className="flex flex-col gap-0.5">
            <span style={{ color: "var(--m3-on-surface-variant)" }}>English (source)</span>
            <textarea className="m3-focus rounded-md px-2 py-1 font-mono text-[12.5px]" style={fieldStyle} rows={2} value={selSrc} onChange={(e) => setSource(sel, e.target.value)} disabled={lang !== "en" && extra.has(sel)} />
          </label>
          {lang !== "en" && (
            <label className="flex flex-col gap-0.5">
              <span style={{ color: "var(--m3-on-surface-variant)" }}>{lang} translation</span>
              <textarea className="m3-focus rounded-md px-2 py-1 font-mono text-[12.5px]" style={fieldStyle} rows={2} value={selTr} onChange={(e) => setTranslation(sel, e.target.value)} />
            </label>
          )}
          {(() => {
            const text = lang === "en" ? selSrc : selTr;
            const err = syntaxError(text);
            return (
              <>
                {err && <p style={{ color: TONE.mismatch }}>syntax: {err}</p>}
                {selArgs.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span style={{ color: "var(--m3-on-surface-variant)" }}>sample values</span>
                    {selArgs.map((a) => (
                      <label key={a} className="flex items-center gap-1 font-mono text-xs">
                        {a}
                        <input className="m3-focus w-16 rounded px-1.5 py-0.5" style={fieldStyle} aria-label={`Sample ${a}`} value={args[a] ?? (/^(n|count|num|amount)/i.test(a) ? "3" : "")} onChange={(e) => setArgs((x) => ({ ...x, [a]: e.target.value }))} />
                      </label>
                    ))}
                  </div>
                )}
                {!err && text !== "" && (
                  <>
                    <p><span style={{ color: "var(--m3-on-surface-variant)" }}>reads: </span>{preview(text, lang, args)}</p>
                    <p><span style={{ color: "var(--m3-on-surface-variant)" }}>pseudo: </span><span className="font-mono">{preview(selSrc, "en", args, true)}</span></p>
                  </>
                )}
              </>
            );
          })()}
          <div className="flex flex-wrap gap-2">
            {lang !== "en" && statusOf.get(sel) === "stale" && (
              <button className={btn} style={outline} onClick={() => markReviewed(sel)}>Mark as reviewed (English change needs no edit)</button>
            )}
            {(lang === "en" || extra.has(sel)) && (
              <button className={btn} style={{ border: "1px solid #F2705E", color: "#F2705E" }} onClick={() => { removeString(sel); setRow(null); }}>
                {lang === "en" ? "Delete string from every language" : `Delete ${sel} from ${lang}`}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
        <div className="rounded-xl p-3 text-[12.5px]" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Add a string (English)</p>
          <div className="flex flex-col gap-1.5">
            <input className="m3-focus rounded-md px-2 py-1 font-mono text-[13px]" style={fieldStyle} placeholder="hud.example.title" aria-label="New string id" value={newId} onChange={(e) => setNewId(e.target.value)} />
            <input className="m3-focus rounded-md px-2 py-1 text-[13px]" style={fieldStyle} placeholder="English text" aria-label="New string text" value={newText} onChange={(e) => setNewText(e.target.value)} />
            {idErr && <span style={{ color: TONE.mismatch }}>{idErr}</span>}
            <button className={btn} style={outline} disabled={newId === "" || idErr !== null || syntaxError(newText) !== null} onClick={() => { addString(newId, newText); setNewId(""); setNewText(""); }}>
              <MIcon name="add" size={15} /> Add string
            </button>
          </div>
        </div>
        <div className="rounded-xl p-3 text-[12.5px]" style={{ background: "var(--m3-surface-2)" }}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--m3-on-surface-variant)" }}>Extraction from the client's t() calls</p>
          <p style={{ color: "var(--m3-on-surface-variant)" }}>{Object.keys(data.used).length} ids used · {data.prefixes.length} computed prefixes ({data.prefixes.join(" ")})</p>
          <p className="mt-1.5 font-medium" style={{ color: data.missingInSource.length ? TONE.missing : TONE.ok }}>
            {data.missingInSource.length ? `${data.missingInSource.filter((id) => !(id in en.messages)).length} used but not in en.json` : "every id the client uses is in en.json"}
          </p>
          <ul>
            {data.missingInSource.filter((id) => !(id in en.messages)).map((id) => (
              <li key={id} className="flex items-center gap-2 font-mono text-xs">
                {id} <span style={{ color: "var(--m3-on-surface-variant)" }}>{data.used[id]?.join(", ")}</span>
                <button className="m3-focus ml-auto rounded-full px-2 py-0.5" style={outline} onClick={() => addString(id, "")}>add</button>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 font-medium" style={{ color: data.unused.length ? TONE.stale : TONE.ok }}>
            {data.unused.length ? `${data.unused.filter((id) => id in en.messages).length} in en.json that nothing uses` : "every string is used"}
          </p>
          <ul>
            {data.unused.filter((id) => id in en.messages).map((id) => (
              <li key={id} className="flex items-center gap-2 font-mono text-xs">
                {id}
                <button className="m3-focus ml-auto rounded-full px-2 py-0.5" style={outline} onClick={() => removeString(id)}>remove</button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
