-- Migration 063: close the conflict-resolution loop.
-- Refs: arXiv:2606.01435 (Don't Ask the LLM to Track Freshness — deterministic
--       max(serial) assembly beats LLM-judged freshness)
--       arXiv:2606.06240 (TOKI — contradiction resolution IS write-time
--       concurrency control; the losing fact is PRESERVED as an audit row)
--       arXiv:2604.20006 (Memora/FAMA — penalize reliance on invalidated memory)
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THE 2026-07-22 RESEARCH GOT WRONG, AND WHY IT MATTERS HERE
--
-- The Tier-1 recommendation was built on two premises. Both are false, and
-- implementing it as literally written would have corrupted the memory graph.
--
-- FALSE PREMISE 1 — "memory_links has ZERO link_type='supersedes' rows, so
--   nothing ever resolves conflicts."
--   memory_links.link_type has CHECK (link_type IN ('semantic','temporal',
--   'causal','entity')). 'supersedes' is not a legal link_type and never was —
--   that count is structurally forced to zero and measures nothing. The
--   supersession edge lives in memory_links.RELATIONSHIP (migration 053's
--   "allow_supersedes_relationship"), where there are 33 live rows, plus 27
--   memories carrying superseded_by. supersede_memory() has been writing them
--   all along. Resolution is not absent.
--
-- FALSE PREMISE 2 — "the 268 unresolved conflicts are value conflicts; resolve
--   them by picking winner = max(version, updated_at)."
--   Breakdown of the 359 conflicts (queried 2026-07-22):
--     contradiction          52 — 0 unresolved
--     temporal_supersession   6 — 0 unresolved
--     duplicate               1 — 0 unresolved
--     stale                 300 — 268 unresolved   <-- the ENTIRE backlog
--   Every genuine value-conflict class is already fully resolved. All 268 open
--   rows are conflict_type='stale' from migration 052's SECOND detector, which
--   flags a different failure mode entirely: an active memory still LINKED to a
--   superseded/expired memory it hasn't been updated since — retired facts
--   leaking through the link graph. A typical row reads:
--     'Stale propagation: active "AI Memory Research - 2026-06-16" [wren] links
--      to superseded "weekly-ref:Daily Self-Improvement Research - 2026-04-11"'
--   These two memories are not rival claims about the same fact. One is a dated
--   research journal that CITES the other. Running max(version, updated_at) over
--   that pair and writing a supersedes edge would assert that a June research
--   log supersedes an April weekly-ref rollup — a fabricated edge, on 268 pairs,
--   in the graph that hybrid_recall and spreading-activation rerank both read.
--   That is exactly the "audit erasure" anomaly TOKI's verdict matrix rules out.
--
-- SO: the resolver below is deterministic per the papers, but it dispatches on
-- conflict_type. max(version, updated_at) is applied ONLY to real value
-- conflicts. The stale-propagation backlog gets its own correct repair —
-- re-point the citing link at the head of the supersession chain, and de-weight
-- (never delete) the stale edge.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Supersession chain head ───────────────────────────────────────────────
-- "Which row is current truth?" is the papers' max(serial). Here the chain is
-- already materialized in memories.superseded_by, so the answer is a walk, not
-- a judgment. Cycle-guarded and depth-capped: superseded_by is a plain FK with
-- no acyclicity constraint, so a bad write must not spin the sweep forever.
CREATE OR REPLACE FUNCTION public.supersession_head(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_cur   uuid := p_id;
  v_next  uuid;
  v_seen  uuid[] := ARRAY[]::uuid[];
  v_depth integer := 0;
BEGIN
  WHILE v_cur IS NOT NULL AND v_depth < 32 LOOP
    IF v_cur = ANY(v_seen) THEN
      RETURN NULL;  -- cycle: no defensible head, caller falls back to de-weight
    END IF;
    v_seen := v_seen || v_cur;
    SELECT superseded_by INTO v_next FROM memories WHERE id = v_cur;
    IF v_next IS NULL THEN
      RETURN v_cur;
    END IF;
    v_cur := v_next;
    v_depth := v_depth + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

-- ── 1b. Content timestamp — the ACTUAL freshness signal ──────────────────────
-- THE THIRD THING THE RESEARCH GOT WRONG, and the one that would have been
-- silently wrong rather than loudly wrong:
--
--   The recommendation says "winner = highest (version, updated_at)".
--   memories.updated_at is NOT a content-recency signal in this database. The
--   nightly decay and PageRank jobs rewrite it on every row: queried
--   2026-07-22, all 796 rows had updated_at inside a 13-hour window
--   (min 03:00Z, max 16:15Z). Ordering conflict pairs by updated_at would pick
--   the winner by whichever batch job touched the row last — i.e. arbitrarily,
--   while looking principled. Migration 052 already hit this and worked around
--   it; the workaround was inline, so it was easy to miss.
--
--   Content age is therefore derived the same way 052 derives it: the later of
--   the row's own created_at and its last create/update entry in memory_log.
--   memory_log is append-only and written by log_memory_change(), so it is not
--   perturbed by the ranking jobs.
CREATE OR REPLACE FUNCTION public.content_timestamp(p_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT GREATEST(
    (SELECT m.created_at FROM memories m WHERE m.id = p_id),
    COALESCE((SELECT max(l.created_at) FROM memory_log l
               WHERE l.memory_id = p_id AND l.action IN ('create', 'update')),
             (SELECT m.created_at FROM memories m WHERE m.id = p_id))
  )
$$;

COMMENT ON FUNCTION public.content_timestamp(uuid) IS
  'True content-recency for a memory (migration 063): GREATEST(created_at, last create/update in memory_log). Use this, NOT memories.updated_at — updated_at is rewritten on every row nightly by the decay/PageRank jobs and carries no freshness information (all 796 rows sat inside one 13h window on 2026-07-22). Same derivation migration 052 uses inline.';

COMMENT ON FUNCTION public.supersession_head(uuid) IS
  'Walks memories.superseded_by to the current-truth row (migration 063). Returns the input if it is already the head, NULL on a cycle or >32 hops. This is the SQL equivalent of the deterministic max(serial) assembly step in arXiv:2606.01435 — no LLM on the path.';

-- ── 2. Deterministic auto-resolver ───────────────────────────────────────────
-- Returns jsonb describing what it did; never raises on an unresolvable row, it
-- just reports action='skipped' with a reason so the sweep can keep going and
-- the residue stays visible in list_conflicts.
CREATE OR REPLACE FUNCTION public.resolve_conflict_auto(
  p_conflict_id uuid,
  p_actor       text DEFAULT 'conflict-sweep'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  c            RECORD;
  a            RECORD;
  b            RECORD;
  v_dead       uuid;
  v_live       uuid;
  v_head       uuid;
  v_winner     uuid;
  v_loser      uuid;
  v_repointed  integer := 0;
  v_deweighted integer := 0;
  v_notes      text;
BEGIN
  SELECT * INTO c FROM memory_conflicts WHERE id = p_conflict_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
                              'reason', 'conflict not found');
  END IF;
  IF COALESCE(c.resolved, false) THEN
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
                              'reason', 'already resolved');
  END IF;

  SELECT id, version, updated_at, created_at, superseded_by, expires_at, is_active
    INTO a FROM memories WHERE id = c.memory_a_id;
  SELECT id, version, updated_at, created_at, superseded_by, expires_at, is_active
    INTO b FROM memories WHERE id = c.memory_b_id;

  -- A conflict whose sides no longer both exist is self-resolving.
  IF a.id IS NULL OR b.id IS NULL THEN
    PERFORM public.resolve_conflict(p_conflict_id, p_actor,
      'auto: one or both sides deleted; conflict is moot');
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'closed_moot');
  END IF;

  -- ═══ CASE A: stale propagation ═════════════════════════════════════════════
  -- NOT a rival-value conflict. One side is dead (superseded or expired), the
  -- other is alive and still linked to it. The deterministic repair is to move
  -- the citation forward to the head of the chain, then de-weight the stale
  -- edge so spreading activation stops carrying the retired fact — WITHOUT
  -- deleting it, so the historical citation stays auditable (TOKI audit row).
  IF c.conflict_type = 'stale' THEN
    IF a.superseded_by IS NOT NULL
       OR COALESCE(a.expires_at, 'infinity'::timestamptz) <= now()
       OR a.is_active IS FALSE THEN
      v_dead := a.id; v_live := b.id;
    ELSIF b.superseded_by IS NOT NULL
       OR COALESCE(b.expires_at, 'infinity'::timestamptz) <= now()
       OR b.is_active IS FALSE THEN
      v_dead := b.id; v_live := a.id;
    ELSE
      -- Neither side is dead any more (the supersession was reverted, or the
      -- expiry extended). The detection no longer holds; close it as stale-detection.
      PERFORM public.resolve_conflict(p_conflict_id, p_actor,
        'auto: neither side is superseded/expired any more; stale flag no longer holds');
      RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'closed_no_longer_stale');
    END IF;

    v_head := public.supersession_head(v_dead);
    IF v_head = v_dead THEN
      v_head := NULL;  -- expired-with-no-successor: nothing to re-point to
    END IF;

    -- Re-point: mirror every edge between live and dead onto live<->head.
    IF v_head IS NOT NULL AND v_head <> v_live THEN
      INSERT INTO memory_links (source_id, target_id, relationship, link_type, strength)
      SELECT CASE WHEN l.source_id = v_dead THEN v_head ELSE l.source_id END,
             CASE WHEN l.target_id = v_dead THEN v_head ELSE l.target_id END,
             l.relationship,
             COALESCE(l.link_type, 'semantic'),
             COALESCE(l.strength, 0.5)
      FROM memory_links l
      WHERE (l.source_id = v_live AND l.target_id = v_dead)
         OR (l.source_id = v_dead AND l.target_id = v_live)
      ON CONFLICT (source_id, target_id, relationship) DO NOTHING;
      GET DIAGNOSTICS v_repointed = ROW_COUNT;
    END IF;

    -- De-weight, never delete. 0.05 keeps the edge queryable as provenance while
    -- making it negligible to spreading-activation rerank (migration 047).
    UPDATE memory_links l
    SET strength = 0.05
    WHERE ((l.source_id = v_live AND l.target_id = v_dead)
        OR (l.source_id = v_dead AND l.target_id = v_live))
      AND l.relationship <> 'supersedes'   -- the supersession edge itself stays authoritative
      AND COALESCE(l.strength, 0.5) > 0.05;
    GET DIAGNOSTICS v_deweighted = ROW_COUNT;

    v_notes := format(
      'auto(stale): dead=%s head=%s; re-pointed %s link(s) to head, de-weighted %s stale link(s) to 0.05. No supersedes edge invented — these are citation links, not rival values.',
      v_dead, COALESCE(v_head::text, 'none'), v_repointed, v_deweighted);
    PERFORM public.resolve_conflict(p_conflict_id, p_actor, v_notes);

    RETURN jsonb_build_object(
      'conflict_id', p_conflict_id, 'action', 'stale_repaired',
      'dead', v_dead, 'live', v_live, 'head', v_head,
      'repointed', v_repointed, 'deweighted', v_deweighted);
  END IF;

  -- ═══ CASE B: genuine value conflict ════════════════════════════════════════
  -- contradiction / duplicate / near_duplicate / concurrent_write /
  -- temporal_supersession / overlap. Winner = max(version, content_timestamp),
  -- with created_at then id as total-order tiebreaks so the function is a pure
  -- deterministic fold — same inputs, same winner, on every replay. This is the
  -- max(serial) recipe from arXiv:2606.01435 with the LLM off the write path.
  -- content_timestamp, NOT updated_at — see the 1b comment block.
  IF (a.version, public.content_timestamp(a.id), a.created_at, a.id)
   > (b.version, public.content_timestamp(b.id), b.created_at, b.id) THEN
    v_winner := a.id; v_loser := b.id;
  ELSE
    v_winner := b.id; v_loser := a.id;
  END IF;

  -- Already resolved in the graph? Close the audit row, don't re-supersede.
  IF (SELECT superseded_by FROM memories WHERE id = v_loser) IS NOT NULL THEN
    PERFORM public.resolve_conflict(p_conflict_id, p_actor,
      format('auto(%s): loser %s already superseded; conflict row closed', c.conflict_type, v_loser));
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'closed_already_superseded',
                              'winner', v_winner, 'loser', v_loser);
  END IF;
  IF (SELECT superseded_by FROM memories WHERE id = v_winner) IS NOT NULL THEN
    -- The side we'd keep is itself retired — the pair is stale relative to a
    -- third row. Don't guess; leave it for a human/agent.
    RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'skipped',
                              'reason', 'winner is itself superseded; needs manual review');
  END IF;

  -- supersede_memory() is the existing TOKI-compliant operator: it sets
  -- superseded_by + is_active=false (PRESERVES the row — no delete), rewires
  -- inbound links onto the winner, writes the loser->winner 'supersedes'
  -- relationship edge, and appends to memory_log. Do not reimplement it here.
  PERFORM public.supersede_memory(v_loser, v_winner,
    format('deterministic conflict resolution (migration 063): %s, winner by (version, content_timestamp)', c.conflict_type));

  PERFORM public.resolve_conflict(p_conflict_id, p_actor,
    format('auto(%s): winner=%s loser=%s by max(version, content_timestamp); loser preserved as audit row',
           c.conflict_type, v_winner, v_loser));

  RETURN jsonb_build_object('conflict_id', p_conflict_id, 'action', 'superseded',
                            'winner', v_winner, 'loser', v_loser);
