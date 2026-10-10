# EA11: Sidecars

## Design

Sidecars are helper processes that run alongside the game server, communicating over a local protocol.

### Use cases

- **NPC brain server**: LLM dialogue (never on the tick)
- **Bake workers**: asset processing farm
- **Telemetry**: metrics collection

### Manifest

```json
{
  "name": "npc-brain",
  "version": "1.0.0",
  "sidecar": {
    "command": "node ./brain-server.js",
    "port": 8787,
    "health": "/health"
  }
}
```

### Lifecycle

1. Editor "Apply modules" starts sidecars before the game server
2. Health check on `health` endpoint; unhealthy = module disabled
3. Game server connects via localhost TCP/HTTP
4. On shutdown, sidecars terminate gracefully

### Why not in-process

- Crash isolation (LLM server crash doesn't kill the tick)
- Different runtimes (Python ML models)
- Independent scaling

## Status

Design complete. Manifest schema reserved.
