/**
 * Character creation panel (roadmap EB7, Gameplay › Character creation):
 * the categories, colours and swatches a player is offered when making a
 * character, as `content/character-creation.json`.
 *
 * Three things read that file — the server when it checks a new
 * character, the client when it draws the screen, and this form — so a
 * game changes what a player may choose in one place instead of in a
 * denylist and two constants that had to agree.
 *
 * Most games have no such file, and that is not an empty document: it
 * means the engine's defaults. The panel says so, and offers to write
 * them out rather than quietly starting from nothing.
 */

import * as React from "react";
import { creationRulesDocument } from "@mmo-engine/art/browser";
import { CREATION_COLOUR_FIELDS, CREATION_FIELDS, CREATION_PART_FIELDS, creationSummary } from "../creation-rules.js";
import { Button } from "./components.js";
import { ContentDocsPanel } from "./content-docs-panel.js";
import { FieldSection, RowsEditor } from "./spec-form.js";

/** The swatch strip under a colour row, so a palette is seen rather than read. */
export function SwatchStrip({ colours }: { colours: readonly string[] }): React.JSX.Element | null {
  const valid = colours.filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  if (valid.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="swatch-strip">
      {valid.map((c, i) => (
        <span
          key={`${c}-${i}`}
          title={c}
          className="h-4 w-4 rounded-sm"
          style={{ background: c, border: "1px solid var(--m3-outline-variant)" }}
        />
      ))}
    </div>
  );
}

/** What a player will be offered, read back through the engine's own reader. */
export function CreationSummary({ content }: { content: unknown }): React.JSX.Element {
  const summary = creationSummary(content);
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="creation-summary">
      {summary.problems.length === 0 ? (
        summary.lines.map((line) => (
          <p key={line} style={{ color: "var(--m3-on-surface-variant)" }}>
            {line}
          </p>
        ))
      ) : (
        <p style={{ color: "var(--m3-error)" }}>The server would refuse this: {summary.problems.join("; ")}</p>
      )}
    </div>
  );
}

export function CreationRulesPanel(): React.JSX.Element {
  return (
    <ContentDocsPanel
      note="The server reads this when it starts, and the client when the character screen opens: restart play mode to apply a saved change. How many characters an account may hold is Social › Characters."
      tabs={[
        {
          doc: "characterCreation",
          label: "Character creation",
          render: (f) => {
            const empty = f.value === undefined || f.value === null;
            return (
              <div className="flex flex-col gap-5">
                {empty ? (
                  <section className="flex flex-col items-start gap-2 rounded-md border p-3" style={{ borderColor: "var(--m3-outline-variant)" }} data-testid="creation-no-file">
                    <p className="text-sm">
                      This game has no <code>content/character-creation.json</code>, so the engine&apos;s own choices apply: a face, hair, eyebrows, facial hair and ears, five
                      colours, and the starter armour on the body.
                    </p>
                    <p className="text-xs" style={{ color: "var(--m3-on-surface-variant)" }}>
                      Writing the file changes nothing by itself — it spells the defaults out so you can edit them.
                    </p>
                    <Button size="sm" variant="outline" onClick={() => f.onChange(creationRulesDocument())} data-testid="creation-write-defaults">
                      Start from the engine&apos;s defaults
                    </Button>
                  </section>
                ) : (
                  <>
                    <FieldSection
                      title="Who a new character may be"
                      help="What a player picks before anything else."
                      fields={CREATION_FIELDS}
                      basePath=""
                      {...f.grid}
                    />
                    <div className="flex flex-col gap-2">
                      <RowsEditor
                        under="parts"
                        title="Part categories"
                        help="One picker each, in this order. A slot that is not here cannot be set at creation — that is how armour attachments stay out. The head is always offered and never optional; an empty “offered to” means both genders."
                        noun="category"
                        fields={CREATION_PART_FIELDS}
                        newRow={() => ({ slot: "hair", optional: true })}
                        {...f.grid}
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <RowsEditor
                        under="colours"
                        title="Colours"
                        help="One swatch strip each, #rrggbb in the order they are shown; the colour picker beside them is always there. A colour that is not here cannot be set at creation."
                        noun="colour"
                        fields={CREATION_COLOUR_FIELDS}
                        newRow={() => ({ slot: "skin", optional: true, swatches: [] })}
                        {...f.grid}
                      />
                      {((f.value as { colours?: Array<{ slot?: string; swatches?: string[] }> }).colours ?? []).map((row, i) => (
                        <div key={i} className="flex items-center gap-2 pl-9 text-xs">
                          <span style={{ color: "var(--m3-on-surface-variant)" }}>{row.slot ?? "—"}</span>
                          <SwatchStrip colours={row.swatches ?? []} />
                        </div>
                      ))}
                    </div>
                    <CreationSummary content={f.value} />
                  </>
                )}
              </div>
            );
          },
        },
      ]}
    />
  );
}
