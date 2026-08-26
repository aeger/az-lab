-- 137a_conflict_sweep_health_verdict_precision.sql — 2026-08-26
--
-- BOOKKEEPING NOTE (written 2026-08-26, after the fact)
--   This migration was applied to the live DB at 2026-08-26 17:23:13Z and is
--   recorded in supabase_migrations.schema_migrations as
--   `137a_conflict_sweep_health_verdict_precision`, but the .sql was never
--   committed — its body was folded into 137's file instead. That leaves a
--   ledger-not-on-disk hole, which is exactly the class of drift migration 134
--   built the SET comparison to surface. Restored here so the diff is clean and
--   so the sequence 137 -> 137a -> 138 replays to the deployed state.
--
-- WHAT IT CHANGES
--   137's first cut of conflict_sweep_health collapsed two different failures
--   into one verdict. `adjudicated = 0` can mean either:
--     * the full p_limit budget was spent and nothing was adjudicable
--       (SATURATED — the 08-25/08-26 head-of-line block), or
--     * the sweep ran UNDER budget and every candidate it reached was refused
--       (STALLED — a permanent residue that no larger budget will clear).
--   Reporting both as "saturated" would send the reader to raise
--   CONFLICT_SWEEP_LIMIT, which fixes the first and does nothing for the second.
--   Splitting them is the same discipline 137 exists to enforce: report the
--   property measured, not the adjective concluded.
--
--   Superseded by migration 138, which re-creates this view with the additional
--   `vetoed` column. Replaying this file before 138 is harmless.
--
-- Idempotent. No data modified.

DROP VIEW IF EXISTS public.conflict_sweep_health;
CREATE VIEW public.conflict_sweep_health
WITH (security_invoker = true) AS
SELECT r.ran_at,
       r.actor,
       r.open_before,
       r.open_after,
       (r.open_before - r.open_after)            AS net_closed,
       r.candidates_available,
       r.pit_deferred,
       r.processed,
       r.adjudicated,
       r.skipped,
       r.errors,
       round(100.0 * r.skipped / NULLIF(r.processed, 0), 1)    AS skipped_pct,
       round(100.0 * r.pit_deferred / NULLIF(r.open_before, 0), 1) AS deferred_pct_of_open,
       GREATEST(0, r.candidates_available - r.processed)       AS backlog_unreached,
       CASE
         WHEN r.processed = 0 AND r.candidates_available = 0 THEN 'idle — nothing adjudicable open'
         WHEN r.processed = 0                                THEN 'NOT RUNNING — candidates exist, none processed'
         WHEN r.adjudicated = 0 AND r.processed >= r.sweep_limit
              THEN 'SATURATED — full budget spent, zero adjudicated'
         WHEN r.adjudicated = 0
              THEN 'STALLED — every candidate refused or errored (under budget)'
         WHEN r.candidates_available > r.processed
              THEN 'BACKLOG — adjudicable work exceeded the budget'
         WHEN r.open_after > r.open_before                    THEN 'intake exceeds resolution this run'
         ELSE 'ok'
       END AS verdict
FROM public.conflict_sweep_runs r
ORDER BY r.ran_at DESC;

COMMENT ON VIEW public.conflict_sweep_health IS
  'Saturation readout over conflict_sweep_runs (migration 137). verdict distinguishes "no adjudicable work left" from "budget burned on rows the resolver refuses" — the 08-25/08-26 failure looked identical to healthy in the log because both report processed=200.';

REVOKE ALL ON public.conflict_sweep_health FROM anon, authenticated;
