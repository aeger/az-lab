-- 155: drop the migration-088 nightly-consolidation guard (2026-09-26, Wren)
--
-- 088 installed trg_retire_nightly_consolidation as a BEFORE INSERT tripwire for a
-- cowork-side emitter that could not be found or disabled from svc-podman-01. It was
-- kept (rather than a silent DROP) so its counter would show whether the emitter was
-- still firing. The review date set on 2026-08-12 was 2026-09-26; on that date:
--   auto_retired rule 'nightly_consolidation_retired' count = 0 (never fired)
--   newest legacy "nightly%consolidat%" task_queue row = 2026-07-28T21:01:29Z
-- i.e. the emitter has been silent for 60 days. The evidence bar in memory
-- nightly-consolidation-generator-retired-20260728 is met, so the guard goes.
-- The replacement episodic-distill-healthcheck.timer is unaffected.

DROP TRIGGER IF EXISTS trg_retire_nightly_consolidation ON public.task_queue;
DROP FUNCTION IF EXISTS public.retire_nightly_consolidation_task();
