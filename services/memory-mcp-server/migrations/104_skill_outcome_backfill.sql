-- 104_skill_outcome_backfill.sql
-- TIER 1 (research 2026-08-04): the skill outcome loop is instrumented but starved.
--
-- WHY
--   32 skills, 2 with any success/fail data. record_skill_outcome (migration 080) is
--   wired into infrastructure/task-queue/poll_queue.py and src/index.ts, so the
--   plumbing is fine — it simply never fires, because it only fires when a *queued
--   task* invokes a skill, and Atlas/Iris almost never self-report. The skill
--   curation loop the 2026 literature converges on (SkillOS arXiv:2605.06614,
--   arXiv:2606.23127) cannot select on data that does not exist, and the monthly
--   refine pass has nothing to rank.
--
--   agent_episodes already holds 238 rows — task text plus a terminal status — so
--   the history to seed the counters is sitting in the DB. This migration ports the
--   poller's trigger matcher into SQL, replays it over the terminal episodes, and
--   seeds the counters from the result.
--
-- WHY A LEDGER AND NOT A ONE-SHOT UPDATE
--   A bare UPDATE is not re-runnable: run it twice and every counter doubles, with
--   no way to tell which increments were real. skill_outcome_backfill is keyed by
--   episode_id, so the replay is idempotent by construction, every seeded increment
--   is attributable to the episode that produced it, and the whole backfill is
--   reversible (delete the ledger, subtract the backfilled_* columns).
--
-- WHY THE COUNTS GO INTO success_count / fail_count AT ALL
--   Because the refine pass and recall_skill read those columns; a backfill parked
--   in a side column would be invisible to every consumer and would fix nothing.
--   backfilled_success_count / backfilled_fail_count record how much of the total
--   is replayed history, so a live self-report is always separable from a seeded
--   one — `success_count - backfilled_success_count` is the live-only figure, and
--   that is exactly what skill_outcome_gaps below asserts on.
--
-- DELIBERATELY NOT COUNTED
--   - status='in_progress' episodes (86 of 238). Not adjudicated. Counting an
--     unfinished episode as a success scores "the agent started" — the same mistake
--     poll_queue.py:151-155 already refuses to make for pending_eval.
--   - last_outcome is NOT written by the backfill. It is a live-report field; a
--     replayed episode from June must not masquerade as the most recent word on
--     whether a skill works.

-- ── 1. Provenance columns ───────────────────────────────────────────────────────
ALTER TABLE public.skills
  ADD COLUMN IF NOT EXISTS backfilled_success_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backfilled_fail_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outcomes_backfilled_at   timestamptz;

COMMENT ON COLUMN public.skills.backfilled_success_count IS
  'How many of success_count came from replaying agent_episodes (migration 104), not from a live record_skill_outcome call. Live-only successes = success_count - backfilled_success_count.';
COMMENT ON COLUMN public.skills.backfilled_fail_count IS
  'How many of fail_count came from replaying agent_episodes (migration 104). Live-only failures = fail_count - backfilled_fail_count.';
COMMENT ON COLUMN public.skills.outcomes_backfilled_at IS
  'When backfill_skill_outcomes_from_episodes last seeded this skill. NULL = counters are entirely live self-reports.';

