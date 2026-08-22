-- 126_research_coverage_producer_set.sql — 2026-08-22 research impl 1/3.
--
-- PROBLEM (the 2026-08-21 "split-brain research pipeline" finding was FALSE)
--   Step 7a of the Daily Research Agent task definition asserted coverage as:
--
--     WHERE NOT EXISTS (SELECT 1 FROM memories WHERE is_active
--                       AND name = 'Daily Self-Improvement Research - '||to_char(d,'YYYY-MM-DD'))
--
--   One name literal. That is not "was this day researched?" — it is "did
--   Atlas run?". The 2026-08-21 run read three NULL days out of it and
--   reported a split-brain pipeline with a lost write path.
--
--   Verified 2026-08-22: source='ai-memory-research-trigger' holds 137 active
--   rows named 'AI Memory Research - <date>' spanning 2026-03-25..2026-08-22;
--   the cloud trigger 486da177 reports run_count=137. 137 runs, 137 rows — the
--   write path is intact. 08-18 and 08-20 are version=1 with a single 'create'
--   entry in memory_log at their own created_at, so they were not backfilled
--   after the fact either. The days were covered; the CHECK was narrow.
--
--   Generalised: an existence check keyed on ONE producer's name literal
--   silently redefines the property it claims to measure. Register a second
--   producer and coverage narrows with no error anywhere.
--
-- WHAT THIS ADDS
--   public.research_producers                       — the registry, ONE place
--   public.research_unregistered_series()           — the loud-failure detector
--   public.research_coverage(p_from, p_to)          — per-day, WHICH producer
--   public.research_coverage_gaps(p_from, p_to)     — gaps + the receipt
--   public.research_day_covered(p_day)              — scalar, for notifiers
--
-- WHY A TABLE AND NOT A CONSTANT IN EACH CALLER
--   Requirement 3: adding a producer without registering it must fail LOUDLY.
--   Three consumers (step 7a, discord-monitor.py, anomaly-heartbeat.py) each
--   carried their own literal, so "adding a producer" meant editing three
--   files and there was no way to notice you had edited one. The registry is
--   the single definition; research_unregistered_series() is the tripwire that
--   turns a forgotten registration into an exception instead of a quiet
--   narrowing, and research_coverage() refuses to answer while it is non-empty.
--
-- THE RECEIPT (arXiv 2608.19303, Outcome Monitors)
--   A monitor that reports the ADJECTIVE ("missing", "stale") launders the
--   property it actually tested. Every gap row here carries patterns_tested —
--   the literal names that found nothing — so a reader sees in one line that
--   only 'Daily Self-Improvement Research - D' was probed and can falsify the
--   finding without re-deriving the query. Had step 7a printed its own
--   literal, 2026-08-21 would have caught itself.
--
-- NAMESPACE PREFIXES ARE DERIVATIVES, NOT PRODUCERS
--   'semantic:Daily Self-Improvement Research - D' (distill) and
--   'weekly-ref:Daily Self-Improvement Research - D' (consolidation) match a
--   naive '%Research - <date>' probe but are derived FROM a producer row, not
--   evidence a run happened. Both the registry templates (exact equality) and
--   the unregistered-series detector ('^[^:]*Research - <date>$') exclude any
--   name carrying a ':' namespace prefix. Trailing-suffix rows such as
--   'Daily AI Memory Research - D Triage' are consumer artifacts and are
--   likewise excluded by the '$' anchor.

BEGIN;

-- ── registry ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.research_producers (
  key             text PRIMARY KEY,
  label           text        NOT NULL,
  -- exact memories.name template; '{date}' is substituted with YYYY-MM-DD.
  name_template   text        NOT NULL CHECK (name_template LIKE '%{date}%'),
  source_hint     text,                       -- expected memories.source, informational
  host            text        NOT NULL,
  max_age_hours   integer     NOT NULL CHECK (max_age_hours > 0),
  covers_days     boolean     NOT NULL DEFAULT true,  -- counts toward day coverage
  active          boolean     NOT NULL DEFAULT true,
  registered_at   timestamptz NOT NULL DEFAULT now(),
  notes           text
);

COMMENT ON TABLE public.research_producers IS
  'Single definition of the daily-research producer SET. Coverage checks key on '
  'this table, never on one name literal. Adding a producer without inserting a '
  'row here makes research_coverage() raise (see research_unregistered_series).';
COMMENT ON COLUMN public.research_producers.covers_days IS
  'false = this producer is watched for liveness but does not by itself make a day covered.';

INSERT INTO public.research_producers
  (key, label, name_template, source_hint, host, max_age_hours, notes)
VALUES
  ('ai_memory_research',
   'AI Memory Research (Iris / cloud routine)',
   'AI Memory Research - {date}',
   'ai-memory-research-trigger',
   'claude.ai recurring trigger 486da177 (fires ~09:10 UTC)',
   36,
   'Registered 2026-08-22. 137 active rows 2026-03-25..2026-08-22; run_count 137. '
   'Was invisible to every coverage check before this migration.'),
  ('self_improvement_research',
   'Daily Self-Improvement Research (Atlas / Wren)',
   'Daily Self-Improvement Research - {date}',
   'claude-code',
   'Atlas (Claude Code Desktop, Jeff''s workstation); Iris via record_daily_research (mig 125)',
   36,
   'The one series the pre-126 checks tested. Not broken — just not the whole set.')
ON CONFLICT (key) DO NOTHING;

