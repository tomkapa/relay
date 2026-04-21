// Global test preload. Runs once before any test file.
// Keep minimal — per-test setup belongs in the test file itself.

process.env["NODE_ENV"] = "test";

// Tests control time. Any accidental use of the real clock should be loud.
// We do not stub timers globally; production code takes a Clock parameter (CLAUDE.md §11).
