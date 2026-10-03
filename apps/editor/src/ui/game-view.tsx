/**
 * Game view (ROADMAP E4) — the world renderer embedded in play mode.
 *
 * The same WorldCanvas the game client draws (`@mmo-engine/client/render`,
 * apps/client/src/render), fed by play mode's mirror client: streamed
 * terrain, water, sky, entities, input and the follow camera. The editor
 * owns only the frame around it; the canvas holds no editor logic, so
 * whatever the player sees is what play mode shows.
 *
 * Click into the view to drive the avatar with the client's default key
 * bindings. The renderer's numbers (fps, tick, position) come back once a
 * second through onHud for the panels around the view.
 */

import * as React from "react";
import type { MirrorClient } from "@mmo-engine/mirror";
import {
  CombatFeedback,
  DEFAULT_BINDINGS,
  httpBaseForGameUrl,
  PcgRpcClient,
  PlaceholderAssets,
  WorldCanvas,
  type HudData,
  type QualityTier,
} from "@mmo-engine/client/render";

export interface GameViewProps {
  client: MirrorClient;
  /** The play server's WebSocket URL (the Pcg service shares its port). */
  url: string;
  /** performance.now() of the last snapshot or delta. */
  lastStateAt: () => number;
  wireframe?: boolean;
  showcase?: boolean;
  quality?: "auto" | QualityTier;
  onHud?: (hud: HudData) => void;
}

export function GameView({
  client,
  url,
  lastStateAt,
  wireframe = false,
  showcase = false,
  quality = "auto",
  onHud,
}: GameViewProps): React.JSX.Element {
  const [assets] = React.useState(() => new PlaceholderAssets());
  const [combat] = React.useState(() => new CombatFeedback());
  const pcg = React.useMemo(
    () => new PcgRpcClient(httpBaseForGameUrl(url), () => client.sessionToken),
    [client, url],
  );
  return (
    <div
      className="relative h-[60vh] min-h-[360px] w-full overflow-hidden rounded-md border border-border bg-black"
      data-testid="game-view"
    >
      <WorldCanvas
        client={client}
        assets={assets}
        pcg={pcg}
        lastStateAt={lastStateAt}
        wireframe={wireframe}
        showcase={showcase}
        bindings={DEFAULT_BINDINGS}
        quality={quality}
        combat={combat}
        onHud={onHud}
      />
    </div>
  );
}
