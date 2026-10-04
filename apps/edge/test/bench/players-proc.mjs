/**
 * B6's players, in their own process so the edge's memory is measured
 * alone: N players log in through the edge, enter the world on the core's
 * gateway, and send player.intent at 5 Hz for the given seconds.
 *
 *   node players-proc.mjs <edgeWsPort> <gatewayPort> <players> <seconds>
 *
 * Prints {"joined":true} once everyone is in the world, then one result line.
 */
import { edgeClient, intent, joinPlayer, sleep } from "./harness.mjs";

const [wsPort, gatewayPort, n, seconds] = process.argv.slice(2).map(Number);
const players = [];
for (let p = 0; p < n; p++) {
  const client = await edgeClient(wsPort);
  players.push({ client, ...(await joinPlayer(client, gatewayPort, `bench-${p}`)) });
}
// The headless game clients record every message they get; this process
// only needs them to stay in the world, so drop what they keep.
const trim = setInterval(() => { for (const p of players) p.gameClient.received?.clear(); }, 1000);
console.log(JSON.stringify({ joined: true }));
let sent = 0, accepted = 0, refused = 0, other = 0;
const end = Date.now() + seconds * 1000;
await Promise.all(players.map(async ({ client, token }, p) => {
  let i = 0;
  while (Date.now() < end) {
    sent++;
    client.request("player.intent", { token, intent: intent(i++ + p) }).then((r) => {
      if (r.type !== "player.intent") other++;
      else if (r.payload?.accepted) accepted++;
      else refused++;
    });
    await sleep(200);
  }
}));
await sleep(1000);
clearInterval(trim);
console.log(JSON.stringify({ sent, accepted, refused, other }));
for (const p of players) { await p.gameClient.close(); p.client.close(); }
process.exit(0);
