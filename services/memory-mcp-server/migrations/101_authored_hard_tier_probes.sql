-- 101_authored_hard_tier_probes.sql
-- 2026-08-02 daily research, REC 2 (TIER 2).
--
-- ============================================================================
-- WHY — migration 096 built the tier and then said the tier was the problem
-- ============================================================================
-- 096 mined eval_run_results over ten days for probes whose mean gold_rank sits
-- in the 6-20 band and found exactly THREE. It wrote its own verdict into the
-- migration: "a statistically useful hard tier needs AUTHORED probes, not mined
-- ones." Today the tier is still hard:3 against core:89, and the last nightly
-- run scored n_hard=1 with hard_recall_at_5 = 0.0000 — a gate metric computed
-- over a single probe.
--
-- The reason mining came up empty IS the finding: gold sits at rank 1-5 (50/92
-- at rank 1) or is missed entirely. The middle is empty, so there is nothing for
-- a ranker change to move — which is why recall@5 was bit-identical to fifteen
-- decimal places across six consecutive runs.
--
-- ============================================================================
-- WHERE THESE COME FROM
-- ============================================================================
-- All 18 are drawn from the 697 ACTIVE rows the eval set has never touched
-- (95 of 792 active memories are referenced by any probe, as gold or forbidden).
-- Three deliberate shapes, per the research note:
--
--   1. MULTI-HOP — the answer needs two rows joined. Gold is BOTH; a run that
--      surfaces one and misses the other scores partial nDCG rather than a
--      binary hit, which is exactly the signal recall@5 throws away.
--   2. NEAR-DUPLICATE DISTRACTORS — drawn from measured 0.82-0.95 cosine
--      clusters in the live corpus: the four staleness-migration write-ups
--      (085 / 087 / 089-090 / the 62-not-389 correction), the four monthly
--      Research Digests, the SSH-access family, the two Cowork startup notes.
--      The sibling rows go in forbidden_memory_ids, so retrieving the
--      plausible-but-wrong one is SCORED, not merely unrewarded.
--   3. TEMPORALLY SUPERSEDED — where a later row corrects an earlier one and
--      the newer is right (087 scoped the view, 089/090 moved the exemption
--      into the predicate; the reranker model label correction).
--
-- Questions are adversarially paraphrased: they deliberately avoid their gold's
-- distinctive tokens ("Cowork", "gluetun", "point-in-time", migration numbers),
-- because probes written in the memory's own vocabulary are what saturated
-- scoreset v1 into returning identical numbers three runs running.
--
-- ============================================================================
-- FORBIDDEN-ID DISCIPLINE — two rules, both learned the hard way
-- ============================================================================
-- (a) Every forbidden id here is on an ACTIVE row. hybrid_recall filters
--     is_active on all six lanes, so an inactive forbidden id cannot be
--     retrieved and the probe cannot fail — that is how 9 of 11 forgetting
--     probes ended up structurally unfailable and FCFR read 0.0909 over a
--     vacuous denominator.
-- (b) Forbidden means WRONG, not merely similar. The `semantic:` distillation
--     twins of several of these rows carry the same fact, so returning one is
--     not an error and they are deliberately NOT listed as forbidden. They
--     still make the probes harder by competing for rank, which is the point.
--
-- Gold and forbidden are resolved BY NAME below, not by pasted UUID, and the
-- guard block aborts the migration if any name fails to resolve to exactly one
-- active row. A mistyped UUID would otherwise silently produce a probe with an
-- empty gold set that scores 0.0 forever and looks like a ranker regression.

begin;

-- ── Guard: every referenced memory must resolve to exactly one ACTIVE row ───
do $$
declare
  v_missing text;
