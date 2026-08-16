-- Migration 119: record the coverage caveat on the A-MAC fifth term
--
-- DECISION (2026-08-15): accept poller-only episode coverage; do NOT extend
-- episode opening to Atlas/Iris. Documentation-only migration — no DDL, no
-- function bodies, no scoring change. It exists so the caveat is discoverable
-- from \d+ memories rather than only from a memory row.
--
-- THE FINDING, audited live 2026-08-15:
--   SELECT agent, count(*) FROM agent_episodes GROUP BY agent;
--     wren -> 295   (179 completed, first 2026-05-22, last 2026-08-15)
--   That is the whole table. Atlas and Iris have opened zero episodes, ever.
--   Only poll_queue.py calls record_episode, so every consult edge feeding
--   refresh_memory_outcome_utility() comes from one agent running short
--   queue tasks (median completed run well under two minutes). outcome_utility
--   is therefore a sample of the Wren poller, not of the fleet, and nothing in
--   the schema said so until this migration.
--
-- WHY NOT OPTION (a), fleet-wide episode opening:
--   record_episode needs a matched open/close pair. poll_queue.py has one:
--   a task is claimed and it terminates. Atlas (Claude Desktop) and Iris
--   (Cowork) are interactive surfaces with no deterministic session-close
--   hook — a user closes a tab and the trace is simply never closed. That is
--   exactly the failure class migration 117's reaper was built to sweep up.
--   Reaped and failed episodes contribute 0 to utility by design (114), so
--   the likely outcome of (a) is more stranded traces and more reaper noise
--   in exchange for very little additional utility signal. Getting it right
--   would mean per-surface session lifecycle hooks — a build-out, not the
--   cheap fix this decision was scoped to. Revisit only if Atlas/Iris gain a
--   reliable session-end hook.
--
-- WHAT THE BIAS DOES AND DOES NOT DO (arXiv 2607.02579, correlated-trace
-- false promotion — a utility signal drawn from one agent is not fleet utility):
--   Does NOT: cause deletions. utility enters amac_standing_value() as a
--     strictly non-negative bonus in [0, 0.15] added after the /0.85
--     renormalization, so prune_decayed_memories() can still only ever delete
--     a subset of what it would delete at utility=0. Absent coverage costs a
--     memory a bonus; it never costs it its life.
--   DOES: skew RELATIVE ranking. A memory the poller consults often gets up to
--     +0.15 standing that an Iris- or Atlas-only memory of equal true value can
--     never earn, because no episode exists to earn it in. assign_memory_tiers()
--     reads that same standing, so poller-adjacent memories drift toward hot
--     and interactive-only memories stay relatively colder. Read outcome_utility
--     as "the Wren poller found this useful", never as "the fleet found this
--     useful", and do not use it as evidence when comparing two memories that
--     belong to different agents' working sets.
--
-- REVISIT IF: agent_episodes ever contains a non-wren agent. Then this comment
--   is stale and the caveat should be narrowed to the period it covers.

BEGIN;

COMMENT ON COLUMN memories.outcome_utility IS
  'A-MAC fifth term (migration 114). Saturating count of COMPLETED episodes that '
  'consulted this memory, normalized to [0,1]. Refreshed by '
  'refresh_memory_outcome_utility(). 0.0 = no outcome evidence, which scores '
  'identically to pre-114 behaviour. '
  'COVERAGE CAVEAT (migration 119, audited 2026-08-15): this term samples WREN '
  'POLLER RUNS ONLY. All 295 agent_episodes rows are agent=wren and only '
  'poll_queue.py opens episodes — Atlas and Iris have never opened one. So this '
  'is fleet-wide in name only. It cannot cause deletions (the term is a '
  'non-negative bonus applied after renormalization), but it DOES skew relative '
  'ranking and tiering toward memories the poller happens to consult. Never read '
  'a low value as "unused by the fleet" — read it as "no Wren poller episode '
  'consulted it". See migration 119 header for why fleet-wide episode opening '
  'was declined.';

COMMIT;
