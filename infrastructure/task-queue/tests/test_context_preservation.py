#!/usr/bin/env python3
"""Regression: a retried task must keep its full context payload.

Filed 2026-08-30. The 08-30 breakthrough-watch run reached the agent with
context.discord_channel missing because _sanitize_context's size cap evicted it
to make room for the injected _retry_hint. Every Discord-delivery recurring task
carries its pre-composed body in context.message and its destination in
context.discord_channel, so an evicted key turns a retry into a silent no-op.

Stdlib only (no pytest on svc-podman-01):
    python3 -m unittest discover -s infrastructure/task-queue/tests
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import poll_queue as pq  # noqa: E402


def delivery_context(body_len):
    """A real Discord-delivery context, shaped like task 84fc347c.

    The body deliberately carries an emoji and newlines: build_prompt embeds the
    context as JSON, so a plain-ASCII body would compare equal to its own escaped
    form and let a regression slip through.
    """
    head = "\u1F6A8 **Tech Breakthrough Watch \u2014 2026-08-30**\n\n"
    return {
        "message": head + "B" * max(body_len - len(head), 0),
        "delegated_by": "iris",
        "discord_channel": "claude-code",
    }


class RetryPreservesDeliveryPayload(unittest.TestCase):

    def _assert_payload_intact(self, ctx, out):
        self.assertIn("message", out, "context.message was dropped")
        self.assertIn("discord_channel", out, "context.discord_channel was dropped")
        self.assertEqual(ctx["message"], out["message"], "message was altered")
        self.assertEqual(ctx["discord_channel"], out["discord_channel"])

    def test_first_attempt_is_intact(self):
        ctx = delivery_context(2683)
        self._assert_payload_intact(ctx, pq._sanitize_context(ctx, 0, None))

    def test_retry_round_trip_keeps_message_and_channel(self):
        """The exact 08-30 failure: attempt 1 fits, attempt 2 overflows the cap."""
        ctx = delivery_context(2683)
        out = pq._sanitize_context(ctx, 1, "stdout stalled after 1800s")
        self._assert_payload_intact(ctx, out)
        self.assertIn("_retry_hint", out, "retry hint must still be injected")

    def test_retry_keeps_payload_when_body_alone_exceeds_the_cap(self):
        """Payload larger than _CONTEXT_MAX_CHARS is kept, not clipped."""
        ctx = delivery_context(pq._CONTEXT_MAX_CHARS + 2000)
        out = pq._sanitize_context(ctx, 2, "exit code 1")
        self._assert_payload_intact(ctx, out)

    def test_retry_still_evicts_non_payload_bloat(self):
        """The size cap must keep working on keys that are not the payload."""
        ctx = delivery_context(1200)
        ctx["scratch_notes"] = "N" * 4000
        out = pq._sanitize_context(ctx, 1, "boom")
        self._assert_payload_intact(ctx, out)
        self.assertNotIn("scratch_notes", out, "non-payload bloat should still be evicted")

    def test_haiku_compression_never_swallows_the_payload(self):
        """Above _CONTEXT_COMPRESS_THRESHOLD the lossy path must skip payload keys."""
        ctx = delivery_context(2000)
        ctx["verbose_findings"] = "F" * 8000
        with mock.patch.object(pq, "_compress_via_haiku",
                               return_value="[compressed]") as compressor:
            out = pq._sanitize_context(ctx, 1, "boom")
        compressor.assert_called_once()
        self.assertNotIn("message", compressor.call_args.args[0],
                         "message must never be handed to the compressor")
        self._assert_payload_intact(ctx, out)

    def test_build_prompt_carries_the_payload_through_on_retry(self):
        """End-to-end: the prompt the retried agent actually receives."""
        ctx = delivery_context(2683)
        task = {
            "id": "84fc347c-141d-4694-bfb2-9e28f2bdfaa2",
            "title": "Send breakthrough alert to Discord",
            "description": "Post the composed alert body to Discord.",
            "context": ctx,
            "attempt_count": 1,
            "error": "attempt 1/3: stdout stalled after 1800s",
        }
        prompt = pq.build_prompt(task)
        # build_prompt renders context via json.dumps, so match the escaped body.
        escaped_body = json.dumps(ctx["message"])[1:-1]
        self.assertIn(escaped_body, prompt, "message did not survive build_prompt")
        self.assertIn('"discord_channel": "claude-code"', prompt,
                      "discord_channel did not survive build_prompt")
        self.assertIn("RETRY ATTEMPT 2", prompt)

    def test_strip_keys_still_apply(self):
        ctx = delivery_context(500)
        ctx["full_transcript"] = "T" * 500
        out = pq._sanitize_context(ctx, 1, None)
        self.assertNotIn("full_transcript", out)
        self._assert_payload_intact(ctx, out)


class SanitizeIsNonDestructive(unittest.TestCase):
    def test_input_context_is_not_mutated(self):
        ctx = delivery_context(pq._CONTEXT_MAX_CHARS + 500)
        before = json.dumps(ctx, sort_keys=True)
        pq._sanitize_context(ctx, 3, "boom")
        self.assertEqual(before, json.dumps(ctx, sort_keys=True),
                         "_sanitize_context mutated the caller's context dict")


if __name__ == "__main__":
    unittest.main(verbosity=2)
