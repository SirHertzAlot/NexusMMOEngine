// Editor entry of the story module (roadmap EA13): the Story workspace's quest & dialog editor,
// contributed instead of hard-wired into the shell. (Complete-modularity: the read-only
// quest list and the strings grid joined as further contributed panels.)
import * as React from "react";
import { StoryEditorPanel } from "../../../apps/editor/src/ui/story-editor.js";
import { QuestsPanel } from "../../../apps/editor/src/ui/quests-live.js";
import { StringsPanel } from "../../../apps/editor/src/ui/strings-panel.js";

export const panels = [
  {
    id: "story.editor",
    workspace: "story",
    title: "Quest & dialog",
    icon: "account_tree",
    render: () => <StoryEditorPanel />,
  },
  {
    id: "quests",
    workspace: "story",
    title: "Quests",
    icon: "flag",
    render: () => <QuestsPanel />,
  },
  {
    id: "strings",
    workspace: "story",
    title: "Strings",
    icon: "translate",
    render: () => <StringsPanel />,
  },
];
