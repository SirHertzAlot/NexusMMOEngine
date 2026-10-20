/**
 * Merged selection modals — the one-modal-per-selection structure for the
 * viewport authoring layer (viewport-authoring cut, roadmap EA work).
 *
 * The selection-driven widget layer does not exist yet. This module
 * establishes the structure the widget phase will build on: exactly one
 * modal claims each selection kind (see SELECTION_MODALS below), and each
 * modal is a tab bar merging the modules relevant to that selection.
 *
 * Two pairs merged here:
 * - CharacterModal:  "Sheet"   (character module — future widget) +
 *                    "Records" (characters module's CharacterRecordPanel)
 * - QuestGiverModal: "Quests"   (quests module — future widget) +
 *                    "Dialogue" (story module's StoryEditorPanel)
 *
 * The future-widget tabs are honest placeholders: they name the owning
 * module and what its widget will show. No fake data — the `character`
 * (server systems: character/animation/mastery/stats) and `quests`
 * (server) modules have no editor UI today, and this file invents no
 * data paths for them.
 *
 * The existing module panel registrations (modules/characters/editor,
 * modules/story/editor) are untouched: these modals render the same
 * panels, they do not replace them.
 */

import * as React from "react";
import { EmptyState, MIcon } from "./components.js";
import { CharacterRecordPanel } from "./character-view.js";
import { StoryEditorPanel } from "./story-editor.js";
import { ShellDialog } from "./shell-dialogs.js";

// ---------------------------------------------------------------- ModalTabs

export interface ModalTab {
  id: string;
  label: string;
  icon?: string;
}

/**
 * Reusable modal tab bar. Follows the existing inline tab pattern
 * (animation-panel.tsx): m3 secondary-container pill for the active tab,
 * role="tablist" for accessibility. No tabs primitive exists in
 * components.tsx; this stays local to the merged modals so the widget
 * phase can lift it when the tabbed-inspector pattern grows.
 */
export function ModalTabs({
  tabs,
  active,
  onTab,
}: {
  tabs: ReadonlyArray<ModalTab>;
  active: string;
  onTab: (id: string) => void;
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Modal sections"
      className="mb-3 flex w-fit items-center overflow-hidden rounded-full text-sm"
      style={{ border: "1px solid var(--m3-outline-variant)" }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onTab(t.id)}
            className="m3-focus flex h-9 items-center gap-1.5 px-4"
            style={
              on
                ? {
                    background: "var(--m3-secondary-container)",
                    color: "var(--m3-on-secondary-container)",
                  }
                : { color: "var(--m3-on-surface)" }
            }
          >
            {t.icon && <MIcon name={t.icon} size={16} />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------- future-widget placeholder

/**
 * Honest stub for a tab whose widget does not exist yet. Names the owning
 * module and what the future widget will show; renders no invented data.
 */
export function FutureWidgetStub({
  module,
  shows,
}: {
  /** Owning module, e.g. "character" or "quests". */
  module: string;
  /** What the future widget will show, as a plain sentence. */
  shows: string;
}): React.JSX.Element {
  return (
    <EmptyState
      icon="construction"
      title={`${module} widget — not built yet`}
      body={`${shows} It will live here when the widget phase lands.`}
    />
  );
}

// ---------------------------------------------------------------- modals

export interface MergedModalProps {
  /** Title line of the dialog. Defaults to the selection kind's label. */
  title?: string;
  /**
   * Id of the selected object (character id, NPC id, …). Accepted and
   * reserved for the widget phase: today's panels take no props, so this
   * file wires nothing to it — deliberately, no invented data paths.
   */
  id?: string;
  onClose: () => void;
}

/** One selection of a character: Sheet (future) + Records (live). */
export function CharacterModal({ title, onClose }: MergedModalProps): React.JSX.Element {
  const [tab, setTab] = React.useState("sheet");
  return (
    <ShellDialog title={title ?? "Character"} onClose={onClose}>
      <ModalTabs
        tabs={[
          { id: "sheet", label: "Sheet", icon: "person" },
          { id: "records", label: "Records", icon: "folder_shared" },
        ]}
        active={tab}
        onTab={setTab}
      />
      {tab === "sheet" && (
        <FutureWidgetStub
          module="character"
          shows="The future sheet widget (character module) will show stats, mastery, and animation clip state for the selected character."
        />
      )}
      {tab === "records" && <CharacterRecordPanel />}
    </ShellDialog>
  );
}

/** One selection of a quest-giving NPC: Quests (future) + Dialogue (live). */
export function QuestGiverModal({ title, onClose }: MergedModalProps): React.JSX.Element {
  const [tab, setTab] = React.useState("quests");
  return (
    <ShellDialog title={title ?? "Quest giver"} onClose={onClose}>
      <ModalTabs
        tabs={[
          { id: "quests", label: "Quests", icon: "map" },
          { id: "dialogue", label: "Dialogue", icon: "forum" },
        ]}
        active={tab}
        onTab={setTab}
      />
      {tab === "quests" && (
        <FutureWidgetStub
          module="quests"
          shows="The future quest-list widget (quests module) will show the quests this NPC gives, with objectives and rewards."
        />
      )}
      {tab === "dialogue" && <StoryEditorPanel />}
    </ShellDialog>
  );
}

// ------------------------------------------------- selection-modal registry

/** Selection kinds with a claimed modal. Extend as the widget phase adds kinds. */
export type SelectionModalKind = "character" | "questGiver";

/**
 * Single-claim rule: one selection kind maps to exactly one modal, and a
 * modal is claimed by exactly one kind. The widget phase keeps this
 * invariant — when a future widget merges or splits modals, it edits this
 * registry, never the selection dispatch.
 */
export const SELECTION_MODALS: Record<
  SelectionModalKind,
  {
    /** The modal component rendered for this selection kind. */
    modal: React.ComponentType<MergedModalProps>;
    /** Human label for titles and error messages. */
    label: string;
  }
> = {
  character: { modal: CharacterModal, label: "Character" },
  questGiver: { modal: QuestGiverModal, label: "Quest giver" },
};
