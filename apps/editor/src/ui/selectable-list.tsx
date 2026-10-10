/**
 * One selectable list for every library, outliner and navigation pane.
 *
 * A pane that shows rows, highlights the picked one and may offer a hover
 * menu per row was written by hand a dozen times, each with its own pill
 * styling. `SelectableList<T>` takes the rows and how to read them
 * (key, label, icon, trailing tag, second line, menu); the highlight,
 * focus ring, hover menu and accessibility attributes live here, so
 * changing the list once changes every pane.
 */

import * as React from "react";
import { MIcon, OverflowMenu, type MenuItem } from "./components.js";

export interface SelectableListProps<T> {
  items: readonly T[];
  itemKey: (item: T) => string;
  label: (item: T) => string;
  /** Key of the picked row (null / omitted: nothing picked). */
  selected?: string | null;
  onPick: (item: T) => void;
  /** Material icon name for a row (one name for all, or per row). */
  icon?: string | ((item: T) => string);
  /** Right-aligned text or element on the first line. */
  tag?: (item: T) => React.ReactNode;
  /** Second line under the label. */
  detail?: (item: T) => React.ReactNode;
  /** Hover ⋯ menu for a row. */
  menu?: (item: T) => Array<MenuItem | "sep">;
  /** Row height: sm 32px, md 36px, lg 40px. */
  size?: "sm" | "md" | "lg";
  mono?: boolean;
  /** Left indent in px for nested groups. */
  indent?: number;
  /** Marks the picked row `aria-current="page"` (navigation) instead of `aria-pressed`. */
  navigation?: boolean;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

const HEIGHT = { sm: "h-8", md: "h-9", lg: "h-10" } as const;
const ICON_SIZE = { sm: 15, md: 16, lg: 20 } as const;

export function SelectableList<T>(props: SelectableListProps<T>): React.JSX.Element {
  const { items, itemKey, label, selected, onPick, icon, tag, detail, menu, size = "md", mono = false, indent = 0, navigation = false } = props;
  return (
    <ul className={props.className ?? "flex flex-col gap-0.5"} aria-label={props.ariaLabel} data-testid={props.testId}>
      {items.map((item) => {
        const key = itemKey(item);
        const on = key === selected;
        const text = label(item);
        const name = typeof icon === "function" ? icon(item) : icon;
        return (
          <li
            key={key}
            className={`group flex items-center gap-0.5 ${detail ? "rounded-xl" : "rounded-full"}`}
            style={on ? { background: "var(--m3-secondary-container)" } : undefined}
          >
            <button
              onClick={() => onPick(item)}
              aria-current={navigation && on ? "page" : undefined}
              aria-pressed={navigation ? undefined : on}
              className={`m3-focus flex min-w-0 flex-1 items-center gap-2.5 text-left ${detail ? "flex-col items-stretch gap-0 rounded-xl px-2 py-1.5" : `${HEIGHT[size]} rounded-full px-3`} ${mono ? "font-mono text-xs" : "text-sm"}`}
              style={{ paddingLeft: indent ? 12 + indent : undefined, color: on ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)" }}
            >
              <span className={`flex min-w-0 items-center gap-2 ${detail ? "font-semibold" : "w-full"}`}>
                {name && <MIcon name={name} size={ICON_SIZE[size]} />}
                <span className="truncate">{text}</span>
                {tag && <span className="ml-auto flex-none text-xs" style={{ color: on ? undefined : "var(--m3-on-surface-variant)" }}>{tag(item)}</span>}
              </span>
              {detail && <span className="font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }}>{detail(item)}</span>}
            </button>
            {menu && (
              <span className="flex-none opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <OverflowMenu label={`${text} actions`} items={menu(item)} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
