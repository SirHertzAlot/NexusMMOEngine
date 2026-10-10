/** Left-dock list of a workspace's own views (Live ops, Network). */
import * as React from "react";
import { MIcon } from "./components.js";

export function ViewList({ views, view, onView, hint }: {
  views: Array<{ id: string; label: string; icon: string }>;
  view: string;
  onView: (v: string) => void;
  hint: string;
}): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5">
      {views.map((v) => {
        const on = v.id === view;
        return (
          <li key={v.id}>
            <button
              onClick={() => onView(v.id)}
              aria-current={on ? "page" : undefined}
              className="m3-focus flex h-10 w-full items-center gap-3 rounded-full px-3 text-sm"
              style={on ? { background: "var(--m3-secondary-container)", color: "var(--m3-on-secondary-container)" } : { color: "var(--m3-on-surface)" }}
            >
              <MIcon name={v.icon} size={20} />
              {v.label}
            </button>
          </li>
        );
      })}
      <li className="mt-2 px-3 text-xs leading-relaxed" style={{ color: "var(--m3-on-surface-variant)" }}>{hint}</li>
    </ul>
  );
}
