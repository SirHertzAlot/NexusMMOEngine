/**
 * What the Animation view shares between its panel, the left library and the
 * Details pane: the open tab, the selected clip and move, the lists the
 * panel publishes (so the library shows the real clips and moves), and the
 * facts about the selection.
 */
import * as React from "react";
import { createStore } from "../store.js";

export type AnimationTab = "clipmap" | "clips" | "locomotion" | "combat";

export interface Detail {
  title: string;
  rows: Array<[string, string]>;
  note?: string;
}

export interface AnimationState {
  tab: AnimationTab;
  clip: string;
  move: number;
  /** Clip names the library lists: the rig's, else the ones the graph and the moves play. */
  clips: string[];
  moves: Array<[number, string]>;
  detail: Detail;
}

export const animationStore = createStore<AnimationState>({
  tab: "clipmap",
  clip: "",
  move: 0,
  clips: [],
  moves: [],
  detail: { title: "", rows: [] },
});

/** Publish the lists the left library shows (when they change). */
export function usePublishLists(clips: string[], moves: Array<[number, string]>): void {
  const key = JSON.stringify([clips, moves]);
  React.useEffect(() => {
    animationStore.set((p) => ({ ...p, clips, moves }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** Publish the Details pane's content for the current selection. */
export function useDetail(detail: Detail): void {
  const key = JSON.stringify(detail);
  React.useEffect(() => {
    animationStore.set((p) => ({ ...p, detail }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
