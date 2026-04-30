-- Migration 032: backfill duplicate scheduled tasks into recurring rows
-- ─────────────────────────────────────────────────────────────────────
-- Apply AFTER migration 031.
-- Idempotent: groups duplicate-titled completed tasks (the canonical scheduled
-- ones from cowork CCR triggers), keeps the latest as the canonical recurring
-- row with runs[] populated from the older rows' result fields, archives the
-- duplicates so the dashboard collapses to one entry per scheduled task.
--
-- Apply via Supabase dashboard SQL editor.

BEGIN;

-- Define the recurring task groups we know about. Add more rows here if
-- additional duplicate-titled scheduled tasks are discovered later.
WITH known_recurrings AS (
  SELECT
    title_pattern,
    recurring_key
  FROM (VALUES
    ('Send breakthrough alert to Discord%',          'breakthrough-watch'),
    ('Deliver Discord notification: AI Memory Research%', 'daily-ai-memory-research'),
    ('Discord notify: weekly-rls-audit%',            'weekly-rls-audit'),
    ('Discord: Weekly constitution audit%',          'weekly-constitution-audit')
  ) AS t(title_pattern, recurring_key)
),
matched AS (
  SELECT
    tq.id,
    tq.title,
    tq.description,
    tq.context,
    tq.priority,
    tq.status,
    tq.source,
    tq.target,
    tq.result,
    tq.tags,
    tq.created_at,
    tq.updated_at,
    kr.recurring_key,
    ROW_NUMBER() OVER (PARTITION BY kr.recurring_key ORDER BY tq.created_at DESC) AS rn,
    COUNT(*)   OVER (PARTITION BY kr.recurring_key)                              AS group_total
  FROM public.task_queue tq
  JOIN known_recurrings kr ON tq.title LIKE kr.title_pattern
  WHERE tq.archived_at IS NULL
),
canonical AS (
  -- The most recent row per group becomes the canonical recurring entry
  SELECT
    id, recurring_key, group_total, created_at
  FROM matched
  WHERE rn = 1
),
older_runs AS (
  -- Older duplicates collapse into the runs[] array on the canonical row
  SELECT
    recurring_key,
    jsonb_agg(
      jsonb_build_object(
        'run_at', updated_at,
        'result', COALESCE(result, ''),
        'notes',  NULL,
        'status', status,
        'source_id', id
      )
      ORDER BY updated_at ASC
    ) AS runs_array,
    array_agg(id) AS dup_ids
  FROM matched
  WHERE rn > 1
  GROUP BY recurring_key
)
UPDATE public.task_queue tq
SET
  recurring     = true,
  recurring_key = c.recurring_key,
  last_run_at   = c.created_at,
  run_count     = c.group_total,
  runs          = COALESCE(o.runs_array, '[]'::jsonb)
                  || jsonb_build_array(
                       jsonb_build_object(
                         'run_at', tq.updated_at,
                         'result', COALESCE(tq.result, ''),
                         'notes',  NULL,
                         'status', tq.status,
                         'source_id', tq.id
                       )
                     )
FROM canonical c
LEFT JOIN older_runs o USING (recurring_key)
WHERE tq.id = c.id;

-- Archive the duplicates rather than delete (retain audit trail)
UPDATE public.task_queue
SET archived_at = COALESCE(archived_at, now())
WHERE id IN (
  SELECT unnest(dup_ids) FROM (
    SELECT array_agg(id) AS dup_ids
    FROM (
      SELECT
        tq.id,
        ROW_NUMBER() OVER (PARTITION BY kr.recurring_key ORDER BY tq.created_at DESC) AS rn
      FROM public.task_queue tq
      JOIN (VALUES
        ('Send breakthrough alert to Discord%',          'breakthrough-watch'),
        ('Deliver Discord notification: AI Memory Research%', 'daily-ai-memory-research'),
        ('Discord notify: weekly-rls-audit%',            'weekly-rls-audit'),
        ('Discord: Weekly constitution audit%',          'weekly-constitution-audit')
      ) AS kr(title_pattern, recurring_key)
        ON tq.title LIKE kr.title_pattern
      WHERE tq.archived_at IS NULL
    ) ranked
    WHERE rn > 1
  ) AS dups_holder
);

COMMIT;

-- Verification:
--   SELECT recurring_key, run_count, last_run_at, jsonb_array_length(runs) AS history_len, title
--   FROM public.task_queue WHERE recurring = true ORDER BY last_run_at DESC;
--
-- Expected after apply:
--   breakthrough-watch              13 runs   2026-04-30 ...
--   daily-ai-memory-research        N runs    ...
--   weekly-rls-audit                M runs    ...
--   weekly-constitution-audit       K runs    ...
