-- 140_unsupersede_memory_and_negation_heuristic_false_retirements.sql — 2026-08-28
--
-- WHAT THIS IS
--   Migration 139 stopped the negation heuristic from FILING unadjudicable conflicts.
--   This one deals with what it had already done to the corpus before being stopped.
--
-- MEASURED 2026-08-28
--   resolve_conflict_auto() performed 54 supersessions off detected_by='negation_heuristic'
--   conflicts between 2026-08-24 and 2026-08-27. 30 of those losers are STILL retired
--   (is_active=false, superseded_by set, inbound edges driven to 0.05, hard-excluded
--   from every hybrid_recall lane).
--
--   The 15 conflicts left in the queue after 139 were read one by one via
--   conflict_block_report(). All 15 are non-rival pairs — e.g.
--     "partial-compose-up-breaks-gluetun-netns-members"  vs  "shelfmark-lives-in-downloads-stack"
--     "dashboard-claude-usage-limits-widget"             vs  "task-queue-system"
--     "aardvark-empty-response-lines-are-benign"         vs  "aardvark_dns_upgrade_helper_binaries_20260704"
--   Ten of them survive only because memories_forget_guard vetoes retiring an active
--   eval-probe gold. The guard is the ONLY reason those ten are still readable; it is
--   not a policy that protected the corpus, it is a lucky overlap with the eval set.
--
--   Applying the same reading to the 30 already retired: 30 of 32 are non-rival pairs
--   of the same kind, several of them notes the system wrote about ITSELF and then
--   deleted days later —
--     "forget-guard-veto-is-silent-supersede-memory-could-not-see-it"  (migration 138's finding,
--        retired 2026-08-27, one day after it was written)
--     "semantic-skill-recall-was-dead-search-path-42883"  (the standing health query the
--        daily-self-improvement-research skill tells the next run to use)
--     "a-head-is-an-extremum-compare-migration-sets"      (migration 134's own lesson)
--     "container-update-audit-method", "cowork-routines-not-api-updatable",
--     "partial-compose-up-breaks-gluetun-netns-members"   (all three still listed as live
--        references in MEMORY.md)
--   There is also a visible cascade: "task-queue-health-severity-by-class-mig-128" was the
--   WINNER of four supersessions on 08-25 and was itself retired on 08-26, and
--   "gmail-mcp-reauth-persists-only-in-memory-eacces" and "gmail-oauth-testing-mode-7day-
--   token-death" retired EACH OTHER on the same day. That is the "winner is itself
--   superseded" residue, seen from the other end.
--
--   TWO of the 32 are genuine and are deliberately NOT restored — both are same-stem
--   dated series where the newer really does replace the older:
--     cowork-daily-email-digest-blocked-20260824-1900mst -> ...-20260825-1300mst
--     stale-reverification-sweep-findings-20260728       -> ...-20260826
--
-- WHY AN OPERATOR AND NOT AN UPDATE
--   supersede_memory() does four things (is_active, superseded_by, a 'supersedes' edge,
--   and driving inbound edges to 0.05). There was no inverse, so every past reversal was
--   a hand-written UPDATE that undid some subset. memory_log's action CHECK has allowed
--   'unsupersede' since migration 131 with nothing to write it. This adds the operator.
--   Migration 115 preserved each edge's prior_strength in metadata precisely so this
--   would be possible; the restore reads that, it does not guess a default.
--
-- No memory content is modified. Nothing is deleted except the supersedes edges being
-- reversed. Re-retiring is one supersede_memory() call per row.

BEGIN;

CREATE OR REPLACE FUNCTION public.unsupersede_memory(
  p_memory_id uuid,
  p_actor     text DEFAULT 'unsupersede',
  p_reason    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_was_superseded_by uuid;
  v_active            boolean;
  v_edges             integer;
  v_restored          integer;
BEGIN
  SELECT superseded_by, is_active INTO v_was_superseded_by, v_active
  FROM memories WHERE id = p_memory_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'memory_id', p_memory_id);
  END IF;
  IF COALESCE(v_active, true) AND v_was_superseded_by IS NULL THEN
    RETURN jsonb_build_object('status', 'noop', 'memory_id', p_memory_id,
                              'reason', 'already active and not superseded');
  END IF;

  -- 1. Drop the supersedes edge. Migration 105's direction trigger is BEFORE INSERT
  --    only, so removing the edge is unobstructed — but it MUST go before clearing
  --    superseded_by or the pair is briefly in the state 105 exists to forbid.
  DELETE FROM memory_links
  WHERE source_id = p_memory_id AND relationship = 'supersedes';
  GET DIAGNOSTICS v_edges = ROW_COUNT;

  -- 2. Put the inbound edges back to what migration 115 recorded before it
  --    downweighted them. No default is invented: only edges carrying a
  --    prior_strength are touched.
  UPDATE memory_links l
     SET strength = (l.metadata->>'prior_strength')::double precision,
         metadata = (l.metadata - 'prior_strength' - 'downweight_reason'
                                - 'backflow_downweighted_at')
                    || jsonb_build_object('backflow_restored_at', now(),
                                          'backflow_restored_by', p_actor)
   WHERE l.target_id = p_memory_id
     AND l.metadata ? 'prior_strength';
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  -- 3. Un-retire. memories_forget_guard only guards the retiring direction.
  UPDATE memories
     SET is_active = true, superseded_by = NULL,
         retired_at = NULL, retire_reason = NULL
   WHERE id = p_memory_id;

  INSERT INTO memory_log (memory_id, action, source, details)
  VALUES (p_memory_id, 'unsupersede', p_actor,
          jsonb_build_object('was_superseded_by', v_was_superseded_by,
                             'supersedes_edges_removed', v_edges,
                             'inbound_edges_restored', v_restored,
                             'reason', p_reason));

  RETURN jsonb_build_object('status', 'restored', 'memory_id', p_memory_id,
                            'was_superseded_by', v_was_superseded_by,
                            'supersedes_edges_removed', v_edges,
                            'inbound_edges_restored', v_restored);
END;
$$;

COMMENT ON FUNCTION public.unsupersede_memory(uuid, text, text) IS
  'Inverse of supersede_memory(): removes the supersedes edge, restores every inbound edge to the prior_strength migration 115 stored in its metadata, clears is_active/superseded_by/retired_at, and writes a memory_log ''unsupersede'' row (the action migration 131 allowed with nothing to write it). Use for a supersession that should not have happened; re-retiring is one supersede_memory() call. Migration 140.';

REVOKE EXECUTE ON FUNCTION public.unsupersede_memory(uuid, text, text) FROM anon, authenticated;

-- ── Restore the 30 false retirements ────────────────────────────────────────
SELECT public.unsupersede_memory(v.id, 'migration-140',
         'false positive of the negation_heuristic detector: the pair were not rivals. '
         'Detector gated at intake by migration 139.')
FROM (VALUES
 ('4de7d6fa-dd63-4d4b-bc41-ef775940c70e'::uuid),  -- wan-egress-ip-is-not-the-ingress-static
 ('b6a0d217-02b9-49a0-9181-50ce0792889d'),        -- cowork-routines-not-api-updatable
 ('31c992aa-3d6f-41bd-ac58-e09eaed6030d'),        -- supersedes-edge-direction-is-old-to-new
 ('dac8720d-f5ba-403c-aa2f-e61a02dc4bb3'),        -- mem0-has-no-retire-path-conflict-gate
 ('2028fa56-9e75-4646-9275-e74b29088af8'),        -- state-of-lab-was-never-classified-as-a-dated-series
 ('44650afa-d9d6-48ec-ac80-c0a4c780fc96'),        -- a-head-is-an-extremum-compare-migration-sets
 ('6408ce55-b59e-475b-b098-29e3a9d886c0'),        -- gmail-mcp-reauth-persists-only-in-memory-eacces
 ('6a774b06-8cb2-4d05-85ae-18101e35b752'),        -- daily-email-digest cloud run blocked
 ('7f749a7d-c961-413c-b0a1-ae356cd4733a'),        -- gmail-oauth-testing-mode-7day-token-death
 ('77c4a24b-c8ce-4004-a152-6efd13ab6f4b'),        -- cloud-side-ops-alerting-task-queue-and-memory-reaudit
 ('ff8e31dc-2c7b-4c9f-b88a-c3f33825c0ed'),        -- review-needed-is-retired-migration-118
 ('c7922c69-0a23-4148-a35d-efebf3b7c545'),        -- review-needed-retired-write-side-migration-121
 ('7a4c352d-3965-4280-9d38-d8cef4731920'),        -- recurring-output-liveness-lives-in-anomaly-heartbeat
 ('e37ba5af-4226-40d5-a691-e44803f689b3'),        -- cowork-scheduled-runlog-home-is-scheduled-activity
 ('4528bb18-b970-4eb6-a09d-d1df26a25291'),        -- gmail-two-credentials-health-is-not-an-auth-check
 ('76a8a219-b828-4e87-9f06-1f717f016ca8'),        -- supersede-memory-blocked-by-forget-guard-on-eval-golds
 ('b02b3933-d611-498e-8bd0-95f04c9bd7f2'),        -- podman-healthcheck-timer-is-the-real-stuck-starting-cause
 ('d6678b11-53a5-427d-bf11-bb6dbd38a9ef'),        -- debconf-whiptail-wedges-unattended-apt-on-svc-podman-01
 ('b62a1ec7-bb84-4e90-9e4f-2a0bb4483609'),        -- claude-call-thinking-adaptive-dead-api-key-20260724
 ('026db941-c3c5-45bc-b12a-831ea555c405'),        -- lab-status-page-claude-usage-widget
 ('805bdbda-e32a-4ddf-885a-af421ff265f2'),        -- fable5_api_billing_20260704
 ('06872747-2f2d-4a75-82da-ca6ccd6151d8'),        -- container-update-audit-method
 ('87f9a084-cbc9-49dd-93f8-b154d142e5b9'),        -- premise-gate-decision-and-mechanism
 ('382e0a24-c18e-465b-b207-a699bc9122f9'),        -- partial-compose-up-breaks-gluetun-netns-members
 ('e486df01-6faa-4e82-a005-54dc40c826f6'),        -- task-queue-health-severity-by-class-mig-128
 ('9d29483c-c65c-419d-8d35-24a724bf83c8'),        -- remotetrigger-job-config-is-replace-not-merge
 ('dd92f479-1f29-4fa0-a064-eca6fc38334a'),        -- semantic:Research Digest - 2026-04
 ('ee0d719b-f94a-422d-acee-c42b18e09516'),        -- forget-guard-veto-is-silent-supersede-memory-could-not-see-it
 ('9b3f4741-0582-4fbc-b856-9392e6503134'),        -- lan-intercepts-all-port-53-dig-at-ip-proves-nothing
 ('367a54d5-5997-49f1-9def-352ccc1edd55')         -- semantic-skill-recall-was-dead-search-path-42883
) AS v(id);

COMMIT;
