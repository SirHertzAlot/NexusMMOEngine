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
] as const;
