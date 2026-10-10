# EA12: Edge Modules

## Design

Edge modules run on edge nodes (not the core tick), handling work that needs to be near players but not on the authoritative simulation.

### Use cases

- **Voice chat**: regional voice servers
- **CDN edge**: asset serving
- **Matchmaking**: regional lobbies

### Manifest

```json
{
  "name": "voice-us-east",
  "version": "1.0.0",
  "edge": {
    "regions": ["us-east"],
    "endpoint": "wss://voice-us-east.example.com",
    "capabilities": ["voice", "video"]
  }
}
```

### Discovery

Edge modules register with the orchestrator. Clients discover the nearest edge via latency probe.

### Why not core

- Latency: voice needs <100ms, can't go through central server
- Bandwidth: asset CDN offloads core
- Failure isolation: edge outage doesn't stop the sim

## Status

Design complete. Manifest schema reserved.
