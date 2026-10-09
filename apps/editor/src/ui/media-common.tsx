/**
 * Shared pieces of the Animation, VFX and Audio workspaces (EA21, EA22,
 * EA24): the hook that loads, edits and saves one media document through
 * the host, the selection store the left library and the Details pane
 * share, and small form fields.
 */
import * as React from "react";
import { MEDIA_DOCS, type GameContent, type MediaDocName, type MediaIssue } from "@mmo-engine/art/browser";
import { MediaSaveError, getMedia, saveMedia } from "../media-client.js";
import { clearDocActions, registerDocActions } from "./doc-actions.js";
import { notify } from "./components.js";
import { artStore } from "./previews.js";

export const btn = "m3-focus rounded-full px-3 py-1 text-[13px] font-medium";
export const fieldCls = "m3-focus rounded-md px-2 py-1 text-[13px]";
export const fieldStyle: React.CSSProperties = { background: "var(--m3-surface-1)", color: "var(--m3-on-surface)", border: "1px solid var(--m3-outline-variant)" };
export const muted: React.CSSProperties = { color: "var(--m3-on-surface-variant)" };

/** What is selected in each library: shared by the left dock, the panels and the Details pane (the deep-link store, previews.tsx). */
export const mediaStore = artStore;

/** Publish the lists the left dock shows (when they change). */
export function usePublish(patch: Partial<ReturnType<typeof mediaStore.get>>): void {
  const key = JSON.stringify(patch);
  React.useEffect(() => {
    mediaStore.set((p) => ({ ...p, ...patch }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export interface MediaDoc<N extends MediaDocName> {
  doc: NonNullable<GameContent[N]> | null;
  /** Replace the document (an edit). */
  set: (next: NonNullable<GameContent[N]>) => void;
  dirty: boolean;
  /** Problems found here, live; after a refused save, the host's. */
  issues: MediaIssue[];
  status: string;
  save: () => Promise<boolean>;
  revert: () => void;
  reload: () => void;
}

/** Load a media document and edit it in memory; `save` goes through the host, which validates again and writes nothing when refused. */
export function useMediaDoc<N extends MediaDocName>(name: N): MediaDoc<N> {
  type D = NonNullable<GameContent[N]>;
  const [doc, setDoc] = React.useState<D | null>(null);
  const [saved, setSaved] = React.useState("");
  const [status, setStatus] = React.useState("loading…");
  const [refused, setRefused] = React.useState<MediaIssue[]>([]);
  const reload = React.useCallback((): void => {
    setStatus("loading…");
    getMedia(name)
      .then((d) => {
        setDoc(d);
        setSaved(JSON.stringify(d));
        setStatus("");
        setRefused([]);
      })
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : String(e)));
  }, [name]);
  React.useEffect(reload, [reload]);
  const live = React.useMemo(() => (doc ? MEDIA_DOCS[name].validate(doc) : []), [doc, name]);
  const dirty = doc !== null && JSON.stringify(doc) !== saved;
  const save = React.useCallback(async (): Promise<boolean> => {
    if (!doc) return false;
    try {
      await saveMedia(name, doc);
      setSaved(JSON.stringify(doc));
      setRefused([]);
      setStatus(`saved to content/${MEDIA_DOCS[name].file}`);
      return true;
    } catch (e) {
      if (e instanceof MediaSaveError) setRefused(e.issues);
      setStatus(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [doc, name]);
  return {
    doc,
    set: (next) => {
      setDoc(next);
      setRefused([]);
      setStatus("");
    },
    dirty,
    issues: refused.length > 0 ? refused : live,
    status,
    save,
    revert: () => {
      setDoc(JSON.parse(saved) as D);
      setRefused([]);
      setStatus("");
    },
    reload,
  };
}

/** Register the toolbar's Save for the documents a panel edits (all of them, one after the other). */
export function useSaveAction(label: string, docs: Array<{ dirty: boolean; save: () => Promise<boolean>; revert: () => void }>): void {
  React.useEffect(() => {
    const target = {
      label,
      canSave: docs.some((d) => d.dirty),
      canUndo: false,
      canRedo: false,
      save: () => {
        void (async () => {
          for (const d of docs) if (d.dirty && !(await d.save())) return;
          notify(`${label} saved`);
        })();
      },
      undo: () => undefined,
      redo: () => undefined,
    };
    registerDocActions(target);
    return () => clearDocActions(target);
  });
}

export function SaveBar({ file, dirty, issues, status, onSave, onRevert, extra }: {
  file: string;
  dirty: boolean;
  issues: MediaIssue[];
  status: string;
  onSave: () => void;
  onRevert: () => void;
  extra?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-mono" style={muted}>{file}</span>
        <span style={{ color: issues.length ? "#E8A33D" : "#6FCF97" }}>{issues.length ? `${issues.length} problem${issues.length === 1 ? "" : "s"}` : "valid"}</span>
        <span className="ml-auto flex items-center gap-2">
          {extra}
          {dirty && <span style={{ color: "#E8A33D" }}>unsaved</span>}
          <button className={btn} style={{ background: "var(--m3-primary)", color: "var(--m3-on-primary)", opacity: dirty && issues.length === 0 ? 1 : 0.5 }} disabled={!dirty} onClick={onSave}>
            Save
          </button>
          <button className={btn} style={{ border: "1px solid var(--m3-outline-variant)" }} disabled={!dirty} onClick={onRevert}>
            Revert
          </button>
        </span>
      </div>
      {status && <div className="text-[12px]" style={muted}>{status}</div>}
      {issues.length > 0 && (
        <ul className="rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(232,163,61,.14)", color: "#E8A33D" }} aria-label={`${file} problems`}>
          {issues.map((i, k) => (
            <li key={k}><span className="font-mono">{i.path || "document"}</span>: {i.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A labelled number field; commits on every valid change. */
export function Num({ label, value, onChange, step = 0.01, min, max, unit, disabled }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>
      {label}{unit ? ` (${unit})` : ""}
      <input
        type="number" step={step} min={min} max={max} value={Number.isFinite(value) ? value : ""} disabled={disabled}
        aria-label={label}
        className={`${fieldCls} w-24 font-mono`} style={fieldStyle}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );
}

export function Text({ label, value, onChange, list, wide }: { label: string; value: string; onChange: (v: string) => void; list?: string; wide?: boolean }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>
      {label}
      <input value={value} list={list} aria-label={label} className={`${fieldCls} font-mono ${wide ? "w-56" : "w-40"}`} style={fieldStyle} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>
      {label}
      <select value={value} aria-label={label} className={`${fieldCls} font-mono`} style={fieldStyle} onChange={(e) => onChange(e.target.value as T)}>
        {!options.includes(value) && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--m3-on-surface)" }}>
      <input type="checkbox" checked={value} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5 text-[11px]" style={muted}>
      {label}
      <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"} aria-label={label} className="h-7 w-14 cursor-pointer rounded" style={fieldStyle} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<[T, string]>; onChange: (v: T) => void; label: string }): React.JSX.Element {
  return (
    <div role="tablist" aria-label={label} className="flex h-9 w-fit items-center overflow-hidden rounded-full text-sm" style={{ border: "1px solid var(--m3-outline-variant)" }}>
      {options.map(([id, text]) => (
        <button
          key={id} role="tab" aria-selected={id === value} onClick={() => onChange(id)}
          className="m3-focus flex h-full items-center px-4"
          style={id === value ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function H({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wider" style={muted}>{children}</p>;
}

/** Deep clone for edits (documents are plain JSON). */
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