begin
  with wanted(n) as (values
    ('podman-stale-running-state-hides-dead-container'),
    ('gluetun-zombie-up-but-pid-gone-kills-netns-stack'),
    ('dashboard_live_data_caching_and_prometheus_wedge'),
    ('guardian-audits-can-fire-against-superseded-attempts'),
    ('migration-ledger-is-truth-not-the-migrations-dir'),
    ('human-decision-gates-must-not-enter-the-agent-queue'),
    ('agent-bus-flag-semantics'),
    ('shared_agent_context'),
    ('shared-context-pattern'),
    ('stale-review-queue-scoped-to-standing-claims-migration-087'),
    ('staleness-exemption-lives-in-the-predicate-migrations-089-090'),
    ('stale-review-queue-derives-from-verified-at-migration-085'),
    ('stale-backlog-is-62-not-389-pit-flag-is-the-lever'),
    ('Research Digest - 2026-03'), ('Research Digest - 2026-04'),
    ('Research Digest - 2026-05'), ('Research Digest - 2026-06'),
    ('Cowork SSH Access to svc-podman-01'),
    ('Claude Desktop SSH Access to svc-podman-01'),
    ('Proxmox SSH Access'), ('HA VM SSH Access'),
    ('Cowork Startup Protocol — SSH key location'),
    ('Cowork Startup Protocol — Check Supabase First'),
    ('recall-weights-is-the-ranker-tuning-surface'),
    ('hybrid-recall-six-lanes-trust-is-a-weight'),
    ('CCR routines — what Iris triggers can and cannot reach'),
    ('ccr-trigger-prompts-are-readable-via-remotetrigger'),
    ('CCR Triggers — Breakthrough Watch + Daily Research'),
    ('task-queue-system'), ('task-queue-cowork-usage'),
    ('shelfmark-lives-in-downloads-stack-not-services-shelfmark'),
    ('reranker-is-bge-reranker-base-not-v2-m3'),
    ('skill-outcome-recording-ownership-split'),
    ('conflict-flagged-cleared-in-resolve-conflict'),
    ('claimed-tasks-can-still-be-double-worked')
  )
  select string_agg(w.n || ' (' || c || ')', '; ')
    into v_missing
  from (
    select w.n, count(m.id) c
    from wanted w left join public.memories m on m.name = w.n and m.is_active
    group by w.n
  ) w
  where w.c <> 1;

  if v_missing is not null then
    raise exception 'eval probe authoring aborted — these names do not resolve to exactly one ACTIVE memory: %', v_missing;
  end if;
end $$;

