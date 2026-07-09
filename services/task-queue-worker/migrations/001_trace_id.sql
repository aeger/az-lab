-- 001_trace_id.sql — cross-agent observability correlation id on task_queue
-- Implements REC 3 of Daily Self-Improvement Research 2026-07-09:
--   "79% of multi-agent failures are coordination, not code. A trace_id linking a
--    delegated chain (Forge -> Wren research + discord + impl tasks) makes
--    cross-agent debugging tractable."
-- Applied to azlab-memory (ogqjjlbupqnvlcyrfnxi) 2026-07-09. Idempotent.

ALTER TABLE task_queue ADD COLUMN IF NOT EXISTS trace_id text;

-- Backfill existing rows: trace_id = root ancestor of the parent_task_id chain (self if root).
WITH RECURSIVE roots AS (
  SELECT id, parent_task_id, id AS root_id FROM task_queue WHERE parent_task_id IS NULL
  UNION ALL
  SELECT t.id, t.parent_task_id, r.root_id
  FROM task_queue t JOIN roots r ON t.parent_task_id = r.id
)
UPDATE task_queue tq SET trace_id = roots.root_id::text
FROM roots WHERE tq.id = roots.id AND tq.trace_id IS NULL;
UPDATE task_queue SET trace_id = id::text WHERE trace_id IS NULL;  -- orphan chains

CREATE INDEX IF NOT EXISTS idx_task_queue_trace_id ON task_queue(trace_id);

-- Self-maintaining: new tasks inherit their parent's trace_id (delegated chains stay
-- correlated) or seed their own. Agents may also pass an explicit trace_id on insert.
CREATE OR REPLACE FUNCTION task_queue_set_trace_id() RETURNS trigger AS $$
BEGIN
  IF NEW.trace_id IS NULL THEN
    IF NEW.parent_task_id IS NOT NULL THEN
      SELECT trace_id INTO NEW.trace_id FROM task_queue WHERE id = NEW.parent_task_id;
    END IF;
    IF NEW.trace_id IS NULL THEN
      NEW.trace_id := NEW.id::text;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_task_queue_trace_id ON task_queue;
CREATE TRIGGER trg_task_queue_trace_id BEFORE INSERT ON task_queue
  FOR EACH ROW EXECUTE FUNCTION task_queue_set_trace_id();
