#!/usr/bin/env python3
"""Regression: the Jeff-note safety net must fire on real notes, stay quiet otherwise.

Filed 2026-09-06, after the net missed the most important note of the week.

`note_to_jeff_from_result()` is the fallback that lifts Jeff-directed passages out
of a finished task's result when the agent forgot the explicit `>>JEFF:` marker.
Its first cue list contained "your call on". The real text was:

    Left open -- deliberately, and it's your call

    The 14 remaining are read-only, but they're still SECURITY DEFINER, so they
    bypass RLS and disclose data to the unauthenticated publishable key.

"your call" followed by a newline does not contain "your call on", so a SECURITY
decision gate -- migration 150 -- was never surfaced. Two trailing words in a cue
silently defeated the entire mechanism, and nothing anywhere reported a problem.

The lesson encoded here: for this net, a false positive costs Jeff one dismissal;
a false negative costs him a decision he never learns exists. Cues stay SHORT.

Every REAL sample below is real text recovered from task_queue, not invented.

Stdlib only (no pytest on svc-podman-01):
    python3 -m unittest discover -s infrastructure/task-queue/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import poll_queue as pq  # noqa: E402


# Real Jeff-directed results, keyed by the task they came from.
REAL_NOTES = {
    "86bb3e5a": (
        "Migration 149 applied. 36 writer functions locked.\n\n"
        "Left open — deliberately, and it's your call\n\n"
        "The 14 remaining are read-only, but they're still SECURITY DEFINER, so "
        "they bypass RLS and disclose data to the unauthenticated publishable key."
    ),
    "cb704f7f": (
        "Task complete. Everything else untouched.\n\n"
        "## Two things worth your attention\n\n"
        "The routine's query spec isn't stored anywhere on this host."
    ),
    "c5f44d04": (
        "Fixed the timeout. Committed.\n\n"
        "The top-k LATERAL fix is a semantic change and was out of scope here — "
        "it needs your call on k when the time comes."
    ),
    "33b8476d": (
        "Appended the recurrence to the WAN-outage memory.\n\n"
        "**Two things for you, Jeff:**\n\n"
        "1. Stale kill switch left active: 9fe85f82 has been active for 17.6 hours."
    ),
    "ea639a95": (
        "Done.\n\nTwo things for you:\n\n"
        "1. The shelfmark orphan dir has been flagged for deletion since "
        "2026-08-01 — 31 days awaiting your OK."
    ),
    "aa984653": (
        "Queue task marked completed.\n\n"
        "One thing worth your call: the aliasheadersstrategy flags are committed "
        "to beta but not merged to main. Say the word and I'll open the merge."
    ),
    "69621087": (
        "Ledger untouched.\n\n## Two things you should know\n\n"
        "1. Residual hole I deliberately did not fix. add_memory_link defaults "
        "strength 1.0 and validates only the target."
    ),
}

# The explicit marker path must win outright and strip the marker itself.
EXPLICIT = (
    "Did the work, all green.\n\n"
    ">>JEFF: The cert expires in 3 days and renewal needs your DNS token.\n\n"
    "Other narration that should not be picked up."
)

# Ordinary completion narration. None of this is addressed to anyone.
BENIGN = {
    "restart": (
        "Reviewed the logs and restarted the service.\n\n"
        "The container came back healthy. I verified the routes and everything "
        "resolves. No further action needed."
    ),
    "migration": (
        "Migration applied cleanly.\n\n"
        "All 36 functions locked. Verified with a count query. Nothing else changed."
    ),
    "narrative": (
        "I called the API and parsed the response.\n\n"
        "The values matched expectations, so I moved on to the next step."
    ),
}


class TestJeffNoteCues(unittest.TestCase):
    def test_real_notes_all_fire(self):
        """Every genuine Jeff-directed result must yield at least one block."""
        for task_id, text in REAL_NOTES.items():
            with self.subTest(task=task_id):
                blocks = pq._extract_jeff_blocks(text)
                self.assertTrue(
                    blocks,
                    f"task {task_id}: Jeff-directed note was NOT extracted. A miss "
                    f"here is a decision Jeff never learns exists.",
                )

    def test_the_migration_150_miss(self):
        """The specific text that defeated the first cue list.

        Guards the exact regression: a cue long enough to require trailing words
        ("your call on") skips "it's your call" at the end of a line.
        """
        blocks = pq._extract_jeff_blocks(REAL_NOTES["86bb3e5a"])
        self.assertTrue(blocks, "migration 150 security gate must be extracted")
        joined = " ".join(blocks).lower()
        self.assertIn("security definer", joined,
                      "the extracted block must carry the substance, not just the cue line")

    def test_explicit_marker_wins_and_is_stripped(self):
        blocks = pq._extract_jeff_blocks(EXPLICIT)
        self.assertEqual(len(blocks), 1, "explicit >>JEFF: block should win outright")
        self.assertNotIn(">>JEFF:", blocks[0], "the marker itself must be stripped")
        self.assertIn("cert expires", blocks[0])
        self.assertNotIn("should not be picked up", blocks[0])

    def test_benign_narration_stays_silent(self):
        """Ordinary completion text must not mint notes, or the lane becomes noise."""
        for name, text in BENIGN.items():
            with self.subTest(sample=name):
                self.assertEqual(
                    pq._extract_jeff_blocks(text), [],
                    f"{name}: benign narration must not be treated as a note",
                )

    def test_cues_are_short_enough_to_match_real_prose(self):
        """A cue needing 4+ words is how the migration 150 miss happened."""
        for cue in pq._JEFF_CUES:
            with self.subTest(cue=cue):
                self.assertLessEqual(
                    len(cue.split()), 4,
                    f"cue {cue!r} is too specific to survive real phrasing",
                )

    def test_empty_and_none_are_safe(self):
        self.assertEqual(pq._extract_jeff_blocks(""), [])
        self.assertEqual(pq._extract_jeff_blocks(None), [])

    def test_block_cap_is_respected(self):
        """A pathological result must not mint a wall of notes."""
        text = "\n\n".join(f"Item {i}: this one is your call." for i in range(20))
        self.assertLessEqual(len(pq._extract_jeff_blocks(text)), pq._NOTE_MAX_BLOCKS)


if __name__ == "__main__":
    unittest.main()
