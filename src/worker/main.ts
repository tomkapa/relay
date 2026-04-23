// Worker process entrypoint. Reads DATABASE_URL from env, connects to Postgres,
// and runs the worker loop until SIGTERM / SIGINT. This file is an entrypoint —
// not imported by tests. Tests exercise runWorker directly.

// MUST be first: patches modules at require-time; anything imported earlier is un-instrumented.
import { shutdownTelemetry } from "../telemetry/setup.ts";

import { hostname } from "node:os";
import { assert } from "../core/assert.ts";
import { realClock } from "../core/clock.ts";
import { connect } from "../db/client.ts";
import { triggerHandlers } from "../trigger/handlers.ts";
import { AnthropicModelClient } from "../session/model-anthropic.ts";
import { InMemoryToolRegistry, echoTool } from "../session/tools-inmemory.ts";
import { MAX_WORKER_ID_LEN } from "../work_queue/limits.ts";
import { registerQueueGauges } from "../work_queue/observability.ts";
import { WorkerId } from "../work_queue/queue.ts";
import { DRAIN_TIMEOUT_MS } from "./limits.ts";
import { makeWorkerQueue, runWorker } from "./worker.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
assert(DATABASE_URL !== undefined && DATABASE_URL.length > 0, "worker: DATABASE_URL must be set");

// Build a worker ID that is unique per process and fits within the column cap.
const rawId = `${hostname()}:${process.pid.toString()}`;
const workerIdStr = rawId.slice(0, MAX_WORKER_ID_LEN);
const workerIdResult = WorkerId.parse(workerIdStr);
assert(workerIdResult.ok, "worker: failed to parse worker id", { workerIdStr });
const workerId = workerIdResult.value;

const ANTHROPIC_API_KEY = process.env["ANTHROPIC_API_KEY"];
assert(
  ANTHROPIC_API_KEY !== undefined && ANTHROPIC_API_KEY.length > 0,
  "worker: ANTHROPIC_API_KEY must be set",
);

const model = new AnthropicModelClient({ apiKey: ANTHROPIC_API_KEY });
const tools = new InMemoryToolRegistry([echoTool]);

const sql = connect({ url: DATABASE_URL, applicationName: "relay-worker" });
const queue = makeWorkerQueue(sql);
const disposeGauges = registerQueueGauges(sql, realClock);

const ctrl = new AbortController();

function shutdown(): void {
  ctrl.abort();
  // Hard exit after DRAIN_TIMEOUT_MS in case handler ignores abort.
  setTimeout(() => {
    process.exit(1);
  }, DRAIN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await runWorker(
  {
    queue,
    workerId,
    clock: realClock,
    dispatcher: triggerHandlers({ sql, clock: realClock, model, tools }),
  },
  ctrl.signal,
);

disposeGauges();
await sql.end({ timeout: 5 });
await shutdownTelemetry();
