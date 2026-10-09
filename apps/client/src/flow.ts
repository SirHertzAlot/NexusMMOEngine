/**
 * The client's game flow (roadmap EA7): the state machine of
 * `content/flow/game.flow.json` (run by `flowStep` from @mmo-engine/scene)
 * replaces the old hard-coded `Screen` state. Each flow node's scene names
 * a frontend screen; `screenOf` maps it to the component App mounts.
 */
import { useCallback, useRef, useState } from "react";
import { ASSIGNED_SCENE, flowStep, type FlowDoc } from "@mmo-engine/scene";

export type Screen = "login" | "connecting" | "characters" | "world";

/** The screen a flow node mounts. A scene the client has no screen for falls back to login. */
export function screenOf(doc: FlowDoc, node: string): Screen {
  switch (doc.nodes[node]?.scene) {
    case "loading":
      return "connecting";
    case "character-select":
    case "character-creation":
      return "characters";
    case ASSIGNED_SCENE:
      return "world";
    default:
      return "login";
  }
}

/** `?start=<node>` (the editor's Play from) when it names a node; the document's start otherwise. */
export function startNode(doc: FlowDoc, search: string): string {
  const s = new URLSearchParams(search).get("start");
  return s && s in doc.nodes ? s : doc.start;
}

/** The flow as React state. `fire` applies an event synchronously (a ref), so a handler can fire several in a row. */
export function useFlow(doc: FlowDoc, initial: string): { node: string; screen: Screen; fire: (event: string) => void } {
  const [node, setNode] = useState(initial);
  const ref = useRef(node);
  const fire = useCallback(
    (event: string): void => {
      const next = flowStep(doc, ref.current, event);
      ref.current = next;
      setNode(next);
    },
    [doc],
  );
  return { node, screen: screenOf(doc, node), fire };
}
