-- Partial index for per-tenant cap check and per-tenant depth gauge. The full-table
-- tenant index (work_queue_tenant_idx) scans completed rows too; they dominate over
-- time and never participate in either query. Keep them out.
-- Rollback: DROP INDEX IF EXISTS work_queue_tenant_pending_idx;
CREATE INDEX work_queue_tenant_pending_idx
    ON work_queue (tenant_id)
    WHERE completed_at IS NULL;
