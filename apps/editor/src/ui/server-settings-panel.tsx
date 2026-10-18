/**
 * Server settings panel (roadmap EG13, Live ops): the save cadence, the
 * snapshot history and the database query caps of
 * content/server/persistence.json as a form, validated on Save with the
 * server's own schema.
 */

import * as React from "react";
import { PERSISTENCE_SECTIONS } from "../server-settings.js";
import { ContentDocsPanel } from "./content-docs-panel.js";
import { FieldSection } from "./spec-form.js";

export function ServerSettingsPanel(): React.JSX.Element {
  return (
    <ContentDocsPanel
      note="Settings for the game server. Saving the world is read when the server starts; the query caps apply to the next query."
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
      ]}
    />
  );
}
