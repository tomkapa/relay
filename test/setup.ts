// Global test preload. Runs once before any test file.
// Keep minimal — per-test setup belongs in the test file itself.

import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

process.env["NODE_ENV"] = "test";

// Tests control time. Any accidental use of the real clock should be loud.
// We do not stub timers globally; production code takes a Clock parameter (CLAUDE.md §11).

// Install a real ContextManager so context.with() actually propagates across async/await.
// NodeSDK does this in production bootstrap (src/telemetry/setup.ts); tests skip that
// boot path, so without this register call, context.active() always returns ROOT_CONTEXT
// and cross-process trace-context helpers cannot be exercised.
const contextManager = new AsyncLocalStorageContextManager();
contextManager.enable();
context.setGlobalContextManager(contextManager);
