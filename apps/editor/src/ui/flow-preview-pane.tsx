/**
 * The flow's preview pane (roadmap EB6): the screen a node leads to, beside
 * the graph that leads there.
 *
 * It is an iframe onto the client's own dev server — the same URL "Play
 * from" opened in a tab — so nothing about the client is reimplemented
 * here. The URL is shown masked, because it carries the dev account in its
 * query string, and the tab button stays, since a real session (devtools, a
 * second window, a pointer lock) still wants a window of its own.
 */

import * as React from "react";
import { PREVIEW_SIZES, frameStyle, previewSize, type PreviewTarget } from "../flow-preview.js";

export interface FlowPreviewPaneProps {
  target: PreviewTarget | null;
  /** Why there is nothing to show, when there is nothing to show. */
  note: string;
  sizeId: string;
  onSize(id: string): void;
  onOpenTab(): void;
}

export function FlowPreviewPane(props: FlowPreviewPaneProps): React.JSX.Element {
  const size = previewSize(props.sizeId);
  return (
    <section className="flex min-h-0 flex-col gap-1" aria-label="Screen preview" data-testid="flow-preview">
      <div className="flex flex-wrap items-center gap-1 text-[12px]">
        <strong>{props.target ? props.target.node : "Preview"}</strong>
        <span className="flex items-center gap-1">
          {PREVIEW_SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={s.id === size.id}
              data-testid={`preview-size-${s.id}`}
              onClick={() => props.onSize(s.id)}
              className="rounded px-1.5 py-0.5"
              style={{
                border: "1px solid var(--m3-outline-variant)",
                background: s.id === size.id ? "var(--m3-secondary-container)" : "transparent",
              }}
            >
              {s.label}
            </button>
          ))}
        </span>
        {props.target && (
          <button
            type="button"
            className="ml-auto rounded px-1.5 py-0.5"
            style={{ border: "1px solid var(--m3-outline-variant)" }}
            data-testid="preview-open-tab"
            onClick={props.onOpenTab}
          >
            Open in a tab
          </button>
        )}
      </div>
      {props.target && (
        <p className="truncate font-mono text-[11px]" style={{ color: "var(--m3-on-surface-variant)" }} title={props.target.shown}>
          {props.target.shown}
        </p>
      )}
      <div
        className="flex min-h-[360px] flex-1 items-center justify-center overflow-auto rounded-md border"
        style={{ borderColor: "var(--m3-outline-variant)", background: "#000" }}
      >
        {props.target ? (
          <iframe
            key={props.target.url}
            title={`Preview of ${props.target.node}`}
            src={props.target.url}
            style={frameStyle(size)}
            // The client needs scripts, its own origin and pointer lock to
            // run at all; this is a dev tool pointed at the person's own
            // dev server, and the sandbox says exactly that much.
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups"
            allow="fullscreen"
          />
        ) : (
          <p className="p-3 text-[12px]" style={{ color: "var(--m3-on-surface-variant)" }}>
            {props.note}
          </p>
        )}
      </div>
    </section>
  );
}
