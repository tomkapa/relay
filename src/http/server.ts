// Bun.serve entrypoint. Reads PORT from env, validates it, starts the HTTP server.
// This file is an entrypoint — not imported by tests. Tests use makeApp directly.

import { assert } from "../core/assert.ts";
import { realClock } from "../core/clock.ts";
import { connect } from "../db/client.ts";
import { makeApp } from "./app.ts";
import { DEFAULT_PORT, PORT_MAX, PORT_MIN } from "./limits.ts";

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
const app = makeApp({ sql: sql, clock: realClock });

const server = Bun.serve({
  port: portNum,
  fetch: app.fetch.bind(app),
});

// Drain the connection pool on shutdown.
process.on("SIGTERM", () => {
  void server.stop();
  void sql.end({ timeout: 5 });
});

export { server };
