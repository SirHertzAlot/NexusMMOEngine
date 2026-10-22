/**
 * VFX budgets panel (roadmap EG10, Art & audio): the particle tier budgets
 * of content/vfx/budgets.json as a form, validated on Save with the art
 * package's schema (a higher tier never gets fewer particles than a lower
 * one). The game client reads the file when it loads.
 */

import * as React from "react";
import { VFX_BUDGET_SECTIONS } from "../vfx-budgets.js";
import { ContentDocsPanel } from "./content-docs-panel.js";
import { FieldSection } from "./spec-form.js";

export function VfxBudgetsPanel(): React.JSX.Element {
  return (
    <ContentDocsPanel
      note="The game client reads these when it loads: reload the game to apply a saved change. A higher tier needs at least as many particles as the tier below it."
      tabs={[
        {
          doc: "vfxBudgets",
          label: "Particle budgets",
          render: (f) => (
            <div className="flex flex-col gap-5">
              {VFX_BUDGET_SECTIONS.map((s) => (
                <FieldSection key={s.title} title={s.title} help={s.help} fields={s.fields} basePath="" {...f.grid} />
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}
