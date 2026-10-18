/**
 * Dungeon runs panel (roadmap EG1, Dungeons & PCG › Runs): the run rules
 * (content/dungeons/instances.json) and the open-world entrances
 * (entrances.json) as labelled forms, validated on Save with the server's
 * own schemas (engine-core dungeons/content.ts).
 */

import * as React from "react";
import { ENTRANCE_FIELDS, ENTRANCE_ID, RUN_SECTIONS, newEntrance } from "../dungeon-rules.js";
import { createRulesControl, getAt } from "../rules-control.js";
import { ContentDocsPanel } from "./content-docs-panel.js";
import { FieldSection, RecordEditor } from "./spec-form.js";

const rules = createRulesControl();

/** The creature ids content/rules/creatures.json defines (for the fallback creature). */
function useCreatureIds(): string[] {
  const [ids, setIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    let live = true;
    rules.load().then(
      (snap) => live && setIds(Object.keys((getAt(snap.tables.creatures, "creatures") as Record<string, unknown> | undefined) ?? {})),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return ids;
}

export function DungeonRulesPanel(): React.JSX.Element {
  const creatures = useCreatureIds();
  return (
    <ContentDocsPanel
      note="The server reads these when it starts: restart play mode (or the server) to apply a saved change."
      lists={{ creatures }}
      tabs={[
        {
          doc: "instances",
          label: "Run rules",
          render: (f) => (
            <div className="flex flex-col gap-5">
              {RUN_SECTIONS.map((s) => (
                <FieldSection key={s.title} title={s.title} help={s.help} fields={s.fields} basePath="" {...f.grid} />
              ))}
            </div>
          ),
        },
        {
          doc: "entrances",
          label: "Entrances",
          render: (f) => (
            <RecordEditor under="entrances" noun="entrance" fields={ENTRANCE_FIELDS} newEntry={newEntrance} idRule={ENTRANCE_ID} {...f.grid} />
          ),
        },
      ]}
    />
  );
}
