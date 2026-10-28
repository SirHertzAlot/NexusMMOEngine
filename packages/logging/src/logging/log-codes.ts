/**
 * SAB Logging Layer — Code Dictionary Definition (docs/SAB-LOGGING-LAYER-SPEC.md §2.3)
 *
 * Append-only dictionary of log event codes. Codes are never reused.
 */

export const LogLevel = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LogProducer = {
  GATEWAY: 0,
  SIM: 1,
  PERSIST: 2,
  WORLD: 3,
  NATIVE: 4,
  CLIENT: 5,
  ADMIN: 6,
} as const;

export type LogProducer = (typeof LogProducer)[keyof typeof LogProducer];

export interface LogArgSpec {
  name: string;
  type: "string" | "number" | "bigint" | "boolean";
}

export interface LogCodeDefinition {
  id: number;
  name: string;
  producer: LogProducer;
  level: LogLevel;
  format: string;
  args: LogArgSpec[];
  sampled?: boolean;
}

export const LOG_CODES: readonly LogCodeDefinition[] = [
  // ---------------------------------------------------------------------------
  // Gateway Subsystem (0x0100 - 0x01FF)
  // ---------------------------------------------------------------------------
  {
    id: 0x0101,
    name: "GATEWAY_HELLO_PASSWORD",
    producer: LogProducer.GATEWAY,
    level: LogLevel.INFO,
    format: "[gateway] hello client={0} via=password",
    args: [{ name: "client", type: "string" }],
  },
  {
    id: 0x0102,
    name: "GATEWAY_HELLO_MIGRATION",
    producer: LogProducer.GATEWAY,
    level: LogLevel.INFO,
    format: "[gateway] hello client={0} via=migration",
    args: [{ name: "client", type: "string" }],
  },
  {
    id: 0x0103,
    name: "GATEWAY_HELLO_TOKEN",
    producer: LogProducer.GATEWAY,
    level: LogLevel.INFO,
    format: "[gateway] hello client={0} via=token",
    args: [{ name: "client", type: "string" }],
  },
  {
    id: 0x0104,
    name: "GATEWAY_AUTH_ERROR",
    producer: LogProducer.GATEWAY,
    level: LogLevel.ERROR,
    format: "[gateway] auth error: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0105,
    name: "GATEWAY_CONTAINED_ERROR",
    producer: LogProducer.GATEWAY,
    level: LogLevel.ERROR,
    format: "[gateway] {0} error: {1}",
    args: [
      { name: "subsystem", type: "string" },
      { name: "error", type: "string" },
    ],
  },
  {
    id: 0x0106,
    name: "GATEWAY_CHARACTER_CREATED",
    producer: LogProducer.GATEWAY,
    level: LogLevel.INFO,
    format: "[gateway] character created user={0} name={1}",
    args: [
      { name: "username", type: "string" },
      { name: "characterName", type: "string" },
    ],
  },
  {
    id: 0x0107,
    name: "GATEWAY_REGISTER_ERROR",
    producer: LogProducer.GATEWAY,
    level: LogLevel.ERROR,
    format: "[gateway] register error: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0108,
    name: "GATEWAY_REGISTER_SUCCESS",
    producer: LogProducer.GATEWAY,
    level: LogLevel.INFO,
    format: "[gateway] register client={0} user={1}",
    args: [
      { name: "client", type: "string" },
      { name: "username", type: "string" },
    ],
  },
  {
    id: 0x0109,
    name: "ADMIN_COMMAND_EXECUTED",
    producer: LogProducer.ADMIN,
    level: LogLevel.INFO,
    format: "[admin] {0} {1} -> {2}",
    args: [
      { name: "username", type: "string" },
      { name: "command", type: "string" },
      { name: "status", type: "string" },
    ],
  },

  // ---------------------------------------------------------------------------
  // Simulation Subsystem (0x0200 - 0x02FF)
  // ---------------------------------------------------------------------------
  {
    id: 0x0201,
    name: "SIM_TICK_OVERRUN",
    producer: LogProducer.SIM,
    level: LogLevel.WARN,
    format: "[sim] tick {0} budget overrun: {1}us",
    args: [
      { name: "tick", type: "number" },
      { name: "durationUs", type: "number" },
    ],
  },
  {
    id: 0x0202,
    name: "SIM_SPIRAL_GUARD_FIRED",
    producer: LogProducer.SIM,
    level: LogLevel.WARN,
    format: "[sim] spiral guard fired: dropped {0}ms backlog",
    args: [{ name: "droppedMs", type: "number" }],
  },
  {
    id: 0x0203,
    name: "SIM_WORKER_READY",
    producer: LogProducer.SIM,
    level: LogLevel.INFO,
    format: "[sim] worker ready (native={0}, capacity={1})",
    args: [
      { name: "isNative", type: "boolean" },
      { name: "capacity", type: "number" },
    ],
  },
  {
    id: 0x0204,
    name: "SIM_KERNEL_TELEMETRY",
    producer: LogProducer.SIM,
    level: LogLevel.DEBUG,
    format: "[sim] kernel telemetry: entities={0} dt={1} step={2}",
    args: [
      { name: "entityCount", type: "number" },
      { name: "dt", type: "number" },
      { name: "step", type: "number" },
    ],
    sampled: true,
  },

  // ---------------------------------------------------------------------------
  // Persistence Subsystem (0x0300 - 0x03FF)
  // ---------------------------------------------------------------------------
  {
    id: 0x0301,
    name: "PERSIST_CHECKPOINT_COMMITTED",
    producer: LogProducer.PERSIST,
    level: LogLevel.DEBUG,
    format: "[persist] checkpoint committed count={0}",
    args: [{ name: "count", type: "number" }],
    sampled: true,
  },
  {
    id: 0x0302,
    name: "PERSIST_SAVE_PHASES",
    producer: LogProducer.PERSIST,
    level: LogLevel.DEBUG,
    format: "[persist] save phases: collect {0}ms encode {1}ms persist {2}ms",
    args: [
      { name: "collectMs", type: "number" },
      { name: "encodeMs", type: "number" },
      { name: "persistMs", type: "number" },
    ],
  },
  {
    id: 0x0303,
    name: "PERSIST_CHECKPOINT_FAILED",
    producer: LogProducer.PERSIST,
    level: LogLevel.WARN,
    format: "[persist] checkpoint failed: {0}",
    args: [{ name: "reason", type: "string" }],
  },
  {
    id: 0x0304,
    name: "PERSIST_CHECKPOINT_WORKER_FALLBACK",
    producer: LogProducer.PERSIST,
    level: LogLevel.WARN,
    format: "[persist] checkpoint worker {0}; using SQLite auto-checkpoint",
    args: [{ name: "reason", type: "string" }],
  },

  // ---------------------------------------------------------------------------
  // World / Region Server Interaction (0x0400 - 0x04FF)
  // Steady-state events from the region server's world-tier plumbing. Boot
  // banners and fatal errors deliberately stay on stdio (see no-console guard).
  // ---------------------------------------------------------------------------
  {
    id: 0x0401,
    name: "WORLD_CLIENT_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[server] world {0}: {1}",
    args: [
      { name: "context", type: "string" },
      { name: "error", type: "string" },
    ],
  },
  {
    id: 0x0402,
    name: "WORLD_MIGRATION_ACK_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[server] migration ack: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0403,
    name: "WORLD_MIGRATION_OBSERVE_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[server] migration observe: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0404,
    name: "WORLD_PRESENCE_SYNC_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[server] presence sync: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0405,
    name: "WORLD_DUNGEON_REPORT_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[server] dungeon report: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0406,
    name: "WORLD_DUNGEON_REPORTED",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "[server] reported {0} dungeon run(s) to the world",
    args: [{ name: "count", type: "number" }],
  },
  {
    id: 0x0407,
    name: "WORLD_MIGRATION_EVENT",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "[server] migration {0} {1}",
    args: [
      { name: "kind", type: "string" },
      { name: "entityId", type: "string" },
    ],
  },
  {
    id: 0x0408,
    name: "SERVER_SHUTDOWN_SAVE",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "[server] shutdown save on {0}: tick {1}",
    args: [
      { name: "signal", type: "string" },
      { name: "tick", type: "number" },
    ],
  },
  {
    id: 0x0409,
    name: "WORLD_MIGRATION_BEGIN_FAILED",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[migration] begin {0} -> {1} failed: {2}",
    args: [
      { name: "entityId", type: "string" },
      { name: "regionId", type: "string" },
      { name: "error", type: "string" },
    ],
  },
  {
    id: 0x040A,
    name: "WORLD_MIGRATION_ABORT_FAILED",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[migration] abort {0} failed: {1}",
    args: [
      { name: "migrationId", type: "string" },
      { name: "error", type: "string" },
    ],
  },
  {
    id: 0x040B,
    name: "WORLD_MIGRATION_READ_FAILED",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[migration] read {0} failed: {1}",
    args: [
      { name: "migrationId", type: "string" },
      { name: "error", type: "string" },
    ],
  },
  {
    id: 0x040C,
    name: "WORLD_MIGRATION_COMMIT_UNCONFIRMED",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[migration] commit {0} unconfirmed: {1}",
    args: [
      { name: "migrationId", type: "string" },
      { name: "error", type: "string" },
    ],
  },

  // ---------------------------------------------------------------------------
  // World-Tier Server (0x0500 - 0x05FF)
  // Runtime events inside the separately deployed world service
  // (packages/world-server). Its process boots its own ring + worker on the
  // same dictionary. Boot banners and fatals stay on stdio there, as here.
  // ---------------------------------------------------------------------------
  {
    id: 0x0501,
    name: "WORLD_REAPED_STALE_REGION",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "[world] reaped stale region {0}",
    args: [{ name: "regionId", type: "string" }],
  },
  {
    id: 0x0502,
    name: "WORLD_REAPER_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[world] reaper error: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0503,
    name: "WORLD_MIGRATION_EXPIRED",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "[world] migration {0} expired",
    args: [{ name: "migrationId", type: "string" }],
  },
  {
    id: 0x0504,
    name: "WORLD_MIGRATION_EXPIRY_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[world] migration expiry error: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0505,
    name: "WORLD_WEBSERVICE_INTERNAL_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.ERROR,
    format: "[world] internal error: {0}",
    args: [{ name: "error", type: "string" }],
  },

  // ---------------------------------------------------------------------------
  // Region Runtime Subsystems (0x0600 - 0x06FF)
  // Steady-state events from the region server's other runtime subsystems:
  // streaming/navmesh, rules reload, server modules, shard sync, PCG rpc.
  // Boot banners stay on stdio (see the no-console guard).
  // ---------------------------------------------------------------------------
  {
    id: 0x0601,
    name: "STREAM_WARN",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x0602,
    name: "NAVMESH_WARN",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x0603,
    name: "RULES_RELOADED",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "[rules] reloaded: {0}",
    args: [{ name: "summary", type: "string" }],
  },
  {
    id: 0x0604,
    name: "RULES_RELOAD_REFUSED",
    producer: LogProducer.WORLD,
    level: LogLevel.WARN,
    format: "[rules] reload refused, keeping the running rules: {0}",
    args: [{ name: "error", type: "string" }],
  },
  {
    id: 0x0605,
    name: "SERVER_MODULE_LOG",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x0606,
    name: "RECALL_SHARD_LOG",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x0607,
    name: "SOCIAL_SYNC_LOG",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x0608,
    name: "CHARACTER_SYNC_LOG",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x0609,
    name: "SHARD_SHIPPER_LOG",
    producer: LogProducer.WORLD,
    level: LogLevel.INFO,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x060A,
    name: "WILDLIFE_DEBUG_LOG",
    producer: LogProducer.WORLD,
    level: LogLevel.DEBUG,
    format: "{0}",
    args: [{ name: "line", type: "string" }],
  },
  {
    id: 0x060B,
    name: "NET_RPC_INTERNAL_ERROR",
    producer: LogProducer.WORLD,
    level: LogLevel.ERROR,
    format: "[rpc] internal error: {0}",
    args: [{ name: "error", type: "string" }],
  },
] as const;
