/**
 * A headless core for the E5 benches, as its own process: a Gateway over N
 * moving entities, ticking on the wall clock, serving the edge channel.
 *
 *   node core-proc.mjs <channelPort> [entities=1000] [users=20]
 *
 * Prints one JSON line {"ready":true,"gatewayPort":..,"channelPort":..}
 * when serving, and {"unhandled":..} for every unhandled rejection.
 */
import { startCoreChannel } from "../../dist/src/index.js";
import { benchGateway } from "./world.mjs";

const [channelPort = "0", entities = "1000", users = "20"] = process.argv.slice(2);
process.on("unhandledRejection", (err) => console.log(JSON.stringify({ unhandled: String(err) })));
const gw = await benchGateway({ entities: +entities, users: +users });
const gatewayPort = await gw.listen();
const core = await startCoreChannel(gw, +channelPort);
gw.startTicking();
console.log(JSON.stringify({ ready: true, gatewayPort, channelPort: core.server.port, pid: process.pid }));
process.on("SIGTERM", async () => { await core.close(); await gw.close(); process.exit(0); });