-- ── The probes ──────────────────────────────────────────────────────────────
with probe(question, topic_hint, category, failure_mode, gold_names, forbidden_names, notes) as (values

 -- 1-4: MULTI-HOP. Gold is two rows; surfacing one is a partial score.
 ('The container runtime insisted a workload was healthy while its process had already exited. What single check settles whether it is really alive, and which VPN-namespace stack went dark because of it?',
  'container reported up but process dead',
  'multi_hop', 'compound_fact',
  array['podman-stale-running-state-hides-dead-container','gluetun-zombie-up-but-pid-gone-kills-netns-stack'],
  array['dashboard_live_data_caching_and_prometheus_wedge'],
  'Two write-ups of the same 2026-08-01 incident, cosine 0.8535. The runtime-state note gives the liveness check, the namespace note names the four unreachable services. Forbidden row is a different "service up but not serving" write-up — plausible, wrong incident.'),

 ('A red audit says a job shipped broken SQL. Which two independent records do I reconcile before acting, so I do not act on a finding that describes an attempt already fixed?',
  'verify audit finding before acting',
  'multi_hop', 'compound_fact',
  array['guardian-audits-can-fire-against-superseded-attempts','migration-ledger-is-truth-not-the-migrations-dir'],
  array[]::text[],
  'Requires joining "audits attach to the queue row, not the attempt" with "query the ledger, not the directory". Both concern the same 076/077/078 episode from opposite ends.'),

 ('A request that exists only to get a yes-or-no out of the human keeps being picked up and executed anyway. Which routing field prevents that, and which marker should the bus use when nothing is expected back?',
  'human decision routing and awareness marker',
  'multi_hop', 'compound_fact',
  array['human-decision-gates-must-not-enter-the-agent-queue','agent-bus-flag-semantics'],
  array[]::text[],
  'Hop one: target must be jeff, not an agent target. Hop two: the Review flag is the informational one, Needs Jeff the actionable one. Neither row answers both halves.'),

 ('How do the three assistants keep one picture of in-flight work — where is the common record stored, and what is the discipline for reading and writing it?',
  'shared coordination record between agents',
  'multi_hop', 'compound_fact',
  array['shared_agent_context','shared-context-pattern'],
  array[]::text[],
  'The record itself and the protocol for using it are separate rows at cosine 0.87. Returning only one answers half the question.'),

 -- 5-8: NEAR-DUPLICATE DISTRACTORS in the staleness-migration cluster (0.89-0.93).
 ('Which change introduced the explicit immutability column and the log-series helper that has to be kept in step with a Python script''s collapse rules?',
  'immutability flag and log series helper',
  'single_hop', 'identifier_obfuscation',
  array['stale-review-queue-scoped-to-standing-claims-migration-087'],
  array['staleness-exemption-lives-in-the-predicate-migrations-089-090','stale-review-queue-derives-from-verified-at-migration-085'],
  'Four sibling write-ups at cosine 0.89-0.93 all discuss the same review listing. Only 087 shipped is_point_in_time + memory_is_log_series + the sync-memory.py pointer. Question avoids the tokens "point-in-time" and "087".'),

 ('Scoping the review listing was not enough — the nightly flagger and the recall discount still punished immutable history. Which work moved that exemption down into the shared predicate itself?',
  'exemption moved into the predicate',
  'temporal', 'temporal_categorization',
  array['staleness-exemption-lives-in-the-predicate-migrations-089-090'],
  array['stale-review-queue-scoped-to-standing-claims-migration-087','stale-review-queue-derives-from-verified-at-migration-085'],
  'Temporally superseded pair: 087 stopped at the VIEW, 089/090 fixed the predicate. The newer row is correct and the older is the attractive wrong answer, so 087 is forbidden.'),

 ('What was actually stopping the unverified backlog from ever falling, when successive passes kept reporting 381, then 396, then 392?',
  'backlog never falls write path dependency',
  'single_hop', 'identifier_obfuscation',
  array['stale-review-queue-derives-from-verified-at-migration-085'],
  array['stale-review-queue-scoped-to-standing-claims-migration-087','staleness-exemption-lives-in-the-predicate-migrations-089-090'],
  'The 381/396/392 sequence is unique to the 085 write-up. Siblings describe later fixes to the same subsystem.'),

 ('I have been handed a ticket claiming several hundred memories need re-verifying. Why is that headline figure misleading, and what should I re-derive the real number from?',
  're-derive inflated re-verification count',
  'single_hop', 'over_retrieval',
  array['stale-backlog-is-62-not-389-pit-flag-is-the-lever'],
  array['stale-review-queue-scoped-to-standing-claims-migration-087','stale-review-queue-derives-from-verified-at-migration-085','staleness-exemption-lives-in-the-predicate-migrations-089-090'],
  'All four siblings mention queue counts; only this one is the operator-facing "re-derive before working it" correction. The other three are forbidden precisely because they are the near-misses.'),

 -- 9-10: NEAR-DUPLICATE DISTRACTORS across the four monthly digests (0.89-0.93).
 ('Which monthly roll-up covers the stretch where reranking went live and Anthropic''s work on dreaming was flagged as seismic?',
  'monthly digest reranking dreaming',
  'temporal', 'temporal_categorization',
  array['Research Digest - 2026-05'],
  array['Research Digest - 2026-03','Research Digest - 2026-04','Research Digest - 2026-06'],
  'Four digests at cosine 0.89-0.93 with near-identical structure. Discriminating on episode content rather than month name is the whole test; the other three months are forbidden.'),

 ('In which monthly roll-up does the series finally diagnose its own repeated-recommendation problem from the inside?',
  'monthly digest names the drift loop',
  'temporal', 'temporal_categorization',
  array['Research Digest - 2026-06'],
  array['Research Digest - 2026-03','Research Digest - 2026-04','Research Digest - 2026-05'],
  'The 04 digest says the drift loop BEGINS and 06 says it is diagnosed in-line — a deliberately fine temporal distinction between two highly similar rows.'),

 -- 11-13: NEAR-DUPLICATE DISTRACTORS in the SSH / startup-protocol cluster.
 ('Which note covers reaching the Podman host from the Windows-side collaboration surface, as distinct from the desktop app, the hypervisor or the home-automation VM?',
  'ssh from collaboration surface to podman host',
  'single_hop', 'identifier_obfuscation',
  array['Cowork SSH Access to svc-podman-01'],
  array['Claude Desktop SSH Access to svc-podman-01','Proxmox SSH Access','HA VM SSH Access'],
  'Cowork vs Claude Desktop sit at cosine 0.9230 and name different keys for the same host. Question withholds the word "Cowork" so the ranker cannot win on an exact title match.'),

 ('Where does the Windows-side private key actually live on disk, and why does it have to be re-copied at the start of every session?',
  'windows key path recopied each session',
  'single_hop', 'compound_fact',
  array['Cowork Startup Protocol — SSH key location'],
  array['Cowork Startup Protocol — Check Supabase First','Cowork SSH Access to svc-podman-01','Claude Desktop SSH Access to svc-podman-01'],
  'Two startup-protocol rows share a name prefix; only one is about the key path and the resetting VM filesystem. Classic prefix collision against the sibling.'),

 ('One of the two startup-protocol notes is about what to query first rather than about credentials. Which one sets the priority-zero database check?',
  'priority zero startup database query',
  'single_hop', 'prefix_collision',
  array['Cowork Startup Protocol — Check Supabase First'],
  array['Cowork Startup Protocol — SSH key location'],
  'Deliberate inverse of the previous probe — same prefix, opposite gold. A ranker that keys on the shared prefix gets exactly one of the pair right.'),

 -- 14-15: NEAR-DUPLICATE DISTRACTORS in the recall-internals cluster (0.8754).
 ('If I want to change how much weight relevance carries in scoring, is that a schema change or a data change — and what caveat applies to reading the eval numbers afterwards?',
  'change relevance weight tuning surface',
  'env_gotcha', 'compound_fact',
  array['recall-weights-is-the-ranker-tuning-surface'],
  array['hybrid-recall-six-lanes-trust-is-a-weight'],
  'Both rows describe the same subsystem at cosine 0.8754. Only this one says tuning is an UPDATE to a table, not a migration, and carries the probe-set saturation caveat.'),

 ('How many independent scoring lanes does the fused retrieval path actually run, and is source reliability one of them or something applied on top?',
  'how many fusion lanes and where trust applies',
  'env_gotcha', 'compound_fact',
  array['hybrid-recall-six-lanes-trust-is-a-weight'],
  array['recall-weights-is-the-ranker-tuning-surface'],
  'Inverse of the previous probe. The discriminating fact is that trust is a WEIGHT, not a seventh lane — a distinction the sibling row does not make.'),

 -- 16: MULTI-HOP over the cloud-trigger cluster.
 ('Can the cloud-side scheduled agents reach services that only listen on the home network — and separately, is there any way to read their prompt bodies from the Podman host?',
  'cloud scheduled agents reachability and prompt access',
  'multi_hop', 'compound_fact',
  array['CCR routines — what Iris triggers can and cannot reach','ccr-trigger-prompts-are-readable-via-remotetrigger'],
  array['CCR Triggers — Breakthrough Watch + Daily Research'],
  'Two halves in two rows: the reachability limit and the "yes, readable, do not mark them unverifiable" correction. The forbidden row is the inventory of which triggers exist — same topic, answers neither half.'),

 -- 17: TEMPORALLY SUPERSEDED — a correction that must beat the thing it corrects.
 ('Which cross-encoder is actually serving the second-stage scoring, and what earlier label for that model turned out to be wrong?',
  'which cross encoder model is authoritative',
  'temporal', 'temporal_categorization',
  array['reranker-is-bge-reranker-base-not-v2-m3'],
  array['hybrid-recall-six-lanes-trust-is-a-weight','recall-weights-is-the-ranker-tuning-surface'],
  'The corpus contains the WRONG model label in older prose. The authoritative correction must outrank the general recall-internals rows that mention reranking in passing.'),

 -- 18: near-duplicate distractor across the task-queue pair (0.8423).
 ('Which record is the operational description of the cross-agent work queue itself, rather than the guidance for driving it from the Windows collaboration surface?',
  'work queue system versus usage guidance',
  'single_hop', 'identifier_obfuscation',
  array['task-queue-system'],
  array['task-queue-cowork-usage','claimed-tasks-can-still-be-double-worked'],
  'Two rows at cosine 0.8423 differing by audience, plus a third same-topic operational caveat. Only one is the system description.')

)
insert into public.eval_queries
  (question, topic_hint, gold_memory_ids, forbidden_memory_ids, category, failure_mode, tier, active, notes)
select
  p.question,
  p.topic_hint,
  (select array_agg(m.id) from public.memories m where m.name = any(p.gold_names) and m.is_active),
  coalesce((select array_agg(m.id) from public.memories m where m.name = any(p.forbidden_names) and m.is_active), '{}'::uuid[]),
  p.category,
  p.failure_mode,
  'hard',
  true,
  'AUTHORED hard-tier probe (migration 101, 2026-08-02 research REC 2). ' || p.notes
from probe p;

-- ── Post-condition: no probe may ship with an incomplete gold set ───────────
-- A probe whose gold array is shorter than the names it was authored from would
-- score against a partial answer key forever and read as a ranker regression.
do $$
declare v_bad integer;
begin
  select count(*) into v_bad
  from public.eval_queries
  where tier = 'hard' and active
    and (gold_memory_ids is null or array_length(gold_memory_ids, 1) is null);
  if v_bad > 0 then
    raise exception 'aborting: % hard probe(s) have an empty gold set', v_bad;
  end if;
end $$;

commit;
