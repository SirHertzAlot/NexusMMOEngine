# @mmo-engine/protocol

WebSocket envelope + message catalog helpers shared by the server now and
the three.js client in Phase 3 (DRY: one implementation of the framing).

- `src/types.ts` — `MessageType` byte values (the catalog contract — never
  renumber) and control-plane message shapes.
- `src/envelope.ts` — `encodeEnvelope` / `decodeEnvelope` (`[u8 type][payload]`)
  and JSON control-plane helpers.

Full catalog: [`docs/MESSAGE-CATALOG.md`](../../docs/MESSAGE-CATALOG.md).

```sh
npm run build   # tsc -> dist/
npm test        # build + node:test
```
