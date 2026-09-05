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

---

## CORRECTION 2026-07-28 — the block above does NOT work on CCR routines

Applied by Atlas against task `9c6e07d3`. The Iris/cowork half of this document was wrong
about what the CCR surface can do, so the text above was adapted rather than pasted.

**Why.** Iris's "triggers" are claude.ai CCR routines, and they run in Anthropic's cloud —
not on the LAN. `memory-mcp.az-lab.dev` sits behind Traefik's `lan-allow@file` middleware.
No cloud routine can reach it, so `recall_skill` and `record_task_completion` are
permanently unavailable there. Verified by pulling all 6 routines: every one has only the
Supabase connector (the Morning brief also has Cloudflare/Drive/Gmail/Calendar/Brevo/CCR/
Vercel). None has memory-mcp, and attaching it would require exposing the memory server
publicly, which defeats the reason it is LAN-gated.

**What was applied instead** — same contract, Supabase SQL instead of MCP tools:

- lookup: `SELECT name, title, description, content FROM skills WHERE triggers && ARRAY[...]
  OR name ILIKE '%...%' ORDER BY COALESCE(success_count,0) - COALESCE(fail_count,0) DESC LIMIT 5;`
- record: `SELECT public.record_skill_outcome(p_skill_name := ..., p_success := ..., p_note := ...);`
  (migration 080; returns false on unknown skill name or null args, so a typo is detectable)

Plus the same do-not-double-count warning, worded for this surface: these routines must not
record outcomes for work they hand to Wren via `task_queue`, because `poll_queue.py` already
records Wren's own outcomes.

**Applied to 5 of 6 routines:**

| routine | id | cron |
|---|---|---|
| ai-memory-research | `trig_012pickAjxmifxbhMbCe95Em` | `0 9 * * *` |
| wren-constitution-auditor | `trig_01XxiAjRovaFSP5hJjYHckrj` | `0 17 * * 0` |
| weekly-rls-audit | `trig_01TkTz4WPk34iFrWvC6QD2GM` | `3 9 * * 1` |
| grimoire-sprint-1 | `trig_01QShELNAijg3Vkpy88jBoue` | `0 6 1 1 *` |
| grimoire-sprint-2 | `trig_01Uq9nF1M37Xv5Sibw89CCh7` | `0 6 1 1 *` |

Skipped **Morning brief** (`trig_01WRM1ZEqQ4woFfKELvXVBwp`) — personal daily briefing, touches
no az-lab skills, so the block would be dead weight.

**Two triggers named in the task do not exist.** There is no "breakthrough watch" and no
"doc mirroring" routine in the CCR list — same finding as `iris_trigger_prompt_diff.md`
recorded earlier. `breakthrough-watch` still lands rows in `task_queue` via
`recurring_key='breakthrough-watch'`, so something fires it from outside the CCR routine
list. Worth tracking down before assuming that path is covered.

**Editing routines programmatically:** use the `RemoteTrigger` tool (`/schedule` skill),
`action:"update"` with a body of `{job_config: {...}}`. Send the COMPLETE `job_config` —
nested merge is not supported — but top-level partial update works, so `mcp_connections`,
`cron_expression`, and `enabled` are preserved when you omit them. Verified on all 5.

**The Atlas half of this document is still correct as written** and was applied verbatim to
`C:\Users\almty\.claude\CLAUDE.md` (task `9ddc6965`). Atlas is on the LAN and reaches
memory-mcp directly over mcp-remote, so it really does have the MCP tools.
