/**
 * MirrorClient — the browser-side protocol driver (docs/MESSAGE-CATALOG.md).
 *
 * Flow: connect → hello (credentials or session token) → welcome +
 * snapshot → per-tick deltas → intents upstream. A game client that lets
 * the player choose a character uses join() instead: hello answers with
 * the account's characters, then createCharacter() / enterWorld()
 * (docs/MESSAGE-CATALOG.md §0x0c–0x0e) lead to the same welcome. It owns the
 * MirrorState and Interpolator but performs no simulation itself:
 * the browser mirrors; the server simulates (skill operating rule 1).
 *
 * The socket is injected (SocketLike), so this class is fully
 * unit-testable in Node with a fake socket.
 */

import {
  decodeControl,
  decodeDelta,
  decodeEnvelope,
  decodeSnapshot,
  encodeControl,
  encodeEnvelope,
  encodeIntentMessage,
  MessageType,
  PROTOCOL_VERSION,
  type AccountMessage,
  type AdminCommand,
  type AdminResult,
  type ChatBroadcast,
  type ChatChannel,
  type FriendMessage,
  type FriendsState,
  type GuildMessage,
  type PartyMessage,
  type PartyState,
  type GuildState,
  type CreateCharacterMessage,
  type DebugQuery,
  type DebugResponse,
  type DropsMessage,
  type InventoryMessage,
  type ErrorMessage,
  type HelloMessage,
  type BodyMessage,
  type HitMessage,
  type LifeMessage,
  type IntentFields,
  type NamesMessage,
  type RegisterMessage,
  type StatsMessage,
  type WelcomeMessage,
  type DayClock,
  type WireLook,
  type WorldInfo,
} from "@mmo-engine/protocol";
import { Interpolator } from "./interpolate.js";
import { MirrorState } from "./state.js";
import type { SocketLike } from "./socket.js";

export type HelloAuth =
  | { username: string; password: string }
  | { token: string };

/** How join() logs in: an existing account (or session token), or a new account. */
export type JoinAuth = HelloAuth | { register: { username: string; password: string } };

/**
 * The server's answer to a join: the account's characters to choose from,
 * or the welcome (a reconnect that re-enters as its character).
 */
export type JoinReply =
  | { kind: "account"; account: AccountMessage }
  | { kind: "welcome"; welcome: WelcomeMessage };

export interface MirrorEvents {
  onWelcome(w: WelcomeMessage): void;
  /** Fired after a snapshot or delta is applied (tick = authoritative tick). */
  onState(tick: number): void;
  onError(e: ErrorMessage): void;
  onClose(): void;
  /** The player's own stats changed (also on joining). */
  onStats?(s: StatsMessage): void;
  /** A region chat line arrived (roadmap U6, protocol 0x11). */
  onChat?(c: ChatBroadcast): void;
  /** The player's party changed, or an invite arrived (roadmap S3). */
  onParty?(p: PartyState): void;
  onGuild?(g: GuildState): void;
  onFriends?(f: FriendsState): void;
  /** The player's bag changed (also on joining; roadmap M3a, protocol 0x14). */
  onInventory?(inv: InventoryMessage): void;
  /** A blow landed, was blocked or dodged (roadmap M2a/U12a, protocol 0x16). */
  onHit?(h: HitMessage): void;
  /** An entity died or came back (roadmap M2b/U12a, protocol 0x17). */
  onLife?(l: LifeMessage): void;
  /** The player's own body parts, injuries and blood changed (also on joining; roadmap M2, protocol 0x18). */
  onBody?(b: BodyMessage): void;
}

const CONNECT_TIMEOUT_MS = 8000;

/** Held-back intents kept at most (a burst of presses; older changes collapse). */
const MAX_PENDING_INTENTS = 4;

/** Whether `next` lets go of a press (jump, a button) that `held` carries. */
function releasesPress(held: IntentFields, next: IntentFields): boolean {
  return (held.jump && !next.jump) || (held.buttons & ~next.buttons) !== 0;
}

export class MirrorClient {
  readonly state = new MirrorState();
  readonly interpolator = new Interpolator();