END;
$$;

COMMENT ON FUNCTION public.resolve_conflict_auto(uuid, text) IS
  'Deterministic conflict resolver (migration 063). Dispatches on conflict_type: value conflicts pick winner = max(version, content_timestamp()) and route through supersede_memory() (loser preserved, never deleted); conflict_type=''stale'' is propagation leakage, NOT a rival value — it re-points the citation to supersession_head() and de-weights the stale edge to 0.05 instead of inventing a supersedes relationship. No LLM on the write path (arXiv:2606.01435, 2606.06240).';

-- ── 3. Sweep driver ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sweep_conflicts(
  p_limit integer DEFAULT 200,
  p_actor text    DEFAULT 'conflict-sweep',
  p_types text[]  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r          RECORD;
  v_res      jsonb;
  v_actions  jsonb := '{}'::jsonb;
  v_action   text;
  v_total    integer := 0;
  v_errors   integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM memory_conflicts
    WHERE COALESCE(resolved, false) = false
      AND (p_types IS NULL OR conflict_type = ANY(p_types))
    ORDER BY created_at ASC
    LIMIT p_limit
  LOOP
    BEGIN
      v_res := public.resolve_conflict_auto(r.id, p_actor);
      v_action := v_res->>'action';
    EXCEPTION WHEN OTHERS THEN
      -- One bad row must not abort the sweep.
      v_errors := v_errors + 1;
      v_action := 'error';
    END;
    v_total := v_total + 1;
    v_actions := jsonb_set(v_actions, ARRAY[v_action],
                           to_jsonb(COALESCE((v_actions->>v_action)::integer, 0) + 1));
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_total,
    'errors', v_errors,
    'actions', v_actions,
    'open_conflicts_remaining',
      (SELECT count(*) FROM memory_conflicts WHERE COALESCE(resolved, false) = false));
