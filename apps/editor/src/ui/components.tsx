/**
 * Minimal shadcn-style primitives for the editor shell.
 *
 * Same vocabulary as the game client's ui/components.tsx (Button, Input,
 * Card, Label) plus the small extras the inspectors need (Badge,
 * Panel section titles, KV tables). Deliberately hand-written, no
 * shadcn CLI scaffold — same seam as the client if the design system
 * grows.
 */

import * as React from "react";
import { flattenVisible, type ScopeNode } from "./scope-tree.js";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- Button

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "danger";
type ButtonSize = "default" | "sm" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

const buttonSizes: Record<ButtonSize, string> = {
  default: "h-10 px-4 py-2",
  sm: "h-9 rounded-md px-3",
  lg: "h-11 rounded-md px-8",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "default",
  size = "default",
  className,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------- Input

export function Input({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={cn(
        "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}

/** A number box: `onChange` gets the number, or NaN while the box is empty. */
export function NumberInput({
  value,
  onChange,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & { value: number; onChange: (value: number) => void }): React.JSX.Element {
  return (
    <Input
      type="number"
      className={cn("h-9", className)}
      value={Number.isFinite(value) ? String(value) : ""}
      onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------- Select

const selectSizes = { xs: "h-7 px-1.5 text-xs", sm: "h-8 px-2 text-sm", md: "h-9 px-2 text-sm" } as const;

/** The editor's one native dropdown. Children are its `<option>`s. */
export function Select({
  size = "md",
  invalid = false,
  className,
  ...rest
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: keyof typeof selectSizes; invalid?: boolean }): React.JSX.Element {
  return (
    <select
      className={cn(
        "rounded-md border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        invalid ? "border-red-500" : "border-input",
        selectSizes[size],
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------- Field

/** A control with its label above it and, when given, the error under it. */
export function Field({ label, error, className, children }: { label: React.ReactNode; error?: string | null; className?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </label>
  );
}

/** A checkbox with its label beside it. */
export function CheckField({ label, checked, onChange, className }: { label: React.ReactNode; checked: boolean; onChange: (checked: boolean) => void; className?: string }): React.JSX.Element {
  return (
    <label className={cn("flex items-center gap-1.5 text-xs", className)}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- Card

export function Card({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("flex flex-col gap-1.5 p-4", className)} {...rest} />;
}

export function CardTitle({
  className,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h3
      className={cn("text-sm font-semibold leading-none tracking-tight", className)}
      {...rest}
    />
  );
}

export function CardContent({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("p-4 pt-0", className)} {...rest} />;
}

// ---------------------------------------------------------------- Label

export function Label({
  className,
  ...rest
}: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return (
    <label
      className={cn(
        "text-xs font-medium leading-none text-muted-foreground",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------- Badge

type BadgeTone = "default" | "ok" | "warn" | "bad" | "info";

const badgeTones: Record<BadgeTone, string> = {
  default: "bg-secondary text-secondary-foreground",
  ok: "bg-green-900 text-green-200",
  warn: "bg-yellow-900 text-yellow-200",
  bad: "bg-red-900 text-red-200",
  info: "bg-blue-900 text-blue-200",
};

export function Badge({
  tone = "default",
  className,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        badgeTones[tone],
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------- KV table

// ---------------------------------------------------------------- Section title

export function SectionTitle({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </h4>
  );
}

// ================================================================ M3 shell
// UI-ONLY additions for the EDITOR-ARCHITECTURE.md §3 shell. Purely
// presentational — no inspector logic lives here. Token values mirror
// sources/m3b.html + sources/m3c.html; Material Symbols glyphs are
// passed as plain text so the shell works offline with system fonts.

/** Material Symbol glyph rendered as text (bundled woff2, offline-safe). */
export function MIcon({ name, size = 20 }: { name: string; size?: number }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="ms" style={{ fontSize: size }}>
      {name}
    </span>
  );
}

/** M3 filter chip (layers, module kinds, table filters). */
export function Chip({
  selected,
  children,
  onClick,
  title,
}: {
  selected?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={selected === true}
      className="m3-focus inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-[13px] font-medium transition-colors"
      style={
        selected
          ? {
              background: "var(--m3-secondary-container)",
              borderColor: "transparent",
              color: "var(--m3-on-secondary-container)",
            }
          : {
              background: "transparent",
              borderColor: "var(--m3-outline-variant)",
              color: "var(--m3-on-surface-variant)",
            }
      }
    >
      {children}
    </button>
  );
}

/** M3 icon button — 40 px target on viewport overlays, 36 px in bars. */
export function IconButton({
  label,
  children,
  active,
  size = 40,
  onClick,
  title,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  active?: boolean;
  size?: 36 | 40;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      className="m3-focus m3-iconbtn grid shrink-0 place-items-center rounded-full disabled:opacity-40"
      style={{
        width: size,
        height: size,
        background: active ? "var(--m3-secondary-container)" : undefined,
        color: active ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface-variant)",
      }}
    >
      {children}
    </button>
  );
}

/** M3 text button (low emphasis, e.g. Discard, Review diff helpers). */
export function TextButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="m3-focus inline-flex h-8 items-center px-3 text-sm font-medium transition-opacity disabled:opacity-40"
      style={{ color: "var(--m3-primary)" }}
    >
      {children}
    </button>
  );
}

/** M3 switch — no form logic, controlled by the caller. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      className="m3-focus shrink-0 rounded-full transition-colors"
      style={{
        width: 52,
        height: 32,
        background: checked ? "var(--m3-primary)" : "var(--m3-surface-4)",
        border: checked ? "none" : "2px solid var(--m3-outline)",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: checked ? 4 : 6,
          right: checked ? 4 : undefined,
          left: checked ? undefined : 6,
          width: checked ? 24 : 16,
          height: checked ? 24 : 16,
          borderRadius: 999,
          background: checked ? "var(--m3-on-primary)" : "var(--m3-outline)",
        }}
      />
    </button>
  );
}

/** M3 docked panel chrome: tab strip + content (cf. .dock in mockups). */
export function DockPanel({
  tabs,
  active,
  onTab,
  children,
  actions,
}: {
  tabs: Array<{ id: string; label: string; icon?: string }>;
  active: string;
  onTab: (id: string) => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl"
      style={{ background: "var(--m3-surface-1)" }}
    >
      <div
        className="flex h-9 flex-none items-center gap-0.5 px-1.5"
        role="tablist"
        style={{ background: "var(--m3-surface-0)" }}
      >
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => onTab(t.id)}
              className="m3-focus flex items-center gap-1.5 whitespace-nowrap rounded-t-lg px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{
                background: on ? "var(--m3-surface-1)" : "transparent",
                color: on ? "var(--m3-on-surface)" : "var(--m3-on-surface-variant)",
              }}
            >
              {t.icon && <MIcon name={t.icon} size={16} />}
              {t.label}
            </button>
          );
        })}
        {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
      </div>
      <div className="m3-scroll min-h-0 flex-1 overflow-auto p-2.5 text-[13px]">{children}</div>
    </section>
  );
}

/** Compact empty state: what to do next (M3 §3.2 feedback states). */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <span style={{ color: "var(--m3-on-surface-variant)" }}>
        <MIcon name={icon} size={28} />
      </span>
      <p className="text-sm font-medium" style={{ color: "var(--m3-on-surface)" }}>
        {title}
      </p>
      <p className="max-w-64 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>
        {body}
      </p>
      {action}
    </div>
  );
}

/** Live/idle status dot + label (play server, module set). */
export function StatusChip({
  live,
  children,
}: {
  live: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs"
      style={{ background: "var(--m3-surface-1)", color: "var(--m3-on-surface-variant)" }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: live ? "var(--m3-success)" : "var(--m3-outline)",
        }}
      />
      {children}
    </span>
  );
}

// ================================================================ UI behavior
// UI-ONLY shell behavior: transient feedback, placeholder command menus,
// drill-down tree rows, persisted local prefs. Staged commands never fake
// success — they notify which slice owns them (see notify()).

/** Tiny external store (same pattern as the preview selection stores). */
function createUiStore<T>(initial: T): {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  use: () => T;
} {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      listeners.forEach((l) => l());
    },
    use: () => React.useSyncExternalStore(
      (fn) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      () => value,
    ),
  };
}

// ---------------------------------------------------------------- snackbar

const snackStore = createUiStore<{ msg: string; key: number } | null>(null);

/** Stage a not-yet-implemented command: acknowledge the click honestly. */
export function notify(msg: string): void {
  snackStore.set({ msg, key: Date.now() + Math.random() });
}

/** Bottom-center transient feedback (M3 snackbar). Mount once at the root. */
export function SnackbarHost(): React.JSX.Element {
  const snack = snackStore.use();
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    if (!snack) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 3600);
    return () => clearTimeout(t);
  }, [snack]);
  if (!snack || !visible) return <></>;
  return (
    <div
      className="fixed bottom-7 left-1/2 z-[70] flex h-[52px] -translate-x-1/2 items-center gap-6 rounded-md py-0 pl-[18px] pr-2 text-sm"
      role="status"
      style={{ background: "#E3E1E9", color: "#2F3036", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
    >
      <span className="max-w-[60vw] truncate">{snack.msg}</span>
      <button
        onClick={() => setVisible(false)}
        className="m3-focus px-3 font-semibold"
        style={{ color: "#36449A" }}
      >
        Dismiss
      </button>
    </div>
  );
}

/** Helper for staged commands: notify("<label> — staged for <slice>"). */
export function staged(label: string, slice: string): () => void {
  return () => notify(`${label} — staged for ${slice}`);
}

// ---------------------------------------------------------------- overflow menu

export interface MenuItem {
  label: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  /** Owning slice: when set (and no run), the item stages honestly. */
  stagedFor?: string;
  run?: () => void;
}

export function OverflowMenu({ label, items, size = 36 }: {
  label: string;
  items: Array<MenuItem | "sep">;
  size?: 36 | 40;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="relative inline-flex">
      <IconButton label={label} size={size} onClick={() => setOpen((v) => !v)} title={label}>
        <MIcon name="more_vert" size={18} />
      </IconButton>
      {open && (
        <>
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <menu
            className="absolute right-0 top-10 z-50 min-w-56 rounded-xl p-1.5"
            style={{ background: "var(--m3-surface-3)", boxShadow: "0 6px 16px rgba(0,0,0,.5)" }}
            aria-label={label}
          >
            {items.map((it, i) => {
              if (it === "sep") {
                return <li key={`sep-${i}`} className="list-none" style={{ borderTop: "1px solid var(--m3-outline-variant)", margin: "4px 2px" }} />;
              }
              const run = it.run ?? (it.stagedFor ? staged(it.label, it.stagedFor) : () => setOpen(false));
              return (
                <li key={it.label} className="list-none">
                  <button
                    onClick={() => {
                      setOpen(false);
                      run();
                    }}
                    className="m3-focus flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]"
                    style={{ color: it.danger ? "var(--m3-error)" : "var(--m3-on-surface)" }}
                  >
                    {it.icon && (
                      <span style={{ color: "var(--m3-on-surface-variant)" }}>
                        <MIcon name={it.icon} size={17} />
                      </span>
                    )}
                    {it.label}
                    {it.stagedFor && (
                      <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--m3-outline)" }}>staged</span>
                    )}
                    {it.kbd && (
                      <kbd className="ml-auto rounded border px-1 font-mono text-[11px]" style={{ borderColor: "var(--m3-outline-variant)", color: "var(--m3-on-surface-variant)" }}>
                        {it.kbd}
                      </kbd>
                    )}
                  </button>
                </li>
              );
            })}
          </menu>
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- tree row

/** Drill-down outliner row: chevron, icon, label, hover ⋯ menu, indent. */
export function TreeItem({ icon, label, trailing, depth = 0, expanded, onToggle, hasKids, menu, selected, onPick, mono = false }: {
  icon: string;
  label: string;
  trailing?: string;
  depth?: number;
  expanded?: boolean;
  onToggle?: () => void;
  hasKids?: boolean;
  menu?: Array<MenuItem | "sep">;
  selected?: boolean;
  onPick?: () => void;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`group flex h-9 items-center gap-1 rounded-full pr-1.5 ${mono ? "font-mono text-xs" : "text-sm"}`}
      style={{
        paddingLeft: 8 + depth * 16,
        background: selected ? "var(--m3-secondary-container)" : undefined,
        color: selected ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)",
      }}
    >
      {hasKids ? (
        <button
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          className="m3-focus grid h-7 w-7 flex-none place-items-center rounded-full"
        >
          <span style={{ transform: expanded ? "rotate(90deg)" : undefined, display: "inline-flex" }}>
            <MIcon name="chevron_right" size={17} />
          </span>
        </button>
      ) : (
        <span className="w-7 flex-none" />
      )}
      <button
        onClick={onPick ?? onToggle}
        title={label}
        className="m3-focus flex min-w-0 flex-1 items-center gap-2.5 rounded-full py-1 text-left"
      >
        <span style={{ color: selected ? undefined : "var(--m3-on-surface-variant)" }}>
          <MIcon name={icon} size={19} />
        </span>
        <span className="truncate">{label}</span>
        {trailing && (
          <span className="ml-auto flex-none font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {trailing}
          </span>
        )}
      </button>
      {menu && (
        <span className="flex-none opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <OverflowMenu label={`${label} actions`} items={menu} size={36} />
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------- data-driven tree

/**
 * A whole outliner from data. Rows, expand state and highlight come from
 * the scope-tree helpers; view code supplies only the node list, what a
 * pick means, and the row menu. View-specific node fields ride along via
 * `T extends ScopeNode` (e.g. a selection kind per row).
 */
export function ScopeTree<T extends ScopeNode>({ nodes, open, selected, onToggle, onPick, menuFor }: {
  nodes: readonly T[];
  open: readonly string[];
  selected: string | null;
  onToggle: (id: string) => void;
  onPick: (node: T) => void;
  menuFor?: (node: T) => Array<MenuItem | "sep">;
}): React.JSX.Element {
  return (
    <>
      {flattenVisible(nodes, open).map(({ node, depth, hasKids }) => {
        const full = node as T;
        return (
          <TreeItem
            key={node.id}
            icon={node.icon ?? "chevron_right"}
            label={node.label}
            trailing={node.trailing}
            depth={depth}
            mono={node.mono}
            hasKids={hasKids}
            expanded={open.includes(node.id)}
            onToggle={() => onToggle(node.id)}
            selected={selected === node.id}
            onPick={() => onPick(full)}
            menu={menuFor?.(full)}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- local prefs

/** useState persisted to localStorage (UI prefs only: widths, layouts). */
export function useLocalStorage<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw !== null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = React.useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const v = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* private mode: prefs stay in memory */
      }
      return v;
    });
  }, [key]);
  return [value, set];
}

// ---------------------------------------------------------------- KV table

export function KvTable({ rows }: { rows: Array<{ key: string; value: string }> }): React.JSX.Element {
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-border/50 last:border-0">
            <td className="py-1 pr-3 font-mono text-muted-foreground">{r.key}</td>
            <td className="py-1 text-right font-mono break-all">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
