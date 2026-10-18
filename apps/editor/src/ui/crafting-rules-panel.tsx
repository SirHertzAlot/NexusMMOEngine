/**
 * Crafting rules panel (roadmap EG3, Gameplay › Crafting): units, fittings,
 * the fallback reagent, the rune stone and the craft skills from
 * content/crafting/recipes.json as a labelled form, validated on Save with
 * the crafting package's own check. Refining and reagents stay in the Data
 * grids; a save here replaces only this form's keys (content-docs-host.ts).
 */

import * as React from "react";
import { CRAFTING_ROWS, CRAFTING_SECTIONS } from "../crafting-rules.js";
import { loadGameplay } from "../gameplay-client.js";
import { ContentDocsPanel } from "./content-docs-panel.js";
import { FieldSection, RowsEditor } from "./spec-form.js";

/** The raw material ids the crafting package knows (for reagents and the rune stone). */
function useMaterials(): string[] {
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    let live = true;
    loadGameplay().then(
      (snap) => live && setIds(snap.context.options.materials),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return ids;
}

export function CraftingRulesPanel(): React.JSX.Element {
  const materials = useMaterials();
  return (
    <ContentDocsPanel
      note="The server reads these when it starts: restart play mode (or the server) to apply a saved change. Refining recipes and element reagents are in Data grids."
      lists={{ materials }}
      tabs={[
        {
          doc: "crafting",
          label: "Crafting rules",
          render: (f) => (
            <div className="flex flex-col gap-5">
              {CRAFTING_SECTIONS.map((s) => (
                <FieldSection key={s.title} title={s.title} help={s.help} fields={s.fields} basePath="" {...f.grid} />
              ))}
              {CRAFTING_ROWS.map((r) => (
                <RowsEditor key={r.under} under={r.under} title={r.title} help={r.help} noun={r.noun} fields={r.fields} newRow={r.newRow} {...f.grid} />
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}