END;
$$;

COMMENT ON FUNCTION public.sweep_conflicts(integer, text, text[]) IS
  'Batch driver for resolve_conflict_auto() (migration 063). Called daily by contradiction_scan.py immediately after scan_memory_contradictions(), so detection and resolution run at the same cadence and a conflict cannot outlive its own scan cycle. Per-row exception handling: one unresolvable conflict does not abort the sweep.';

REVOKE EXECUTE ON FUNCTION public.resolve_conflict_auto(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sweep_conflicts(integer, text, text[]) FROM anon, authenticated;

-- ── 4. Governance lane in hybrid_recall ──────────────────────────────────────
-- Two signals are currently computed, stored, and read by NOTHING at ranking
-- time — the same dead-metadata pattern migration 061 fixed for trust_tier:
--   * superseded_by — supersede_memory() also sets is_active=false, and every
--     hybrid_recall lane filters `is_active IS NOT FALSE`, so today superseded
--     rows are HARD-EXCLUDED. That is stricter than the paper's prescription
--     and it is load-bearing on a single boolean: any path that flips is_active
--     back on (a revert, a manual UPDATE, a future soft-supersede mode) would
--     silently restore a retired fact to FULL rank. This lane makes the
--     down-weight the policy rather than an accident of is_active.
--   * conflict_flagged — migration 052 sets it on the older side of a
--     high-confidence contradiction with the stated intent "so recall demotes
--     it". Nothing demoted it. 4 live rows carry the flag and rank at par.
-- FAMA (arXiv:2604.20006) scores exactly this: reliance on invalidated memory.
CREATE OR REPLACE FUNCTION public.governance_weight(
  p_superseded_by    uuid,
  p_conflict_flagged boolean
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT (CASE WHEN p_superseded_by IS NOT NULL THEN 0.55 ELSE 1.00 END
        * CASE WHEN COALESCE(p_conflict_flagged, false) THEN 0.75 ELSE 1.00 END)::double precision
$$;

COMMENT ON FUNCTION public.governance_weight(uuid, boolean) IS
  'Multiplicative recall penalty for invalidated memory (migration 063): superseded x0.55, conflict_flagged x0.75, compounding. Soft down-weight, never a filter — the losing fact stays retrievable as an audit row per TOKI (arXiv:2606.06240) while FAMA-style reliance on it is penalized (arXiv:2604.20006). Tune the policy HERE; it is referenced by BOTH scoring copies inside hybrid_recall.';

-- Patch BOTH scoring copies, in place, for the reason spelled out in 061:
-- hybrid_recall's composite appears TWICE (result_ids selection AND RETURN
-- QUERY) and the two must stay byte-identical or selection and output orderings
-- diverge. Hand-transcribing ~250 lines to edit one expression is the higher-risk
-- operation; patching the deployed definition guarantees both copies get the
-- same edit.
DO $patch$
DECLARE
  v_def    text;
  v_anchor text := ')::float * public.trust_weight(m.trust_tier) AS hybrid_score,';
  v_repl   text := ')::float * public.trust_weight(m.trust_tier) * public.governance_weight(m.superseded_by, m.conflict_flagged) AS hybrid_score,';
  v_hits   integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'hybrid_recall';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 063: hybrid_recall not found — cannot apply governance lane';
  END IF;

  -- Idempotency guard: a second run would otherwise square the multiplier.
  IF position('governance_weight' in v_def) > 0 THEN
    RAISE NOTICE 'migration 063: governance lane already present, skipping patch';
    RETURN;
  END IF;

  -- Migration 061 must be applied first; the anchor is its output.
  IF position('trust_weight' in v_def) = 0 THEN
    RAISE EXCEPTION 'migration 063: trust lane (061) not present — apply 061 first, the anchor depends on it';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 2 THEN
    RAISE EXCEPTION
      'migration 063: expected exactly 2 hybrid_score scoring sites, found % — hybrid_recall has drifted, patch aborted', v_hits;
  END IF;

  EXECUTE replace(v_def, v_anchor, v_repl);
  RAISE NOTICE 'migration 063: governance lane applied to both hybrid_recall scoring copies';
END
$patch$;
