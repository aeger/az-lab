-- 126a_coverage_is_not_is_active.sql — 2026-08-22, hotfix to 126 (same day).
--
-- WHAT THE 126 BACKTEST PRINTED
--   research_coverage('2026-03-25','2026-08-22') -> 151 days, 137 covered,
--   14 uncovered. The task expected ZERO. Per instruction 5 the expectation was
--   NOT adjusted; the 14 were investigated, and 11 of them are a SECOND bug in
--   the same family as the one 126 fixed.
--
--   Eleven of the fourteen have a producer row for that exact date. It is
--   is_active = false, superseded_by = bd2a2cb9 — the weekly-ref consolidation
--   rollup. Example: 'Daily Self-Improvement Research - 2026-04-06', created
--   2026-04-07, retired 2026-08-16 by consolidation.
--
-- THE DEFECT
--   126 inherited `AND is_active` from the step-7a query it replaced. That
--   predicate makes coverage a function of the memory LIFECYCLE, not of what
--   happened. The run occurred; consolidation later folded the row into a
--   30-day rollup; the day retroactively became "uncovered". Coverage silently
--   decays backwards with age, and the older the window the more a coverage
--   check reports gaps that are really just consolidation doing its job.
--
--   Same shape as 126's own bug: a predicate narrowed the property under
--   measurement without saying so. 126 fixed the producer axis and left the
--   lifecycle axis. Both had to go.
--
--   Scale of what is_active was hiding: the 'Daily Self-Improvement Research -
--   <date>' series has 131 rows, 20 active and 111 retired, running 2026-03-30
--   to 2026-08-22 — not the 20-rows-since-08-01 an is_active probe reports.
--
-- WHAT COVERAGE MEANS NOW
--   A day is covered if ANY registered producer wrote a row for it, whatever
--   that row's current lifecycle state. Callers that specifically need a LIVE
--   row (discord-monitor's split-brain check reads today's row) get
--   covered_active / covering_rows_active alongside, and can require it
--   explicitly. Nobody gets it by accident.
--
-- RECEIPT DISCIPLINE UNCHANGED (arXiv 2608.19303)
--   patterns_tested still carries the literals probed, and gap receipts now
--   also state the lifecycle predicate applied — because that predicate is
--   exactly what went unstated for the eleven days above.

BEGIN;

-- ── detector: retired rows still prove a producer exists ────────────────────
CREATE OR REPLACE FUNCTION public.research_unregistered_series()
RETURNS TABLE (series text, row_count bigint, sources text[], first_date date, last_date date)
LANGUAGE sql STABLE AS $$
  SELECT regexp_replace(m.name, ' - \d{4}-\d{2}-\d{2}$', '')      AS series,
         count(*)                                                  AS row_count,
         array_agg(DISTINCT m.source)                              AS sources,
         min(substring(m.name from '\d{4}-\d{2}-\d{2}'))::date     AS first_date,
         max(substring(m.name from '\d{4}-\d{2}-\d{2}'))::date     AS last_date
  FROM public.memories m
  WHERE m.name ~ '^[^:]*Research - \d{4}-\d{2}-\d{2}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.research_producers p
      WHERE p.active
        AND m.name = replace(p.name_template, '{date}',
                             substring(m.name from '\d{4}-\d{2}-\d{2}')))
  GROUP BY 1
  ORDER BY 2 DESC;
$$;

DROP FUNCTION IF EXISTS public.research_day_covered(date);
DROP FUNCTION IF EXISTS public.research_coverage_gaps(date, date);
DROP FUNCTION IF EXISTS public.research_coverage(date, date);

CREATE FUNCTION public.research_coverage(
  p_from date,
  p_to   date DEFAULT current_date
)
RETURNS TABLE (
  day                  date,
  covered              boolean,   -- a producer row exists, any lifecycle state
  covered_active       boolean,   -- ...and at least one is still is_active
  covered_by           text[],    -- producer keys that covered this day
  covering_rows        text[],    -- memories.name values found, with state
  covering_rows_active text[],    -- subset that is still active
  patterns_tested      text[]     -- every literal probed, hit or miss
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
    -- NO is_active filter: a consolidated row still proves the run happened.
    SELECT probe.d, probe.key, probe.literal, m.name, m.is_active
    FROM probe
    LEFT JOIN public.memories m ON m.name = probe.literal
  )
  SELECT h.d,
         bool_or(h.name IS NOT NULL),
         coalesce(bool_or(h.is_active), false),
         array_remove(array_agg(DISTINCT h.key) FILTER (WHERE h.name IS NOT NULL), NULL),
         array_remove(array_agg(DISTINCT h.name || (CASE WHEN h.is_active THEN ' [active]'
                                                        ELSE ' [retired]' END))
                      FILTER (WHERE h.name IS NOT NULL), NULL),
         array_remove(array_agg(DISTINCT h.name) FILTER (WHERE h.is_active), NULL),
         array_remove(array_agg(DISTINCT h.literal), NULL)
  FROM hit h
  GROUP BY h.d
  ORDER BY h.d;
END;
$$;

-- p_require_active = true asks the narrower question (is there a LIVE row?).
-- The receipt names which question was asked, so the two can never be confused
-- in a report the way they were on 2026-08-21.
CREATE FUNCTION public.research_coverage_gaps(
  p_from           date,
  p_to             date DEFAULT current_date,
  p_require_active boolean DEFAULT false
)
RETURNS TABLE (day date, patterns_tested text[], receipt text)
LANGUAGE sql STABLE AS $$
  SELECT c.day,
         c.patterns_tested,
         format('no %s memories row matched any of: %s',
                CASE WHEN p_require_active THEN 'ACTIVE' ELSE 'active-or-retired' END,
                array_to_string(c.patterns_tested, ' | ')) AS receipt
  FROM public.research_coverage(p_from, p_to) c
  WHERE CASE WHEN p_require_active THEN NOT c.covered_active ELSE NOT c.covered END
  ORDER BY c.day;
$$;

CREATE FUNCTION public.research_day_covered(p_day date)
RETURNS TABLE (day date, covered boolean, covered_active boolean, covered_by text[],
               covering_rows text[], covering_rows_active text[], patterns_tested text[])
LANGUAGE sql STABLE AS $$
  SELECT c.day, c.covered, c.covered_active, c.covered_by,
         c.covering_rows, c.covering_rows_active, c.patterns_tested
  FROM public.research_coverage(p_day, p_day) c;
$$;

REVOKE ALL ON FUNCTION public.research_coverage(date, date)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_coverage_gaps(date, date, boolean)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.research_day_covered(date)                           FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.research_coverage(date, date)               TO service_role;
GRANT EXECUTE ON FUNCTION public.research_coverage_gaps(date, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.research_day_covered(date)                  TO service_role;

-- A third source string writes the self_improvement template
-- ('daily-self-improvement-research-trigger', 2026-04-01). source_hint is
-- informational only — the registry keys on the NAME template — but record it
-- so nobody re-derives the producer set from memories.source and gets it wrong.
UPDATE public.research_producers
   SET source_hint = 'claude-code | daily-self-improvement-research-trigger | claude-ai (mig 125)'
 WHERE key = 'self_improvement_research';

COMMIT;
