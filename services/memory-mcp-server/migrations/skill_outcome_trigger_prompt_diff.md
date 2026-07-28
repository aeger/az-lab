# Skill Outcome Loop — Trigger Prompt Diff (Atlas / Iris)

**Origin:** daily self-improvement research 2026-07-25, T2 ("close the skill outcome loop").
**Companion change:** migration `080_record_skill_outcome_rpc.sql` + `infrastructure/task-queue/poll_queue.py`.

## The problem this closes

As of 2026-07-28 the `skills` table held 27 rows. Exactly **one** had a non-zero
`success_count`/`fail_count`; exactly **one** had `last_used_at` set. The server code is
correct and needs no change — `record_task_completion` writes the counters
(`src/index.ts:2266-2273`) and `recall_skill` stamps `last_used_at` (`:2358/:2367/:2376`).
The tools were simply never invoked. Skill quality data that only accrues when an agent
remembers to log it does not accrue.

## Who records what — read this before editing any prompt

Outcome recording is now split by surface, and **the two paths must not overlap**, or the
counters double-count and the signal is worse than useless:

| Surface | Runs under | Who records the outcome |
|---|---|---|
| **Wren** (svc-podman-01) | `poll_queue.py` | **The poller, automatically.** No prompt change needed — already shipped. |
| **Atlas** (Claude Desktop) | no poller | **The agent**, via `record_task_completion`. Needs the prompt below. |
| **Iris** (cowork / claude.ai) | no poller | **The agent**, via `record_task_completion`. Needs the prompt below. |

Wren's task prompt (`build_prompt`) now emits a skill hint that explicitly tells it *not*
to pass `skill_name`/`success`, precisely to avoid double-counting against the poller.
**Do not** copy the Atlas/Iris text below into any Wren-side prompt.

## Text to add — Atlas and Iris trigger prompts (cowork side)

Append to the standing instructions of each CCR trigger that performs real work
(breakthrough watch, daily AI memory research, weekly audits, doc mirroring):

```markdown
### Skills — use them and score them

Before starting the work: call `recall_skill(query: "<what you are about to do>")`.
If a skill comes back and fits, follow it. If nothing fits, proceed normally.

After finishing: call `record_task_completion` with:
- `task_summary` — one line on what you did
- `tool_count` — roughly how many tool calls you made
- `skill_name` — the skill you actually used (omit entirely if you used none)
- `success` — `true` if the task achieved its goal, `false` if it did not

Pass `skill_name` and `success` **together or not at all** — the counters only move when
both are present. Score `success` on whether the *outcome* was right, not on whether you
produced output. A skill that keeps returning `false` is the signal the monthly refine
pass looks for; scoring everything `true` makes the whole loop worthless.
```

## Follow-on (deferred, per the research)

Once ~20+ outcomes have accrued across the fleet, run a monthly refine pass over skills
where `fail_count > success_count`, per the EvoSkill generate-verify-refine loop
(arXiv 2606.23127). Do not build this before the data exists — there is nothing to refine
against yet.

Query to check whether the loop is producing signal:

```sql
SELECT name, success_count, fail_count, last_used_at, left(last_outcome, 60) AS last_outcome
FROM skills
WHERE COALESCE(success_count,0) + COALESCE(fail_count,0) > 0
ORDER BY (COALESCE(success_count,0) + COALESCE(fail_count,0)) DESC;
```
