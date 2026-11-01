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
 * bindings. The renderer's numbers (fps, tick, position, the performance
 * samples) come back once a second through onHud; children draw over the
 * view (the debugger's panels, play-debugger.tsx), inside `containerRef`.
 * Maximized, the view covers the editor window.
 *
 * Toolbar tools: select is the camera/pick default here — the follow
 * camera owns orbit in every tool and a left click picks the target, so
 * the tool intentionally changes nothing in this view.
 */

import * as React from "react";
import type * as THREE from "three";
import type { MirrorClient } from "@mmo-engine/mirror";
import { getAllMedia } from "../media-client.js";
import { getContentDoc } from "../content-docs.js";
import {
  CombatFeedback,
  DEFAULT_BINDINGS,
  httpBaseForGameUrl,
  PcgRpcClient,
  PlaceholderAssets,
  WorldCanvas,
  applyGameContent,
  setParticleBudgets,
  type GpuInfo,
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
  /** Cover the editor window instead of sitting in the panel. */
  maximized?: boolean;
  onHud?: (hud: HudData) => void;
  /** Place-at-cursor (E4): a left click on bare ground reports its x/z. */
  onGroundPick?: (x: number, z: number) => void;
  onGpu?: (gpu: GpuInfo) => void;
  /** The world's three.js scene, once it exists (debug overlays draw into it). */
  onScene?: (scene: THREE.Scene) => void;
  onQuality?: (active: QualityTier, detected: QualityTier | null) => void;
  /** Hit feedback and the picked target (a left click on a body picks it); one is made when absent. */
  combat?: CombatFeedback;
  /** The view's frame, for what draws over it. */
  containerRef?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
  /** Camera view: "third" (follow) or "first" (eye-level). Uncontrolled by default (V toggles). */
  view?: "third" | "first";
  /** Fires when the view changes. */
  onViewChange?: (view: "third" | "first") => void;
}

export function GameView({
  client,
  url,
  lastStateAt,
  wireframe = false,
  showcase = false,
  quality = "auto",
  maximized = false,
  onHud,
  onGroundPick,
  onGpu,
  onScene,
  onQuality,
  combat: givenCombat,
  containerRef,
  children,
  view,
  onViewChange,
}: GameViewProps): React.JSX.Element {
  const [assets] = React.useState(() => new PlaceholderAssets());
  const [ownCombat] = React.useState(() => new CombatFeedback());
  const combat = givenCombat ?? ownCombat;
  // The animation-side content (combat moves, locomotion graph, materials) is applied before the world is built.
  const [contentReady, setContentReady] = React.useState(false);
  React.useEffect(() => {
    getAllMedia()
      .then((c) => void applyGameContent(c))
      .catch((e: unknown) => console.warn(`[editor] game content: ${e instanceof Error ? e.message : String(e)}`))
      .then(() => getContentDoc("vfxBudgets"))
      .then((b) => {
        const problem = setParticleBudgets(b);
        if (problem) console.warn(`[editor] ${problem}`);
      })
      .catch((e: unknown) => console.warn(`[editor] particle budgets: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setContentReady(true));
  }, []);
  const pcg = React.useMemo(
    () => new PcgRpcClient(httpBaseForGameUrl(url), () => client.sessionToken),
    [client, url],
  );
  return (
    <div
      ref={containerRef}
      className={
        maximized
          ? "fixed inset-0 z-40 overflow-hidden bg-black"
          : "relative h-[60vh] min-h-[360px] w-full overflow-hidden rounded-md border border-border bg-black"
      }
      data-testid="game-view"
    >
      {contentReady && <WorldCanvas
        client={client}
        assets={assets}
        pcg={pcg}
        lastStateAt={lastStateAt}
        wireframe={wireframe}
        captureFrames
        showcase={showcase}
        bindings={DEFAULT_BINDINGS}
        quality={quality}
        combat={combat}
        onHud={onHud}
        onGroundPick={onGroundPick}
        onGpu={onGpu}
        onScene={onScene}
        onQuality={onQuality}
        view={view}
        onViewChange={onViewChange}
      />}
      {children}
    </div>
  );
}
