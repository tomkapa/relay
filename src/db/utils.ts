// Shared DB utilities. Kept separate from client.ts so unit tests can import these
// without pulling in the postgres.js connect factory (which needs a real DB to test).

import { assert } from "../core/assert.ts";

// Minimal JSON-safe type accepted by postgres.js sql.json(). Shared so each module
// does not need its own copy of this recursive alias.
export type DbJson =
  | null
  | string
  | number
  | boolean
  | readonly DbJson[]
  | { readonly [k: string]: DbJson };

// Narrow a row array to its first element after the caller has already verified length > 0.
// Eliminates the repeated `const row = rows[0]; assert(row !== undefined, ...)` pattern.
export function firstRow<T>(rows: readonly T[], context: string): T {
  const row = rows[0];
  assert(row !== undefined, `${context}: row undefined despite length check`);
  return row;
}
