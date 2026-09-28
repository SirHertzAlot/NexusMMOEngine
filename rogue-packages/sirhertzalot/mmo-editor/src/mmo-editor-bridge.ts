/**
 * MmoEditorBridge — public-API bridge between a Rogue Engine scene and
 * the standalone MMO Engine editor companion.
 *
 * What it does:
 * - Attaches to any Object3D in a Rogue scene. Its inspector props
 *   (via @RE.props decorators) configure the companion URL and behavior.
 * - Hooks the public SceneController lifecycle (onPlay / onStop) and
 *   announces play-state over a BroadcastChannel ("mmo-editor-bridge"),
 *   so the standalone editor companion — running in the same browser
 *   (separate tab or iframe) — can reflect Rogue play state, show its
 *   own ECS inspector, or drive play mode against the same server.
 * - A one-click "Open MMO Editor" button prop opens the companion.
 *
 * What it deliberately does NOT do:
 * - It never touches Rogue editor internals, private dock panels, or
 *   undocumented editor APIs. Only RE.Component, RE.props decorators,
 *   RE.registerComponent, SceneController.onPlay/onStop, and the
 *   public App accessor are used (see COMPATIBILITY.md).
 *
 * Channel protocol (JSON, all fields optional except `type`):
 *   { type: "mmo-editor:play",  scene: string, at: number }
 *   { type: "mmo-editor:stop",  scene: string, at: number }
 *   { type: "mmo-editor:hello", from: "rogue-bridge", scene: string }
 * The companion answers "hello" with its own hello so either side can
 * discover the other regardless of start order.
 */

import * as RE from "rogue-engine";
import { App } from "rogue-engine";

export const BRIDGE_CHANNEL = "mmo-editor-bridge";

export class MmoEditorBridge extends RE.Component {
  @RE.props.group("MMO Editor Bridge", true)

  @RE.props.text()
  editorUrl: string = "http://localhost:5174";

  @RE.props.checkbox()
  autoOpenOnPlay: boolean = false;

  @RE.props.checkbox()
  announcePlayState: boolean = true;

  @RE.props.button()
  openEditor = (): void => {
    window.open(this.editorUrl, "_blank", "noopener");
  };
  openEditorLabel = "Open MMO Editor";

  private channel: BroadcastChannel | null = null;
  private stopPlayHook: (() => void) | null = null;
  private stopStopHook: (() => void) | null = null;

  /** Engine calls this; never call it directly. */
  awake(): void {
    if (typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel(BRIDGE_CHANNEL);
    this.channel.onmessage = (ev: MessageEvent): void => {
      const msg = ev.data as { type?: string } | null;
      if (msg && msg.type === "mmo-editor:hello") this.sayHello();
    };

    const controller = App.sceneController;
    if (!controller) return;
    // onPlay/onStop are public SceneController events; each returns a
    // { stop } handle we release in onDisabled().
    this.stopPlayHook = controller.onPlay(() => this.onRoguePlay()).stop;
    this.stopStopHook = controller.onStop(() => this.onRogueStop()).stop;
    this.sayHello();
  }

  /** Engine calls this when the component is disabled; never call directly. */
  onDisabled(): void {
    this.release();
  }

  private release(): void {
    try {
      this.stopPlayHook?.();
    } catch {
      /* already released */
    }
    try {
      this.stopStopHook?.();
    } catch {
      /* already released */
    }
    this.stopPlayHook = null;
    this.stopStopHook = null;
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
  }

  private sceneName(): string {
    try {
      return App.currentScene?.name ?? "(unnamed scene)";
    } catch {
      return "(unknown scene)";
    }
  }

  private post(message: Record<string, unknown>): void {
    if (!this.announcePlayState) return;
    try {
      this.channel?.postMessage(message);
    } catch {
      /* companion not listening — fine */
    }
  }

  private sayHello(): void {
    this.post({ type: "mmo-editor:hello", from: "rogue-bridge", scene: this.sceneName() });
  }

  private onRoguePlay(): void {
    if (this.autoOpenOnPlay) this.openEditor();
    this.post({ type: "mmo-editor:play", scene: this.sceneName(), at: Date.now() });
  }

  private onRogueStop(): void {
    this.post({ type: "mmo-editor:stop", scene: this.sceneName(), at: Date.now() });
  }
}

RE.registerComponent(MmoEditorBridge);
