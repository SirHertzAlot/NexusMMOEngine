/**
 * Browser connection helper for the editor inspectors.
 *
 * Wraps @mmo-engine/mirror's MirrorClient with the browser WebSocket
 * adapter. The editor never simulates — it mirrors the authoritative
 * server exactly like the game client does (skill operating rule 1).
 */

import { BrowserSocket, MirrorClient } from "@mmo-engine/mirror";
import type { HelloAuth } from "@mmo-engine/mirror";

export type EditorAuth = HelloAuth;

export async function connectMirror(
  url: string,
  clientName: string,
  auth: EditorAuth,
  onTick: () => void,
): Promise<MirrorClient> {
  const client = new MirrorClient((u) => new BrowserSocket(u), {
    onWelcome: () => {},
    onState: () => onTick(),
    onError: () => {},
    onClose: () => {},
  });
  await client.connect(url, clientName, auth);
  return client;
}
