/**
 * Sample sidecar (EA11): a minimal HTTP server with a /health endpoint.
 * Demonstrates the sidecar lifecycle: the SidecarManager spawns this,
 * waits for /health to return 200, and supervises it (restarts on crash).
 *
 * Run: node sidecar.js [port]
 */
const http = require("http");

const port = Number(process.argv[2]) || 49876;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  } else if (req.url === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "sample-sidecar", version: "0.1.0", uptime: process.uptime() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[sample-sidecar] listening on http://127.0.0.1:${port} (health: /health)`);
});

// Graceful shutdown on SIGTERM (from SidecarManager.stop()).
process.on("SIGTERM", () => {
  console.log("[sample-sidecar] shutting down");
  server.close(() => process.exit(0));
  // Force exit if connections hang.
  setTimeout(() => process.exit(0), 2000).unref();
});
