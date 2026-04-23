// Exports makeApp so tests can instantiate with test deps without touching global
// state — static allocation boundary per CLAUDE.md §9.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Sql } from "postgres";
import type { Clock } from "../core/clock.ts";
import { MAX_REQUEST_BYTES } from "./limits.ts";
import type { ReplyRegistry } from "./reply-registry.ts";
import { agentsRoute } from "./routes/agents.ts";
import { triggerRoute } from "./routes/trigger.ts";

export type AppDeps = { sql: Sql; clock: Clock; registry: ReplyRegistry };

export function makeApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.use(
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (c) =>
        c.json({ error: { kind: "request_too_large", max: MAX_REQUEST_BYTES } }, 413 as 400 | 413),
    }),
  );

  app.route("/", agentsRoute(deps));
  app.route("/", triggerRoute(deps));

  return app;
}
