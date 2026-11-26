/**
 * The Blender live link (docs/BLENDER-LINK.md, slice EU10) — the last
 * of the functionality reference's dock tabs, and the one that had
 * nothing behind it at all.
 *
 * The reference draws "live link, auto-import on save, send selection,
 * a bridge add-on to copy". Ours is that, with the direction decided by
 * where the work happens: Blender pushes, the editor receives. The
 * add-on (`scripts/blender/mmo_live_link.py`) exports the selection to
 * glTF and POSTs it; the host writes it into `assets/live/`, which is
 * gitignored and served on loopback, so a designer's work in progress
 * can never be committed by accident.
 *
 * This panel is the receiving end: what has arrived, how long ago, how
 * big, and the newest one on screen through the editor's own
 * `ModelPreview`. With nothing yet, it is the install instructions,
 * because an empty panel that does not say how to fill itself is a
 * dead end.
 */

import * as React from "react";
import { blenderLink, type BlenderLink } from "../blender-client.js";
import { liveModelUrl, mb, sinceLabel, type LiveModel } from "../blender-link.js";
import { ModelPreview } from "./model-preview.js";

/** Poll: a push arrives from outside the browser, so there is nothing to subscribe to. */
export function useBlenderLink(read: () => Promise<BlenderLink> = blenderLink, periodMs = 4000): BlenderLink | null {
  const [link, setLink] = React.useState<BlenderLink | null>(null);
  React.useEffect(() => {
    let live = true;
    const tick = (): void => {
      read().then(
        (l) => live && setLink(l),
        () => live && setLink(null),
      );
    };
    tick();
    const t = setInterval(tick, periodMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [read, periodMs]);
  return link;
}

/** One line per model: what it is, and when it last came in. */
export function modelLine(model: LiveModel, now = Date.now()): string {
  const pushes = model.pushes > 1 ? ` · ${model.pushes} pushes` : "";
  const from = model.from === undefined ? "" : ` · ${model.from}`;
  return `${mb(model.bytes)} · ${sinceLabel(model.at, now)}${pushes}${from}`;
}

export function BlenderLinkView({
  link,
  now = Date.now(),
}: {
  link: BlenderLink | null;
  now?: number;
}): React.JSX.Element {
  const [selected, setSelected] = React.useState<string | null>(null);
  const models = link?.models ?? [];
  const shown = models.find((m) => m.name === selected) ?? models[0];

  return (
    <section className="fg-panel flex min-h-0 flex-col">
      <header className="flex items-baseline gap-3 p-3">
        <span className="fg-label">Blender live link</span>
        <span className="fg-data fg-dim">
          {link === null
            ? "dev host not serving /api/editor/blender"
            : models.length === 0
              ? "nothing received yet"
              : `${models.length} model${models.length === 1 ? "" : "s"} in ${link.dir}`}
        </span>
      </header>

      {models.length === 0 && (
        <div className="fg-data m3-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <p className="mb-2">To send a model from Blender:</p>
          <ol className="fg-dim ml-4 list-decimal space-y-1">
            <li>
              Blender → Edit → Preferences → Add-ons → Install…, pick{" "}
              <code>{link?.addon ?? "scripts/blender/mmo_live_link.py"}</code>, and tick it.
            </li>
            <li>In the 3D viewport press N, open the Nexus tab.</li>
            <li>Select the objects and press Send selection, or tick Send on save.</li>
          </ol>
          <p className="fg-dim mt-2">
            Models land in <code>{link?.dir ?? "assets/live"}</code>, which is gitignored and served
            locally — nothing sent this way can be committed.
          </p>
        </div>
      )}

      {shown !== undefined && (
        <div className="m3-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {/* ModelPreview sizes its own canvas and caption; a fixed box
              here would crop the model rather than fit it. */}
          <div className="mb-2">
            <ModelPreview url={liveModelUrl(shown.name, shown.at)} />
          </div>
          {models.map((m) => (
            <button
              key={m.name}
              type="button"
              className="m3-focus fg-row flex w-full items-baseline gap-2.5 px-2.5 py-2 text-left"
              aria-pressed={m.name === shown.name}
              onClick={() => setSelected(m.name)}
              style={m.name === shown.name ? undefined : { opacity: 0.7 }}
            >
              <span className="fg-data min-w-0 flex-1 truncate" style={{ color: "var(--fg-text)" }}>
                {m.name}
              </span>
              <span className="fg-data fg-dim">{modelLine(m, now)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function BlenderLinkPanel(): React.JSX.Element {
  return <BlenderLinkView link={useBlenderLink()} />;
}
