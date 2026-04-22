// Dispatcher types and stub. A Dispatcher maps every WorkKind to a Handler that does the
// actual application work. The real dispatcher is wired at startup by the application;
// the stub returns handler_failed for every kind so the worker loop can be tested and
// run before real handlers are implemented.

import type { Result } from "../core/result.ts";
import { err } from "../core/result.ts";
import type { WorkKind, WorkItem } from "../work_queue/queue.ts";
import { WORK_KINDS } from "../work_queue/queue.ts";

export type HandlerError = { kind: "handler_failed"; reason: string } | { kind: "handler_timeout" };

// A Handler receives the item to process and an AbortSignal that fires on worker shutdown
// or lease loss. It must complete (ok) or fail (err) — panicking via AssertionError is
// reserved for programmer errors per CLAUDE.md §6.
export type Handler = (item: WorkItem, signal: AbortSignal) => Promise<Result<void, HandlerError>>;

// Every WorkKind must be covered — exhaustiveness is enforced by the Record type.
export type Dispatcher = Readonly<Record<WorkKind, Handler>>;

// Stub dispatcher used at startup before real handlers are wired in. Returns
// handler_failed immediately for every kind so work items are released (not silently
// dropped) when no real implementation exists.
const stubHandler: Handler = () =>
  Promise.resolve(err<HandlerError>({ kind: "handler_failed", reason: "not implemented" }));

export const stubDispatcher: Dispatcher = Object.fromEntries(
  WORK_KINDS.map((k) => [k, stubHandler]),
) as Dispatcher;
