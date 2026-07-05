-- 053: Allow 'supersedes' in memory_links relationship check.
--
-- Bug: supersede_memory() (migration 043) inserts a memory_links row with
-- relationship='supersedes', but memory_links_relationship_check only allowed
-- (related_to, supports, contradicts, precedes, causes, refines). Every
-- supersede_memory() call therefore raised a check violation and rolled back
-- the whole supersession — superseded_by stayed NULL fleet-wide (count was 0
-- as of 2026-07-04 despite the tool existing since v5.x). Found during the
-- 2026-07-04 research closeout while enforcing temporal supersession
-- (arXiv 2606.24535 governance hardening).

ALTER TABLE memory_links DROP CONSTRAINT memory_links_relationship_check;
ALTER TABLE memory_links ADD CONSTRAINT memory_links_relationship_check
  CHECK (relationship = ANY (ARRAY[
    'related_to'::text, 'supports'::text, 'contradicts'::text,
    'precedes'::text, 'causes'::text, 'refines'::text,
    'supersedes'::text
  ]));
