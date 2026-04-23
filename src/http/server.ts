// Bun.serve entrypoint. Reads PORT from env, validates it, starts the HTTP server.
// This file is an entrypoint — not imported by tests. Tests use makeApp directly.

// MUST be first: patches modules at require-time; anything imported earlier is un-instrumented.
import { shutdownTelemetry } from "../telemetry/setup.ts";

import { assert } from "../core/assert.ts";
import { realClock } from "../core/clock.ts";
import { connect } from "../db/client.ts";
import { makeApp } from "./app.ts";
import { DEFAULT_PORT, PORT_MAX, PORT_MIN } from "./limits.ts";
import { makeReplyRegistry } from "./reply-registry.ts";
import { startSyncListener } from "./sync-listener.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
assert(DATABASE_URL !== undefined && DATABASE_URL.length > 0, "server: DATABASE_URL must be set");

const portStr = process.env["PORT"] ?? String(DEFAULT_PORT);
const portNum = Number(portStr);
assert(
  Number.isInteger(portNum) && portNum >= PORT_MIN && portNum <= PORT_MAX,
  "server: PORT must be an integer in [PORT_MIN, PORT_MAX]",
  { portStr, PORT_MIN, PORT_MAX },
);

const sql = connect({ url: DATABASE_URL, applicationName: "relay-http" });
const registry = makeReplyRegistry(realClock);
const app = makeApp({ sql, clock: realClock, registry });

// Wire LISTEN before serving — ensures no request races the listener setup.
const syncListener = await startSyncListener(sql, registry);

const server = Bun.serve({
  port: portNum,
  fetch: app.fetch.bind(app),
});

// Drain the connection pool on shutdown. Telemetry last so the drain itself is instrumented.
async function shutdown(): Promise<void> {
  await server.stop();
  await syncListener.stop();
  await sql.end({ timeout: 5 });
  await shutdownTelemetry();
}

process.on("SIGTERM", () => {
  void shutdown();
});

export { server };
