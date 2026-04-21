// Assertions detect programmer errors. On failure the process crashes.
// Operating errors (flaky network, bad input) use Result<T, E> instead — never mix.
// See CLAUDE.md §6.

export class AssertionError extends Error {
  public override readonly name = "AssertionError";
  public constructor(
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export function assert(
  condition: unknown,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): asserts condition {
  if (!condition) {
    throw new AssertionError(message, details);
  }
}

export function assertNever(value: never, message = "unreachable"): never {
  throw new AssertionError(message, { value });
}
