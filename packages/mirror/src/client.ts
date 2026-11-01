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
  decodeDeltaSet,
  DeltaSetKind,
  GLOBAL_SECTOR,
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
  type ByeMessage,
  type BorderMessage,
  type BorderTicket,
  type ChatBroadcast,
  type ChatChannel,
  type FriendMessage,
  type FriendsState,
  type BlocksState,
  type DialogMessage,
  type DungeonEntranceView,
  type DungeonMessage,
  type DungeonOp,
  type NpcView,
  type NpcsMessage,
  type QuestLogMessage,
  type QuestOp,
  type GuildMessage,
  type PartyMessage,
  type PartyState,
  type GuildState,
  type CreateCharacterMessage,
  type DebugQuery,
  type DebugResponse,
  type DropsMessage,
  type ArmourSlotName,
  type InventoryMessage,
  type ErrorMessage,
  type HelloMessage,
  type BodyMessage,
  type StanceMessage,
  type TreatMessage,
  type TreatmentMessage,
  type SkillsMessage,
  type CastMessage,
  type ManaMessage,
  type SpellMessage,
  type HitMessage,
  type LifeMessage,
  type TelegraphMessage,
  type IntentFields,
  type NamesMessage,
  type RegisterMessage,
  type StatsMessage,
  type TimeMessage,
  type WeatherMessage,
  type WeatherOverride,
  type WelcomeMessage,
  type DayClock,
  type WireLook,
  type WorldInfo,
  type TerrainTile,
  type TileRequestMessage,
  type TileResponseMessage,
  type PouchMessage,
  type ResourceNodeView,
  type ResourcesMessage,
  type ChestsMessage,
  type ChestView,
  type VendorMessage,
  type WalletMessage,
  type DuelAction,
  type DuelMessage,
  decodeTileHeights,
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
  /** The block list (U8), on login and after each block or unblock. */
  onBlocks?(b: BlocksState): void;
  /** The player's quest log (P1), on entering the world and after every change. */
  onQuests?(q: QuestLogMessage): void;
  /** Who gives quests and where, with their markers (P1), on entering and when a marker changes. */
  onNpcs?(n: NpcsMessage): void;
  /** An npc's line and the replies open to the player, or the dialog closed (P1). */
  onDialog?(d: DialogMessage): void;
  /** Dungeon instances (D4): entrances on entering, a transfer into a run, the run's state, its end. */
  onDungeon?(d: DungeonMessage): void;
  /** The day clock changed (roadmap A4 `time`): the sky follows from here on. */
  onTime?(t: TimeMessage): void;
  /** The weather override changed (roadmap A4 `weather`). */
  onWeather?(w: WeatherMessage): void;
  /** The player's bag changed (also on joining; roadmap M3a, protocol 0x14). */
  onInventory?(inv: InventoryMessage): void;
  /** A shop answered (the price list when E opened it, or a buy / sell confirmed; protocol 0x21). */
  onVendor?(v: VendorMessage): void;
  /** A duel was challenged, accepted, declined, started or ended (roadmap M5, protocol 0x20). */
  onDuel?(d: DuelMessage): void;
  /** The player's gold changed (protocol 0x21). */
  onWallet?(w: WalletMessage): void;
  /** World chests were described or changed (all on joining; protocol 0x27). */
  onChests?(c: ChestsMessage): void;
  /** Resource nodes were described or changed stock (all on joining; protocol 0x24). */
  onResources?(r: ResourcesMessage): void;
  /** The player's materials pouch (on joining and after every gather; protocol 0x24). */
  onPouch?(p: PouchMessage): void;
  /** A blow landed, was blocked or dodged (roadmap M2a/U12a, protocol 0x16). */
  onHit?(h: HitMessage): void;
  /** An entity died or came back (roadmap M2b/U12a, protocol 0x17). */
  onLife?(l: LifeMessage): void;
  /** A ground warning was cast, landed or was cancelled (roadmap M5, protocol 0x1e). */
  onTelegraph?(t: TelegraphMessage): void;
  /** The player's own body parts, injuries and blood changed (also on joining; roadmap M2, protocol 0x18). */
  onBody?(b: BodyMessage): void;
  /** A treatment the player gives or gets started, worked, failed or stopped (roadmap M4, protocol 0x1a). */
  onTreatment?(t: TreatmentMessage): void;
  /** The player's skills, item familiarity or disciplines changed (also on joining; roadmap M4, protocol 0x1b). */
  onSkills?(s: SkillsMessage): void;
  /** The player's mana changed (also on joining; protocol 0x1c). */
  onMana?(m: ManaMessage): void;
  /** A cast the player makes or receives started, completed or stopped (protocol 0x1c). */
  onSpell?(s: SpellMessage): void;
  /**
   * The player crossed into another region and this client moved to its
   * server (WORLD-SERVER-SPEC §6). onWelcome fired first, with the new
   * region's player entity; `url` is the server the client now talks to.
   */
  onRegionChange?(url: string): void;
  /** Cross-region view (IM8): the home region says to observe a neighbour (or stop). */
  onBorder?(msg: Extract<BorderMessage, { kind: "border" }>): void;
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
  /** The sectors the server sends this client (interest management; "g" and "pin" included), from its DeltaSets. */
  readonly interestSectors = new Set<string>();
  readonly interpolator = new Interpolator();

  playerEntity: bigint | null = null;
  sessionToken: string | null = null;
  serverTick = 0;
  tickHz = 30;
  /** A baked world's extent and coarse map, from the welcome; null for legacy worlds. */
  world: WorldInfo | null = null;
  /** The world's day clock, from the welcome; null when the server runs no day cycle. */
  day: DayClock | null = null;
  /** The weather override, from the welcome or a broadcast; auto follows the sky. */
  weatherOverride: WeatherOverride = "auto";
  lastError: ErrorMessage | null = null;
  closed = false;
  /** The account's characters, from the last account message (join()). */
  account: AccountMessage | null = null;
  /** The player's own attributes and stats, from the last stats message; null until one arrives. */
  stats: StatsMessage | null = null;
  /** The player's own body (parts, injuries, blood), from the last body message; null until one arrives. */
  body: BodyMessage | null = null;
  /** The player's skills, familiarity and disciplines, as last sent (M4, 0x1b). */
  skills: SkillsMessage | null = null;
  /** The player's mana pool, as last sent (0x1c); null until one arrives. */
  mana: ManaMessage | null = null;
  /** Quest givers and their markers (P1), as last sent; the world draws them. */
  npcs: NpcView[] = [];
  /** Dungeon entrances (D4), as last sent; the world draws them. */
  entrances: DungeonEntranceView[] = [];
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
  /** The resource nodes (catalog 0x24) by entity wire id: what each gives and how much it has left. */
  readonly resources = new Map<bigint, ResourceNodeView>();
  /** The player's gold, once the server has said (protocol 0x21 wallet). */
  wallet: number | null = null;
  /** World chests by wire id (protocol 0x27). */
  readonly chests = new Map<bigint, ChestView>();
  /** The player's materials pouch, from the last pouch message; null until one arrives. */
  pouch: PouchMessage | null = null;
  /** Bytes and messages received and sent on this client's sockets, since it was made (the HUD's network rates). */
  readonly traffic = { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0 };

  private socket: SocketLike | null = null;
  /** The server this client talks to, and the name it gave in its hello (for a region redirect). */
  private url: string | null = null;
  /**
   * The gateway this client talks to: the region, or a dungeon instance's own port.
   * Where its Pcg service is (null until it joins).
   */
  get endpoint(): string | null {
    return this.url;
  }
  private clientName = "";
  /** A region redirect is in progress: socket closes are part of it, not the end. */
  private handingOff = false;
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
  /** Outstanding tile requests (0x22/0x23), correlated by reqId. */
  private tileReqId = 0;
  private readonly tileRequests = new Map<number, {
    resolve: (tiles: TerrainTile[]) => void;
    reject: (e: Error) => void;
  }>();

  constructor(
    private readonly createSocket: (url: string) => SocketLike,
    private readonly events: MirrorEvents,
    /** `welcomeTimeoutMs`: how long to wait for the welcome (default 8 s; a slow dev box may need more). */
    private readonly options: { welcomeTimeoutMs?: number } = {},
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
  /** Buy one `def` from a shop (0x21); the server answers with the vendor and wallet messages, or a 4005 refusal. */
  vendorBuy(vendor: string, def: number): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Trade, encodeControl({ kind: "vendor", action: "buy", vendor, def })));
  }

  /** Sell a bag item to a shop (0x21). */
  /** A duel action (roadmap M5, protocol 0x20): challenge a target by wire id, or answer or yield. */
  duel(action: DuelAction["action"], target?: string): void {
    if (!this.socket || this.closed) return;
    const msg: DuelAction = target === undefined ? { kind: "duel", action } : { kind: "duel", action, target };
    this.send(this.socket, encodeEnvelope(MessageType.Duel, encodeControl(msg)));
  }

  vendorSell(vendor: string, item: number): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Trade, encodeControl({ kind: "vendor", action: "sell", vendor, item })));
  }

  /**
   * Use something in the world (0x27, what E does): an entity (a world chest,
   * a ground item, a resource node), a quest giver by id (`{npc}`) or a dungeon
   * entrance by id (`{entrance}`). The server checks reach and state and answers
   * through the usual channel (bag, pouch, dialog, dungeon hop) or a 4005 error.
   */
  interact(target: bigint | { npc: string } | { entrance: string }): void {
    if (!this.socket || this.closed) return;
    const body = typeof target === "bigint" ? { entity: target.toString() } : target;
    this.send(this.socket, encodeEnvelope(MessageType.Interact, encodeControl({ kind: "interact", ...body })));
  }

  /**
   * How the player's blows are struck (M3, 0x19): a technique ("cut",
   * "thrust", "bludgeon") and the body part aimed at. Undefined leaves a
   * field as it is, null resets it; refusals arrive as 4005 errors.
   */
  stance(technique: string | null | undefined, aim: string | null | undefined): void {
    if (!this.socket || this.closed) return;
    const msg: StanceMessage = { kind: "stance" };
    if (technique !== undefined) msg.technique = technique;
    if (aim !== undefined) msg.aim = aim;
    this.send(this.socket, encodeEnvelope(MessageType.Stance, encodeControl(msg)));
  }

  /**
   * Treat a body part with Medicine (M4, 0x1a): `target` a character's wire
   * id (absent: yourself), `part` a body part (absent: the most urgent).
   * Progress arrives as onTreatment; refusals as 4005 errors.
   */
  treat(target?: string, part?: string): void {
    if (!this.socket || this.closed) return;
    const msg: TreatMessage = { kind: "treat" };
    if (target !== undefined) msg.target = target;
    if (part !== undefined) msg.part = part;
    this.send(this.socket, encodeEnvelope(MessageType.Treat, encodeControl(msg)));
  }

  /**
   * Cast a spell (0x1c) on `target` (a character's wire id; absent:
   * yourself). Progress arrives as onSpell, refusals as 4005 errors.
   */
  cast(spell: string, target?: string): void {
    if (!this.socket || this.closed) return;
    const msg: CastMessage = { kind: "cast", spell };
    if (target !== undefined) msg.target = target;
    this.send(this.socket, encodeEnvelope(MessageType.Magic, encodeControl(msg)));
  }

  /** Stop the cast under way (0x1c). */
  stopCasting(): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Magic, encodeControl({ kind: "cast", stop: true } satisfies CastMessage)));
  }

  /** Stop the treatment under way (M4, 0x1a). */
  stopTreating(): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Treat, encodeControl({ kind: "treat", stop: true } satisfies TreatMessage)));
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

  /** Ask to eat or drink a bag item (0x13); the server restores hunger or thirst and uses it up. */
  use(item: number): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Item, encodeControl({ kind: "item", action: "use", item })));
  }

  /** Ask to put what a hand holds, or an armour slot wears, back in the bag (M3b/U10, 0x13). */
  unequip(slot: "main" | "off" | ArmourSlotName): void {
    if (!this.socket || this.closed) return;
    const action =
      slot === "main" || slot === "off"
        ? { kind: "item", action: "unequip", hand: slot }
        : { kind: "item", action: "unequip", slot };
    this.send(this.socket, encodeEnvelope(MessageType.Item, encodeControl(action)));
  }

  chat(channel: ChatChannel, text: string, to?: string): void {
    if (!this.socket || this.closed) return;
    const m = to === undefined ? { kind: "chat", channel, text } : { kind: "chat", channel, text, to };
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(m)));
  }

  /**
   * On-demand chunk tiles (protocol 0x22/0x23). Resolves with the tiles
   * the server returned (keys outside the region's range are omitted).
   * Concurrent calls are correlated by reqId; a 5s timeout rejects.
   */
  requestTiles(keys: string[]): Promise<TerrainTile[]> {
    if (!this.socket || this.closed) return Promise.reject(new Error("mirror-client: not connected"));
    const reqId = ++this.tileReqId;
    const msg: TileRequestMessage = { reqId, keys };
    return new Promise<TerrainTile[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tileRequests.delete(reqId);
        reject(new Error("mirror-client: tile request timeout"));
      }, 5000);
      this.tileRequests.set(reqId, {
        resolve: (tiles) => { clearTimeout(timer); resolve(tiles); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send(this.socket!, encodeEnvelope(MessageType.TileRequest, encodeControl(msg)));
    });
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

  /**
   * A quest op (P1, on the chat envelope): talk to an npc in range, pick a
   * reply of the open dialog, close it, or abandon a quest. Answers come
   * back as onDialog / onQuests, refusals as system chat lines.
   */
  quest(op: QuestOp): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(op)));
  }

  /** A dungeon op (D4, on the chat envelope): ask for a run at an entrance, or the run's state. */
  dungeon(op: DungeonOp): void {
    if (!this.socket || this.closed) return;
    this.send(this.socket, encodeEnvelope(MessageType.Chat, encodeControl(op)));
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
      }, this.options.welcomeTimeoutMs ?? CONNECT_TIMEOUT_MS);
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
    this.url = url;
    this.clientName = payload.client;
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
    // Mid-redirect the new socket hasn't been welcomed yet: the target would
    // answer an intent before hello with 4003. Input resumes on its welcome.
    if (!this.socket || this.playerEntity == null || this.handingOff) return;
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
    if (!this.socket || this.playerEntity == null || this.handingOff) return;
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
    for (const [, p] of this.tileRequests) p.reject(new Error("mirror-client: disconnected"));
    this.tileRequests.clear();
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

  /**
   * Cross-region view (IM8): connect as a read-only observer of a
   * neighbour region with the home region's ticket. Its entities arrive
   * in this client's own `state` (ids never mix with the home region's).
   */
  async observe(url: string, clientName: string, ticket: BorderTicket): Promise<WelcomeMessage> {
    const hello: HelloMessage = { protocol: PROTOCOL_VERSION, client: clientName, want_snapshot: true, observe: ticket };
    return this.welcomeOf(this.openAndHandshake(url, MessageType.Hello, hello));
  }

  /** Observer socket (IM8): where the player stands, so the neighbour sends what is near it. */
  sendObserve(x: number, z: number): void {
    if (!this.socket || this.closed) return;
    const msg: BorderMessage = { kind: "observe", x, z };
    this.send(this.socket, encodeEnvelope(MessageType.Border, encodeControl(msg)));
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
      case MessageType.DeltaSet:
        this.onDeltaSet(payload);
        break;
      case MessageType.Ping:
        // Heartbeat: echo the payload back as pong (catalog §0x06/0x07).
        if (this.socket) this.send(this.socket, encodeEnvelope(MessageType.Pong, payload));
        break;
      case MessageType.Error: {
        const err = decodeControl<ErrorMessage>(payload);
        this.lastError = err;
        // A target region refusing a redirect isn't the player's error:
        // the client falls back to the region it came from.
        if (!this.handingOff) this.events.onError(err);
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
        const m = decodeControl<ChatBroadcast | PartyState | GuildState | FriendsState | BlocksState | QuestLogMessage | NpcsMessage | DialogMessage | DungeonMessage | TimeMessage | WeatherMessage>(payload);
        if (m.kind === "time") {
          this.day = m.day;
          this.events.onTime?.(m);
        } else if (m.kind === "weather") {
          this.weatherOverride = m.weather;
          this.events.onWeather?.(m);
        } else if (m.kind === "party") this.events.onParty?.(m);
        else if (m.kind === "guild") this.events.onGuild?.(m);
        else if (m.kind === "friends") this.events.onFriends?.(m);
        else if (m.kind === "blocks") this.events.onBlocks?.(m);
        else if (m.kind === "quests") this.events.onQuests?.(m);
        else if (m.kind === "npcs") {
          this.npcs = m.npcs;
          this.events.onNpcs?.(m);
        } else if (m.kind === "dialog") this.events.onDialog?.(m);
        else if (m.kind === "dungeon") {
          if (m.op === "entrances") this.entrances = m.entrances;
          this.events.onDungeon?.(m);
        }
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
      case MessageType.Gather: {
        const m = decodeControl<ResourcesMessage | PouchMessage>(payload);
        if (m.kind === "resources") {
          for (const n of m.nodes) this.resources.set(BigInt(n.entity), n);
          this.events.onResources?.(m);
        } else {
          this.pouch = m;
          this.events.onPouch?.(m);
        }
        break;
      }
      case MessageType.Trade: {
        const m = decodeControl<VendorMessage | WalletMessage | { kind: string }>(payload);
        if (m.kind === "vendor") this.events.onVendor?.(m as VendorMessage);
        else if (m.kind === "wallet") {
          this.wallet = (m as WalletMessage).balance;
          this.events.onWallet?.(m as WalletMessage);
        }
        break;
      }
      case MessageType.Interact: {
        const m = decodeControl<ChestsMessage>(payload);
        if (m.kind === "chests") {
          for (const c of m.chests) this.chests.set(BigInt(c.entity), c);
          this.events.onChests?.(m);
        }
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
      case MessageType.Telegraph:
        this.events.onTelegraph?.(decodeControl<TelegraphMessage>(payload));
        break;
      case MessageType.Duel:
        this.events.onDuel?.(decodeControl<DuelMessage>(payload));
        break;
      case MessageType.Body:
        this.body = decodeControl<BodyMessage>(payload);
        this.events.onBody?.(this.body);
        break;
      case MessageType.Skills:
        this.skills = decodeControl<SkillsMessage>(payload);
        this.events.onSkills?.(this.skills);
        break;
      case MessageType.Magic: {
        const m = decodeControl<ManaMessage | SpellMessage>(payload);
        if (m.kind === "mana") {
          this.mana = m;
          this.events.onMana?.(m);
        } else this.events.onSpell?.(m);
        break;
      }
      case MessageType.Treat:
        this.events.onTreatment?.(decodeControl<TreatmentMessage>(payload));
        break;
      case MessageType.Border: {
        const m = decodeControl<BorderMessage>(payload);
        if (m.kind === "border") this.events.onBorder?.(m);
        break;
      }
      case MessageType.Bye: {
        const bye = decodeControl<ByeMessage>(payload);
        if (bye.redirect) void this.followRedirect(bye.redirect);
        else this.disconnect();
        break;
      }
      case MessageType.TileResponse: {
        const res = decodeControl<TileResponseMessage>(payload);
        const pending = this.tileRequests.get(res.reqId);
        if (pending) {
          this.tileRequests.delete(res.reqId);
          try {
            pending.resolve(res.tiles.map((t) => ({
              cx: t.cx,
              cz: t.cz,
              heights: decodeTileHeights(t.heights),
            })));
          } catch (e) {
            pending.reject(e instanceof Error ? e : new Error("mirror-client: bad tile payload"));
          }
        }
        break;
      }
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
    this.weatherOverride = w.weather ?? "auto";
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

  private onDeltaSet(payload: Uint8Array): void {
    const set = decodeDeltaSet(payload);
    if (set.replace) this.interestSectors.clear();
    for (const e of set.entries) {
      if (e.kind === DeltaSetKind.Full) this.interestSectors.add(e.sector);
      else if (e.kind === DeltaSetKind.Leave) this.interestSectors.delete(e.sector);
    }
    const entries = set.entries.map((e) => ({
      sector: e.sector,
      leave: e.kind === DeltaSetKind.Leave,
      delta: e.kind === DeltaSetKind.Leave ? null : decodeDelta(e.bytes),
    }));
    const r = this.state.applyDeltaSet(set.tick, set.replace, entries, GLOBAL_SECTOR);
    // A replace keeps names: entities out of view may come back into it.
    if (set.replace) this.interpolator.clear();
    this.interpolator.push(set.tick, r.transforms);
    for (const wid of r.left) this.interpolator.remove(wid); // names stay: it may come back into view
    for (const wid of r.despawned) {
      this.interpolator.remove(wid);
      this.names.delete(wid);
      this.drops.delete(wid);
      this.resources.delete(wid);
      this.chests.delete(wid);
    }
    this.serverTick = set.tick;
    this.events.onState(set.tick);
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
      this.resources.delete(wid);
      this.chests.delete(wid);
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

  /**
   * The server handed the player to another region (a `bye` redirect):
   * close this socket and join the target with the redirect's ticket. If
   * the target won't have us, reconnect here with the session token: this
   * region keeps the player until the target commits (WORLD-SERVER-SPEC §6).
   */
  private async followRedirect(r: NonNullable<ByeMessage["redirect"]>): Promise<void> {
    if (this.handingOff) return;
    const from = this.url;
    const token = this.sessionToken;
    this.handingOff = true;
    this.dropSocket();
    try {
      const hello: HelloMessage = {
        protocol: PROTOCOL_VERSION,
        client: this.clientName,
        want_snapshot: true,
        migration: r.migration,
        ticket: r.ticket,
      };
      await this.welcomeOf(this.openAndHandshake(r.endpoint, MessageType.Hello, hello));
      this.handingOff = false;
      this.events.onRegionChange?.(r.endpoint);
      return;
    } catch {
      this.dropSocket();
    }
    try {
      if (!from || !token) throw new Error("mirror-client: nowhere to fall back to");
      await this.connect(from, this.clientName, { token });
      this.handingOff = false;
    } catch {
      this.dropSocket();
      this.handingOff = false;
      this.onClose();
    }
  }

  /** Close the current socket without treating it as the end of the connection. */
  private dropSocket(): void {
    const old = this.socket;
    this.socket = null;
    if (!old) return;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    old.onopen = null;
    old.close();
  }

  private onClose(): void {
    if (this.handingOff) {
      // Part of a redirect: followRedirect decides what comes next.
      this.socket = null;
      this.settle(new Error("mirror-client: connection closed"));
      return;
    }
    this.closed = true;
    this.socket = null;
    this.settle(new Error("mirror-client: connection closed"));
    this.events.onClose();
  }

  private onSocketError(err: unknown): void {
    this.settle(new Error(`mirror-client: socket error: ${String(err)}`));
  }
}