-- ── 2. Attribution ledger ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.skill_outcome_backfill (
  episode_id   uuid PRIMARY KEY REFERENCES public.agent_episodes(id) ON DELETE CASCADE,
  skill_name   text        NOT NULL,
  success      boolean     NOT NULL,
  match_score  integer,
  matched_from text        NOT NULL,   -- 'task_context' | 'task_text' | 'episode_text'
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.skill_outcome_backfill IS
  'One row per agent_episode whose text matched a skill trigger and was replayed into skills.success_count/fail_count. PK on episode_id makes the replay idempotent and every seeded increment attributable. Migration 104, 2026-08-04.';

CREATE INDEX IF NOT EXISTS skill_outcome_backfill_skill_idx
  ON public.skill_outcome_backfill (skill_name);

-- ── 3. SQL port of poll_queue.py::_match_skill ─────────────────────────────────
-- Kept deliberately identical to the Python so the backfill and the live poller
-- cannot disagree about which skill a task belongs to:
--   * haystack lowercased and truncated to 4000 chars (_SKILL_MATCH_HAYSTACK_CHARS)
--   * word-boundary match so 'vm' does not fire on 'vmware' (poll_queue.py:103-105)
--   * score += (word count of trigger)^2
--   * min score 4 = one 2-word trigger, or 4 single-word hits (_SKILL_MATCH_MIN_SCORE)
--   * ties break on name ASC, purely for determinism — a tie means neither skill is
--     clearly right and the match is advisory either way
CREATE OR REPLACE FUNCTION public.match_skill_for_text(
  p_text      text,
  p_min_score integer DEFAULT 4
)
RETURNS TABLE(skill_name text, score integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hay text;
BEGIN
  v_hay := lower(left(coalesce(p_text, ''), 4000));
  IF btrim(v_hay) = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT s.name AS nm,
           COALESCE(SUM(
             CASE
               WHEN v_hay ~ ('(?<!\w)' ||
                             regexp_replace(btrim(lower(t)), '([\\^$.|?*+()\[\]{}])', '\\\1', 'g') ||
                             '(?!\w)')
               THEN (array_length(regexp_split_to_array(btrim(lower(t)), '\s+'), 1)) ^ 2
               ELSE 0
             END
           ), 0)::integer AS sc
    FROM public.skills s
    CROSS JOIN LATERAL unnest(COALESCE(s.triggers, ARRAY[]::text[])) AS t
    WHERE btrim(COALESCE(t, '')) <> ''
    GROUP BY s.name
  )
  SELECT scored.nm, scored.sc
  FROM scored
  WHERE scored.sc >= p_min_score
  ORDER BY scored.sc DESC, scored.nm ASC
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.match_skill_for_text(text, integer) IS
  'Best-matching skill name for a blob of task text, or no rows. SQL port of poll_queue.py::_match_skill — same word-boundary rule, same (word count)^2 scoring, same min score 4. Migration 104.';

-- ── 4. The replay ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.backfill_skill_outcomes_from_episodes(
  p_min_score integer DEFAULT 4,
  p_dry_run   boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  e             RECORD;
  v_skill       text;
  v_score       integer;
  v_from        text;
  v_examined    integer := 0;
  v_matched     integer := 0;
  v_unmatched   integer := 0;
  v_success     integer := 0;
  v_fail        integer := 0;
  v_by_skill    jsonb   := '{}'::jsonb;
BEGIN
  FOR e IN
    SELECT ep.id,
           ep.status,
           COALESCE(ep.ended_at, ep.updated_at, ep.created_at) AS when_ts,
           t.context->>'skill_name'                            AS ctx_skill,
           concat_ws(E'\n', t.title, t.description)            AS task_text,
           concat_ws(E'\n', ep.input_summary, ep.summary)      AS ep_text
    FROM public.agent_episodes ep
    LEFT JOIN public.task_queue t ON t.id = ep.task_id
    WHERE ep.status IN ('completed', 'failed')
      AND NOT EXISTS (
        SELECT 1 FROM public.skill_outcome_backfill b WHERE b.episode_id = ep.id
      )
    ORDER BY ep.created_at
  LOOP
    v_examined := v_examined + 1;
    v_skill := NULL; v_score := NULL; v_from := NULL;

    -- Whoever queued the task knows better than a keyword heuristic
    -- (poll_queue.py::resolve_task_skill) — an explicit value always wins.
    IF btrim(COALESCE(e.ctx_skill, '')) <> '' THEN
      v_skill := btrim(e.ctx_skill);
      v_from  := 'task_context';
    ELSE
      SELECT m.skill_name, m.score INTO v_skill, v_score
      FROM public.match_skill_for_text(e.task_text, p_min_score) m;
      IF v_skill IS NOT NULL THEN
        v_from := 'task_text';
      ELSE
        -- Episodes with no task row (4 of 238) still carry their own summaries.
        SELECT m.skill_name, m.score INTO v_skill, v_score
        FROM public.match_skill_for_text(e.ep_text, p_min_score) m;
        IF v_skill IS NOT NULL THEN v_from := 'episode_text'; END IF;
      END IF;
    END IF;

    -- An unknown skill_name is a no-op, not an error: the matcher is heuristic and
    -- a skill may since have been renamed or deleted (same contract as migration 080).
    IF v_skill IS NULL OR NOT EXISTS (SELECT 1 FROM public.skills s WHERE s.name = v_skill) THEN
      v_unmatched := v_unmatched + 1;
      CONTINUE;
    END IF;

    v_matched := v_matched + 1;
    IF e.status = 'completed' THEN v_success := v_success + 1; ELSE v_fail := v_fail + 1; END IF;
    v_by_skill := jsonb_set(v_by_skill, ARRAY[v_skill],
                            to_jsonb(COALESCE((v_by_skill->>v_skill)::int, 0) + 1), true);

    CONTINUE WHEN p_dry_run;

    INSERT INTO public.skill_outcome_backfill
      (episode_id, skill_name, success, match_score, matched_from)
    VALUES (e.id, v_skill, e.status = 'completed', v_score, v_from)
    ON CONFLICT (episode_id) DO NOTHING;

    UPDATE public.skills s
       SET success_count            = COALESCE(s.success_count, 0) + (CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END),
           fail_count               = COALESCE(s.fail_count, 0)    + (CASE WHEN e.status = 'completed' THEN 0 ELSE 1 END),
           backfilled_success_count = s.backfilled_success_count   + (CASE WHEN e.status = 'completed' THEN 1 ELSE 0 END),
           backfilled_fail_count    = s.backfilled_fail_count      + (CASE WHEN e.status = 'completed' THEN 0 ELSE 1 END),
           -- Historical, so GREATEST — a June episode must never drag last_used_at
           -- backwards over a live report from July. last_outcome is left alone on
           -- purpose: it means "the most recent live word", not "the oldest replay".
           outcomes_backfilled_at   = now(),
           last_used_at             = GREATEST(s.last_used_at, e.when_ts)
     WHERE s.name = v_skill;
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run',            p_dry_run,
    'min_score',          p_min_score,
    'episodes_examined',  v_examined,
    'episodes_matched',   v_matched,
    'episodes_unmatched', v_unmatched,
    'successes',          v_success,
    'failures',           v_fail,
    'by_skill',           v_by_skill,
    'skills_with_outcomes', (SELECT count(*) FROM public.skills
                              WHERE COALESCE(success_count,0) + COALESCE(fail_count,0) > 0)
  );
END;
$$;

COMMENT ON FUNCTION public.backfill_skill_outcomes_from_episodes(integer, boolean) IS
  'Replay terminal agent_episodes through the skill trigger matcher and seed skills.success_count/fail_count. Idempotent via the skill_outcome_backfill ledger; defaults to dry run. Migration 104, 2026-08-04.';

GRANT EXECUTE ON FUNCTION public.match_skill_for_text(text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.backfill_skill_outcomes_from_episodes(integer, boolean) TO service_role;

-- ── 5. The assertion the nightly harness reads ─────────────────────────────────
-- "A skill listed/recalled N times with zero outcomes gets flagged."
--
-- The flag deliberately measures LIVE outcomes only. After this migration every
-- matched skill has a non-zero success_count, so an assertion on the raw total
-- would go green and stay green while the live self-report loop remained just as
-- dead as it was before the backfill — the backfill would have bought a passing
-- metric instead of a working loop. live_outcomes subtracts the seeded counts, so
-- the gap stays visible until an agent actually reports something.
--
-- Evidence of use is pooled from every source that exists: recall_skill bumps
-- use_count, the poller stamps context.skill_name, and the ledger records replayed
-- episodes. Any of the three means the skill is being selected in the field.
CREATE OR REPLACE VIEW public.skill_outcome_gaps AS
SELECT
  s.name,
  COALESCE(s.use_count, 0)                                                   AS recall_use_count,
  (SELECT count(*) FROM public.skill_outcome_backfill b WHERE b.skill_name = s.name) AS backfilled_episodes,
  (SELECT count(*) FROM public.task_queue t WHERE t.context->>'skill_name' = s.name) AS tasks_attributed,
  COALESCE(s.use_count, 0)
    + (SELECT count(*) FROM public.skill_outcome_backfill b WHERE b.skill_name = s.name)
    + (SELECT count(*) FROM public.task_queue t WHERE t.context->>'skill_name' = s.name) AS evidence_count,
  COALESCE(s.success_count, 0) + COALESCE(s.fail_count, 0)                   AS total_outcomes,
  (COALESCE(s.success_count, 0) - s.backfilled_success_count)
    + (COALESCE(s.fail_count, 0) - s.backfilled_fail_count)                  AS live_outcomes,
  s.outcomes_backfilled_at,
  s.last_used_at
FROM public.skills s;

COMMENT ON VIEW public.skill_outcome_gaps IS
  'Per-skill evidence-of-use vs LIVE (non-backfilled) outcome reports. eval/skill_outcome_gate.py flags rows with evidence_count >= N and live_outcomes = 0. Migration 104, 2026-08-04.';

GRANT SELECT ON public.skill_outcome_gaps TO anon, authenticated, service_role;