  playerEntity: bigint | null = null;
  sessionToken: string | null = null;
  serverTick = 0;
  tickHz = 30;
  /** A baked world's extent and coarse map, from the welcome; null for legacy worlds. */
  world: WorldInfo | null = null;
  /** The world's day clock, from the welcome; null when the server runs no day cycle. */
  day: DayClock | null = null;
  lastError: ErrorMessage | null = null;
  closed = false;
  /** The account's characters, from the last account message (join()). */
  account: AccountMessage | null = null;
  /** The player's own attributes and stats, from the last stats message; null until one arrives. */
  stats: StatsMessage | null = null;
  /** The player's own body (parts, injuries, blood), from the last body message; null until one arrives. */
  body: BodyMessage | null = null;
  /**
   * Character names by entity wire id, from the names control message
   * (C3). Pruned as entities despawn; the entity layer reads it for
   * nameplates. A guilded character reads "Name <TAG>" (S4).
   */
  readonly names = new Map<bigint, string>();
  /**
   * What ground items are, by entity wire id, from the drops message
   * (M3a, 0x15): name, rank, and the rank's colour. Pruned as entities
   * despawn, like names.
   */
  readonly drops = new Map<bigint, { name: string; rank: string; color: string }>();
  /** The player's bag, from the last inventory message; null until one arrives. */
  inventory: InventoryMessage | null = null;
  /** Bytes and messages received and sent on this client's sockets, since it was made (the HUD's network rates). */
  readonly traffic = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0 };

  private socket: SocketLike | null = null;
  /** Server tick the last intent was sent at (-1: none on this connection). */
  private intentSentAt = -1;
  /** Intents held back for the next authoritative ticks, oldest first (one goes per tick). */
  private pendingIntents: IntentFields[] = [];
  /** The outstanding request's answer (hello, register, create, enter): one at a time. */
  private replyResolve: ((r: JoinReply) => void) | null = null;
  private replyReject: ((e: Error) => void) | null = null;
  private debugResolve: ((r: DebugResponse) => void) | null = null;
  private debugReject: ((e: Error) => void) | null = null;
  private adminResolve: ((r: AdminResult) => void) | null = null;
  private adminReject: ((e: Error) => void) | null = null;

  constructor(
    private readonly createSocket: (url: string) => SocketLike,
    private readonly events: MirrorEvents,
  ) {}

  /**
   * Open the socket, send hello, and resolve with the welcome. Rejects
   * when the server answers with an error, closes, or times out.
   */
  async connect(
    url: string,
    clientName: string,
    auth: HelloAuth,
  ): Promise<WelcomeMessage> {
    const hello: HelloMessage = {
      protocol: PROTOCOL_VERSION,
      client: clientName,
      want_snapshot: true,
      ...auth,
    };
    return this.welcomeOf(this.openAndHandshake(url, MessageType.Hello, hello));
  }

  /**
   * Log in (or create the account) and choose a character before
   * entering the world: resolves with the account's characters — or with
   * the welcome, when a session token re-enters as its character. Then
   * createCharacter() and enterWorld().
   */
  async join(url: string, clientName: string, auth: JoinAuth): Promise<JoinReply> {
    if ("register" in auth) {
      const payload: RegisterMessage = {
        protocol: PROTOCOL_VERSION,
        client: clientName,
        ...auth.register,
        characters: true,
      };
      return this.openAndHandshake(url, MessageType.Register, payload);
    }
    const hello: HelloMessage = {
      protocol: PROTOCOL_VERSION,
      client: clientName,
      want_snapshot: true,
      ...auth,
      characters: true,
    };
    return this.openAndHandshake(url, MessageType.Hello, hello);
  }

  /**
   * Create a character (while choosing, after join()): resolves with the
   * updated account (`created` is the new one's id); rejects with the
   * server's reason (a taken name, a refused look) — the connection stays
   * open for another try.
   */
  async createCharacter(name: string, look: WireLook): Promise<AccountMessage> {
    const msg: CreateCharacterMessage = { name, look };
    const reply = await this.request(MessageType.CreateCharacter, encodeControl(msg));
    if (reply.kind !== "account") throw new Error("mirror-client: expected the account");
    return reply.account;
  }

  /** Enter the world as one of the account's characters: resolves with the welcome. */
  async enterWorld(character: number): Promise<WelcomeMessage> {
    return this.welcomeOf(this.request(MessageType.EnterWorld, encodeControl({ character })));
  }

  /**
   * Send a region chat line (roadmap U6, protocol 0x11). Fire-and-forget:
   * broadcasts have no reply; rejections arrive as ErrorMessage through
   * onError. The server trims, filters, and rate-limits.
   */
  /** Ask to pick a ground item up (M3a, 0x13); the server answers with the bag, or a 4005 refusal. */
  pickup(entity: bigint): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Item, encodeControl({ kind: "item", action: "pickup", entity: entity.toString() })));
  }

  /** Ask to drop an item from the bag at the player's feet (M3a, 0x13). */
  dropItem(item: number): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Item, encodeControl({ kind: "item", action: "drop", item })));
  }

  /** Ask to hold a bag item (M3b, 0x13); swaps with what the hand held. */
  equip(item: number): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Item, encodeControl({ kind: "item", action: "equip", item })));
  }

  /** Ask to put what a hand holds back in the bag (M3b, 0x13). */
  unequip(hand: "main" | "off"): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Item, encodeControl({ kind: "item", action: "unequip", hand })));
  }

  chat(channel: ChatChannel, text: string, to?: string): void {
    if (!this.socket || this.closed) return;
    const m = to === undefined ? { kind: "chat", channel, text } : { kind: "chat", channel, text, to };
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(m)));
  }

  /** A party op (S3): invite, kick and promote name a character. */
  party(op: PartyMessage["op"], name?: string): void {
    if (!this.socket || this.closed) return;
    const m: PartyMessage = name === undefined ? { kind: "party", op } : { kind: "party", op, name };
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(m)));
  }

  /** Add or remove a friend by character name (S2b). */
  friend(name: string, on: boolean): void {
    if (!this.socket || this.closed) return;
    const m: FriendMessage = { kind: "friend", name, on };
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(m)));
  }

  /** A guild op (S4): create takes name and tag, invite/kick/setRank a character, motd text. */
  guild(op: GuildMessage["op"], f: { name?: string; tag?: string; rank?: GuildMessage["rank"]; text?: string } = {}): void {
    if (!this.socket || this.closed) return;
    const m: GuildMessage = { kind: "guild", op };
    if (f.name !== undefined) m.name = f.name;
    if (f.tag !== undefined) m.tag = f.tag;
    if (f.rank !== undefined) m.rank = f.rank;
    if (f.text !== undefined) m.text = f.text;
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(m)));
  }

  /** Block or unblock a character by name (S2). */
  block(name: string, on: boolean): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl({ kind: "block", name, on })));
  }

  private async welcomeOf(reply: Promise<JoinReply>): Promise<WelcomeMessage> {
    const r = await reply;
    if (r.kind !== "welcome") throw new Error("mirror-client: expected a welcome");
    return r.welcome;
  }

  /** Send one request on the open socket and wait for its reply. */
  private request(type: MessageType, payload: Uint8Array): Promise<JoinReply> {
    if (!this.socket || this.closed) return Promise.reject(new Error("mirror-client: not connected"));
    if (this.replyResolve) return Promise.reject(new Error("mirror-client: a request is already in flight"));
    const reply = this.awaitReply();
    this.send(this.socket, encodeEnvelope(type, payload));
    return reply;
  }

  private awaitReply(): Promise<JoinReply> {
    return new Promise<JoinReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replyResolve = null;
        this.replyReject = null;
        reject(new Error("mirror-client: welcome timeout"));
      }, CONNECT_TIMEOUT_MS);
      this.replyResolve = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.replyReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  /** Settle the outstanding request. */
  private settle(result: JoinReply | Error): void {
    const resolve = this.replyResolve;
    const reject = this.replyReject;
    this.replyResolve = null;
    this.replyReject = null;
    if (result instanceof Error) reject?.(result);
    else resolve?.(result);
  }

  /**
   * Create an account, then join exactly like a credentials hello: the
   * server answers with the normal welcome + snapshot. Rejects when the
   * server answers with an error (e.g. username taken), closes, or
   * times out.
   */
  async register(
    url: string,
    clientName: string,
    username: string,
    password: string,
  ): Promise<WelcomeMessage> {
    const payload: RegisterMessage = {
      protocol: PROTOCOL_VERSION,
      client: clientName,
      username,
      password,
    };
    return this.welcomeOf(this.openAndHandshake(url, MessageType.Register, payload));
  }

  /**
   * Shared socket-open + first-message handshake for connect()/register().
   * The server's reply path (welcome / error / close) is identical for
   * both, so the plumbing lives here once.
   */
  private async openAndHandshake(
    url: string,
    type: MessageType.Hello | MessageType.Register,
    payload: HelloMessage | RegisterMessage,
  ): Promise<JoinReply> {
    if (this.socket) throw new Error("mirror-client: already connected");
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.onmessage = (data) => this.onMessage(data);

    await new Promise<void>((resolve, reject) => {
      const fail = (reason: string): void => {
        clearTimeout(timer);
        reject(new Error(`mirror-client: ${reason}`));
      };
      const unreachable = `could not connect to ${url} (is the server running?)`;
      const timer = setTimeout(() => {
        fail(`no response from ${url} within ${CONNECT_TIMEOUT_MS / 1000}s`);
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      // Before open, an error or close means the server was never reached
      // (refused, wrong URL, not running): fail now with a clear reason
      // instead of silently waiting out the timer.
      socket.onerror = () => fail(unreachable);
      socket.onclose = () => {
        fail(unreachable);
        this.onClose();
      };
    });
    socket.onclose = () => this.onClose();
    socket.onerror = (err) => this.onSocketError(err);

    const reply = this.awaitReply();
    this.send(socket, encodeEnvelope(type, encodeControl(payload)));
    return reply;
  }

  /**
   * Send one PlayerIntent upstream for the local player entity
   * (docs/MESSAGE-CATALOG.md §0x05, EDA: intents in as events).
   * client_tick = the last authoritative tick seen, and the server takes
   * at most one intent per tick (a second at the same tick is dropped as
   * stale). Input changes faster than that — the render loop runs at 60+
   * Hz — so a second call in the same tick is held and sent, newest
   * wins, when the next tick arrives. Otherwise a quick press-and-release
   * would lose the release and the player would keep running.
   *
   * Newest wins except over a held press (jump, a button) the newer
   * intent lets go of: the server acts on presses, so that one keeps its
   * place and the newer intent queues behind it, a tick later.
   */
  sendIntent(intent: IntentFields): void {
    if (!this.socket || this.playerEntity == null) return;
    const q = this.pendingIntents;
    if (this.serverTick <= this.intentSentAt || q.length > 0) {
      const last = q[q.length - 1];
      if (last !== undefined && !releasesPress(last, intent)) q[q.length - 1] = intent;
      else if (q.length < MAX_PENDING_INTENTS) q.push(intent);
      else q[q.length - 1] = intent;
      if (this.serverTick > this.intentSentAt) this.flushIntent();
      return;
    }
    this.transmitIntent(intent);
  }

  private transmitIntent(intent: IntentFields): void {
    if (!this.socket || this.playerEntity == null) return;
    this.intentSentAt = this.serverTick;
    const payload = encodeIntentMessage(
      BigInt(this.serverTick),
      this.playerEntity,
      intent,
    );
    this.send(this.socket, encodeEnvelope(MessageType.Intent, payload));
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.debugReject?.(new Error("mirror-client: disconnected"));
    this.debugResolve = null;
    this.debugReject = null;
    this.adminReject?.(new Error("mirror-client: disconnected"));
    this.adminResolve = null;
    this.adminReject = null;
  }

  /**
   * Editor-only read-only debug query (docs/MESSAGE-CATALOG.md §0x0a).
   * One outstanding query at a time (editor overlays poll at low
   * frequency); the promise resolves with the server's DebugResponse
   * or rejects on error/disconnect/timeout.
   */
  debug(query: DebugQuery): Promise<DebugResponse> {
    if (!this.socket || this.closed) {
      return Promise.reject(new Error("mirror-client: not connected"));
    }
    if (this.debugResolve) {
      return Promise.reject(
        new Error("mirror-client: debug query already in flight"),
      );
    }
    const promise = new Promise<DebugResponse>((resolve, reject) => {
      this.debugResolve = resolve;
      this.debugReject = reject;
      setTimeout(() => {
        if (this.debugReject === reject) {
          this.debugResolve = null;
          this.debugReject = null;
          reject(new Error("mirror-client: debug query timed out"));
        }
      }, CONNECT_TIMEOUT_MS);
    });
    this.send(this.socket, encodeEnvelope(MessageType.Debug, encodeControl(query)));
    return promise;
  }

  /**
   * Admin console command (docs/MESSAGE-CATALOG.md §0x10, roadmap A1).
   * One outstanding command at a time, like debug(); the promise resolves
   * with the server's AdminResult or rejects on error/disconnect/timeout.
   * The server rejects senders that are not admins.
   */
  admin(command: string, args?: unknown): Promise<AdminResult> {
    if (!this.socket || this.closed) {
      return Promise.reject(new Error("mirror-client: not connected"));
    }
    if (this.adminResolve) {
      return Promise.reject(
        new Error("mirror-client: admin command already in flight"),
      );
    }
    const msg: AdminCommand = args === undefined ? { kind: "admin", command } : { kind: "admin", command, args };
    const promise = new Promise<AdminResult>((resolve, reject) => {
      this.adminResolve = resolve;
      this.adminReject = reject;
      setTimeout(() => {
        if (this.adminReject === reject) {
          this.adminResolve = null;
          this.adminReject = null;
          reject(new Error("mirror-client: admin command timed out"));
        }
      }, CONNECT_TIMEOUT_MS);
    });
    this.send(this.socket, encodeEnvelope(MessageType.Admin, encodeControl(msg)));
    return promise;
  }

  // ------------------------------------------------------------ inbound

  /** Send one envelope, counting it. */
  private send(socket: SocketLike, bytes: Uint8Array): void {
    this.traffic.bytesOut += bytes.byteLength;
    this.traffic.messagesOut++;
    socket.send(bytes);
  }

  private onMessage(data: Uint8Array): void {
    this.traffic.bytesIn += data.byteLength;
    this.traffic.messagesIn++;
    let type: MessageType;
    let payload: Uint8Array;
    try {
      ({ type, payload } = decodeEnvelope(data));
    } catch {
      return; // garbage frame: ignore, the heartbeat will sort it out
    }
    switch (type) {
      case MessageType.Welcome:
        this.onWelcome(decodeControl<WelcomeMessage>(payload));
        break;
      case MessageType.Account: {
        const account = decodeControl<AccountMessage>(payload);
        this.account = account;
        this.sessionToken = account.session_token;
        this.settle({ kind: "account", account });
        break;
      }
      case MessageType.Snapshot:
        this.onSnapshot(payload);
        break;
      case MessageType.Delta:
        this.onDelta(payload);
        break;
      case MessageType.Ping:
        // Heartbeat: echo the payload back as pong (catalog §0x06/0x07).
        if (this.socket) this.send(this.socket, encodeEnvelope(MessageType.Pong, payload));
        break;
      case MessageType.Error: {
        const err = decodeControl<ErrorMessage>(payload);
        this.lastError = err;
        this.events.onError(err);
        this.settle(new Error(`hello rejected: ${err.code} ${err.message}`));
        this.debugReject?.(
          new Error(`debug rejected: ${err.code} ${err.message}`),
        );
        this.debugResolve = null;
        this.debugReject = null;
        this.adminReject?.(
          new Error(`admin rejected: ${err.code} ${err.message}`),
        );
        this.adminResolve = null;
        this.adminReject = null;
        break;
      }
      case MessageType.Debug: {
        const res = decodeControl<DebugResponse>(payload);
        this.debugResolve?.(res);
        this.debugResolve = null;
        this.debugReject = null;
        break;
      }
      case MessageType.Stats: {
        const stats = decodeControl<StatsMessage>(payload);
        this.stats = stats;
        this.events.onStats?.(stats);
        break;
      }
      case MessageType.Admin: {
        const res = decodeControl<AdminResult>(payload);
        this.adminResolve?.(res);
        this.adminResolve = null;
        this.adminReject = null;
        break;
      }
      case MessageType.Chat: {
        const m = decodeControl<ChatBroadcast | PartyState | GuildState | FriendsState>(payload);
        if (m.kind === "party") this.events.onParty?.(m);
        else if (m.kind === "guild") this.events.onGuild?.(m);
        else if (m.kind === "friends") this.events.onFriends?.(m);
        else this.events.onChat?.(m);
        break;
      }
      case MessageType.Names: {
        const { names } = decodeControl<NamesMessage>(payload);
        for (const [entity, name, tag] of names) this.names.set(BigInt(entity), tag ? `${name} <${tag}>` : name);
        break;
      }
      case MessageType.Drops: {
        const { drops } = decodeControl<DropsMessage>(payload);
        for (const [entity, name, rank, color] of drops) this.drops.set(BigInt(entity), { name, rank, color });
        break;
      }
      case MessageType.Inventory: {
        this.inventory = decodeControl<InventoryMessage>(payload);
        this.events.onInventory?.(this.inventory);
        break;
      }
      case MessageType.Hit:
        this.events.onHit?.(decodeControl<HitMessage>(payload));
        break;
      case MessageType.Life:
        this.events.onLife?.(decodeControl<LifeMessage>(payload));
        break;
      case MessageType.Body:
        this.body = decodeControl<BodyMessage>(payload);
        this.events.onBody?.(this.body);
        break;
      case MessageType.Bye:
        this.disconnect();
        break;
      default:
        break;
    }
  }

  private onWelcome(w: WelcomeMessage): void {
    if (w.protocol !== PROTOCOL_VERSION) {
      this.settle(new Error(`protocol mismatch: server=${w.protocol}`));
      return;
    }
    this.playerEntity = BigInt(w.player_entity);
    this.sessionToken = w.session_token;
    this.serverTick = w.server_tick;
    this.intentSentAt = -1; // a new connection: nothing sent on it yet
    this.pendingIntents = [];
    this.tickHz = w.tick_hz;
    this.world = w.world ?? null;
    this.day = w.day ?? null;
    this.events.onWelcome(w);
    this.settle({ kind: "welcome", welcome: w });
  }

  private onSnapshot(payload: Uint8Array): void {
    const s = decodeSnapshot(payload);
    this.state.applySnapshot(s);
    this.interpolator.clear();
    this.interpolator.push(s.tick, s.transforms);
    // Full replace: drop names for entities the snapshot doesn't carry.
    for (const wid of this.names.keys()) {
      if (!this.state.entities.has(wid)) this.names.delete(wid);
    }
    for (const wid of this.drops.keys()) {
      if (!this.state.entities.has(wid)) this.drops.delete(wid);
    }
    this.serverTick = s.tick;
    this.events.onState(s.tick);
    this.flushIntent();
  }

  private onDelta(payload: Uint8Array): void {
    const d = decodeDelta(payload);
    this.state.applyDelta(d);
    this.interpolator.push(d.tick, d.transforms);
    for (const wid of d.despawned) {
      this.interpolator.remove(wid);
      this.names.delete(wid);
      this.drops.delete(wid);
    }
    this.serverTick = d.tick;
    this.events.onState(d.tick);
    this.flushIntent();
  }

  /** Send the oldest intent held back by sendIntent, now that a new tick arrived. */
  private flushIntent(): void {
    const next = this.pendingIntents.shift();
    if (next !== undefined) this.transmitIntent(next);
  }

  private onClose(): void {
    this.closed = true;
    this.socket = null;
    this.settle(new Error("mirror-client: connection closed"));
    this.events.onClose();
  }

  private onSocketError(err: unknown): void {
    this.settle(new Error(`mirror-client: socket error: ${String(err)}`));
  }
}
