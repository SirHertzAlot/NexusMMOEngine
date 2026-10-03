export interface EdgeConfig { httpPort: number; wsPort: number; coreChannelPort: number; }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  const p = (name: string, def: number): number => {
    const raw = env[name] ?? String(def);
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port in ${name}: ${raw}`);
    return n;
  };
  return { httpPort: p("EDGE_HTTP_PORT", 3000), wsPort: p("EDGE_WS_PORT", 3001), coreChannelPort: p("CORE_CHANNEL_PORT", 4000) };
}
