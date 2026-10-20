/**
 * Server settings panel (Live ops): the save cadence, snapshot history
 * and database query caps of content/server/persistence.json (roadmap
 * EG13), and the day cycle and bots of world.json (EG14), as forms
 * validated on Save with the server's own schemas. The world seed, chunk
 * size and radii come with the bake and are shown, not edited.
 */

import * as React from "react";
import { PERSISTENCE_SECTIONS, WORLD_FIXED, WORLD_SECTIONS } from "../server-settings.js";
import { ContentDocsPanel } from "./content-docs-panel.js";
import { FieldSection } from "./spec-form.js";

export function ServerSettingsPanel(): React.JSX.Element {
  return (
    <ContentDocsPanel
      note="Settings for the game server, read when it starts (the query caps apply to the next query). Environment variables, when set, win over these."
      tabs={[
        {
          doc: "persistence",
          label: "Persistence",
          render: (f) => (
            <div className="flex flex-col gap-5">
              {PERSISTENCE_SECTIONS.map((s) => (
                <FieldSection key={s.title} title={s.title} help={s.help} fields={s.fields} basePath="" {...f.grid} />
              ))}
            </div>
          ),
        },
        {
          doc: "world",
          label: "World and time",
          render: (f) => (
            <div className="flex flex-col gap-5">
              {WORLD_SECTIONS.map((s) => (
                <FieldSection key={s.title} title={s.title} help={s.help} fields={s.fields} basePath="" {...f.grid} />
              ))}
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Fixed by the bake</h3>
                <p className="text-xs text-muted-foreground">These come with the baked world and can't change here.</p>
                <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1 text-sm">
                  {WORLD_FIXED.map((r) => (
                    <React.Fragment key={r.label}>
                      <dt className="text-muted-foreground">{r.label}</dt>
                      <dd>{r.where}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </section>
            </div>
          ),
        },
      ]}
    />
  );
}
