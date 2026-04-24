-- RELAY cross-process trace context: stamp the caller's W3C traceparent onto every
-- work_queue row so the worker can resume the caller's trace when it dequeues.
--
-- Without this column, HTTP → queue → worker spans live in three disjoint traces and
-- the Honeycomb trace view can't stitch a POST /trigger to the session.turn it produced.
--
-- Nullable because:
--   * Scheduler-originated enqueues (task_fire cron) have no caller span.
--   * Legacy rows predating this migration have no context.
-- Length-capped so a malformed header can't balloon the row; app-side
-- validateEnqueue enforces the same cap (src/work_queue/limits.ts MAX_TRACEPARENT_LEN).
--
-- No index — this column is read only by the dequeue-then-process path, which already
-- located the row via the existing work_queue_ready_idx. An index here would cost write
-- amplification for zero read benefit.

ALTER TABLE work_queue ADD COLUMN traceparent TEXT;
ALTER TABLE work_queue ADD CONSTRAINT work_queue_traceparent_len
    CHECK (traceparent IS NULL OR length(traceparent) <= 64);

-- Reversible rollback (CLAUDE.md §14):
-- ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_traceparent_len;
-- ALTER TABLE work_queue DROP COLUMN IF EXISTS traceparent;
