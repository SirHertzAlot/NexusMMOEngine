// Editor entry of the story module (roadmap EA13): the Story workspace's quest & dialog editor,
// contributed instead of hard-wired into the shell.
import * as React from "react";
import { StoryEditorPanel } from "../../../apps/editor/src/ui/story-editor.js";

export const panels = [
  {
    id: "story.editor",
    workspace: "story",
    title: "Quest & dialog",
    icon: "account_tree",
    render: () => <StoryEditorPanel />,
  },
];
