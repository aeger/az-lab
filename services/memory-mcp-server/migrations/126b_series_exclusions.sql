-- 126b_series_exclusions.sql — 2026-08-22, second hotfix to 126 (same day).
--
-- WHAT 126a's TRIPWIRE ACTUALLY CAUGHT
--   Dropping the is_active filter (126a) widened research_unregistered_series()
--   over retired rows, and it immediately raised on two names:
--       Dashboard+Grimoire UX Research - 2026-04-17  (source 'chat')
--       Grimoire Sprint Research - 2026-04-17        (source 'claude-code')
--   Both are one-off project notes from a single Grimoire sprint session, both
--   retired, both a single row on a single date. Neither is a recurring
--   daily-research producer.
--
-- WHY NOT JUST TIGHTEN THE PATTERN
--   The obvious fix — require N rows across N distinct dates before calling a
--   name a "series" — would also silence the tripwire for a genuinely new
--   producer's FIRST row, which is precisely the moment it needs to fire.
--   A heuristic that suppresses the true positive to suppress the false one is
--   the same trade that produced the original defect.
--
--   So one-offs get ACKNOWLEDGED, not filtered. An unknown date-terminated
--   '*Research - <date>' name still raises until someone classifies it, and
--   the classification is a recorded row with a reason, not an invisible
--   predicate in a WHERE clause.

BEGIN;

CREATE TABLE IF NOT EXISTS public.research_series_exclusions (
  series     text PRIMARY KEY,
  reason     text        NOT NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  added_by   text        NOT NULL DEFAULT 'wren'
);

COMMENT ON TABLE public.research_series_exclusions IS
  'Date-terminated "*Research - <date>" names that are one-off notes, NOT daily '
  'producers. Exists so research_unregistered_series() can stay strict: every '
  'unknown series raises until a human classifies it as producer or one-off.';

INSERT INTO public.research_series_exclusions (series, reason) VALUES
  ('Dashboard+Grimoire UX Research',
   'One-off Grimoire sprint note, 2026-04-17, single row, retired. Not a recurring producer.'),
  ('Grimoire Sprint Research',
   'One-off Grimoire sprint note, 2026-04-17, single row, retired. Not a recurring producer.')
ON CONFLICT (series) DO NOTHING;

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
    AND NOT EXISTS (
      SELECT 1 FROM public.research_series_exclusions x
      WHERE x.series = regexp_replace(m.name, ' - \d{4}-\d{2}-\d{2}$', ''))
  GROUP BY 1
  ORDER BY 2 DESC;
$$;

REVOKE ALL ON public.research_series_exclusions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_series_exclusions TO service_role;
ALTER TABLE public.research_series_exclusions ENABLE ROW LEVEL SECURITY;

COMMIT;