-- ── loud-failure detector ───────────────────────────────────────────────────
-- Any active, non-namespaced, date-terminated '*Research - YYYY-MM-DD' series
-- that no registry template reproduces. Non-empty = someone shipped a producer
-- without registering it.
CREATE OR REPLACE FUNCTION public.research_unregistered_series()
RETURNS TABLE (series text, row_count bigint, sources text[], first_date date, last_date date)
LANGUAGE sql STABLE AS $$
  SELECT regexp_replace(m.name, ' - \d{4}-\d{2}-\d{2}$', '')      AS series,
         count(*)                                                  AS row_count,
         array_agg(DISTINCT m.source)                              AS sources,
         min(substring(m.name from '\d{4}-\d{2}-\d{2}'))::date     AS first_date,
         max(substring(m.name from '\d{4}-\d{2}-\d{2}'))::date     AS last_date
  FROM public.memories m
  WHERE m.is_active
    AND m.name ~ '^[^:]*Research - \d{4}-\d{2}-\d{2}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.research_producers p
      WHERE p.active
        AND m.name = replace(p.name_template, '{date}',
                             substring(m.name from '\d{4}-\d{2}-\d{2}')))
  GROUP BY 1
  ORDER BY 2 DESC;
$$;

-- ── the check ───────────────────────────────────────────────────────────────
-- Returns one row per day in [p_from, p_to] with WHICH producer covered it.
-- covered_by IS NULL  <=>  uncovered. patterns_tested is the receipt.
CREATE OR REPLACE FUNCTION public.research_coverage(
  p_from date,
  p_to   date DEFAULT current_date
)
RETURNS TABLE (
  day              date,
  covered          boolean,
  covered_by       text[],     -- producer keys that covered this day
  covering_rows    text[],     -- the actual memories.name values found
  patterns_tested  text[]      -- every literal probed, covered or not
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_registered int;
  v_orphans    text;
BEGIN
  SELECT count(*) INTO v_registered
  FROM public.research_producers WHERE active AND covers_days;
  IF v_registered = 0 THEN
    RAISE EXCEPTION
      'research_coverage: producer registry is empty — coverage is undefined, not zero. '
      'Populate public.research_producers before asking this question.';
  END IF;

  SELECT string_agg(format('%s (%s rows, %s..%s, sources=%s)',
                           u.series, u.row_count, u.first_date, u.last_date, u.sources),
                    E'\n  ')
    INTO v_orphans
  FROM public.research_unregistered_series() u;

  IF v_orphans IS NOT NULL THEN
    RAISE EXCEPTION E'research_coverage: unregistered daily-research producer series found. Answering now would silently narrow coverage to the registered subset.\n  %\nRegister each in public.research_producers (or supersede the rows) and re-run.',
      v_orphans;
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT generate_series(p_from, p_to, '1 day')::date AS d
  ), probe AS (
    SELECT days.d,
           p.key,
           replace(p.name_template, '{date}', to_char(days.d, 'YYYY-MM-DD')) AS literal
    FROM days
    CROSS JOIN public.research_producers p
    WHERE p.active AND p.covers_days
  ), hit AS (
    SELECT probe.d, probe.key, probe.literal, m.name AS found
    FROM probe
    LEFT JOIN public.memories m
      ON m.is_active AND m.name = probe.literal
  )
  SELECT h.d,
         bool_or(h.found IS NOT NULL),
         array_remove(array_agg(h.key   ORDER BY h.key) FILTER (WHERE h.found IS NOT NULL), NULL),
         array_remove(array_agg(h.found ORDER BY h.key) FILTER (WHERE h.found IS NOT NULL), NULL),
         array_agg(h.literal ORDER BY h.key)
  FROM hit h
  GROUP BY h.d
  ORDER BY h.d;
END;
$$;

-- ── gaps, with the property that was tested (not the adjective) ─────────────
CREATE OR REPLACE FUNCTION public.research_coverage_gaps(
  p_from date,
  p_to   date DEFAULT current_date
)
RETURNS TABLE (day date, patterns_tested text[], receipt text)
LANGUAGE sql STABLE AS $$
  SELECT c.day,
         c.patterns_tested,
         format('no active memories row matched any of: %s',
                array_to_string(c.patterns_tested, ' | ')) AS receipt
  FROM public.research_coverage(p_from, p_to) c
  WHERE NOT c.covered
  ORDER BY c.day;
$$;

-- ── scalar form, for notifiers that ask about one day ──────────────────────
-- Returns the producer key that covered p_day, or NULL. Never a bare boolean:
-- callers must be able to say WHICH producer, and log WHAT was probed.
CREATE OR REPLACE FUNCTION public.research_day_covered(p_day date)
RETURNS TABLE (day date, covered boolean, covered_by text[], covering_rows text[], patterns_tested text[])
LANGUAGE sql STABLE AS $$
  SELECT c.day, c.covered, c.covered_by, c.covering_rows, c.patterns_tested
  FROM public.research_coverage(p_day, p_day) c;
$$;

-- ── grants ──────────────────────────────────────────────────────────────────
-- service_role only. anon/authenticated get nothing (mig 100-class default;
-- REVOKE FROM PUBLIC does not revoke anon — see memory
-- 'supabase-revoke-from-public-does-not-revoke-anon').
REVOKE ALL ON public.research_producers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_coverage(date, date)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_coverage_gaps(date, date)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_day_covered(date)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_unregistered_series()         FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_producers TO service_role;
GRANT EXECUTE ON FUNCTION public.research_coverage(date, date)      TO service_role;
GRANT EXECUTE ON FUNCTION public.research_coverage_gaps(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_day_covered(date)         TO service_role;
GRANT EXECUTE ON FUNCTION public.research_unregistered_series()     TO service_role;

ALTER TABLE public.research_producers ENABLE ROW LEVEL SECURITY;

COMMIT;
