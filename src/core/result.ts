// Tagged-union Result. Expected failures only — programmer errors use assert.ts.
// Callers discriminate on `ok` and exhaustively `switch` on `error.kind`.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

// Helper for exhaustive switches: `throw unreachable(value)` in the default branch.
// Returns (rather than throws) so `throw unreachable(...)` is syntactically a throw of
// an Error value — the call site stays terminating for control-flow analysis.
export const unreachable = (value: never): Error =>
  new Error(`unreachable: ${JSON.stringify(value)}`);
