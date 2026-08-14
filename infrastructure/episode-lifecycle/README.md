# Episode lifecycle sweep

Keeps `agent_episodes` — the lab's agent-trace primitive — from accumulating
traces that never terminate.

## The defect this closes

On **2026-08-14**, 109 of 287 `agent_episodes` rows (**38%**) were
`status='in_progress'` with a NULL `ended_at`. The oldest had been open since
2026-05-24. Nothing counted them, so the leak was invisible for three months.

That blocked two things tracked separately:

- **A-MAC outcome-utility** — `refresh_memory_outcome_utility()` (migration 114a)
  counts consults only on episodes with `status='completed'`. An episode with no
  terminal status yields no outcome edge.
- **OWASP ASI06 layers 4–5** (behavioral monitoring, post-hoc forensics), carried
  as Tier 3 since correction v12. The OWASP Top 10 for Agentic Applications 2026
  frames observability as trace IDs following a task across agents and tools plus
  replay of recorded runs. `agent_episodes` *is* that primitive here, and 38% of
  its traces were open-ended.

These were never two builds. Episode closure is the precondition for both.

## Two causes, two fixes

**Cause 1 — rejected close-out (fixed by migration 116).**
`poll_queue.py` called `end_episode(episode_id, "pending_eval")` and
`"pending_jeff_action"` — `task_queue` statuses passed into a column constrained
to `('in_progress','completed','failed','partial')`. Every such PATCH was
rejected `23514` and swallowed by `end_episode`'s best-effort `except`:

```
Aug 13 16:25:26 claude-queue-poll[1832574]: HTTP 400 on PATCH agent_episodes
  ...violates check constraint "agent_episodes_status_check"
Aug 13 16:25:26 claude-queue-poll[1832574]: end_episode failed (non-fatal): HTTP Error 400
```

The whole PATCH is atomic, so `status`, `ended_at`, `summary` **and** `outcome`
were lost together — which is why all 109 stranded rows were empty shells.
Migration 116 maps the gate statuses onto `partial` at the writer and backfilled
the stranded rows.

**Cause 2 — no close-out at all (this directory, migration 117).**
`start_episode()` opens the row over PostgREST (`poll_queue.py:708`) and nothing
else owns it. If the poller is SIGKILLed, the host reboots mid-task, `run_claude`'s
timeout takes the parent down, or `systemctl --user stop` lands between
`start_episode()` and `end_episode()`, there is no PATCH to fix because there is
no PATCH. Migration 116 cannot reach this class, and its backfill is a one-shot
`UPDATE` inside a migration — it closed 2026-08-14's rows and then never runs
again. This sweep makes the same predicate continuous.

## What runs

| Unit | Cadence | Does |
|---|---|---|
| `episode-lifecycle-sweep.timer` | hourly at `:37` | calls `reap_stale_episodes()`, reads `agent_episode_health`, alerts on change |

`episode_lifecycle_sweep.py` always **exits 0** — a findings script must not also
present as a broken systemd unit (same convention as `container_health_audit.py`
and `tier0-probe.service`). Alerts route through the canonical agent-bus notifier
and fire only on a **change in finding kind**, so a steady state does not repost
every hour.

## Migration 117 surface

```sql
SELECT * FROM reap_stale_episodes('6 hours', true);  -- dry run, no writes
SELECT * FROM agent_episode_health;                  -- one-row alertable summary
```

`agent_episode_health` exposes `open_total`, `open_stale`, `oldest_open_hours`,
`abandoned_24h`, `abandoned_total`, `episodes_total`, `open_fraction`.
`open_fraction` is the headline number this work was opened against: **0.38** on
2026-08-14.

## Two decisions worth keeping

**Why 6 hours.** Measured across the 178 episodes that have ever reached
`ended_at`: p50 1.4 min, p90 7.2 min, p99 24.8 min, max 26.7 min. No episode in
the table's history has ever legitimately stayed open past 27 minutes. 6h is ~14x
p99 — and it is the *same window* `attach_episode_consults()` (migration 116)
trusts when it resolves "the newest open episode for this agent". A stale
`in_progress` row is not inert: it stays the newest open episode until something
closes it, so it silently captures another run's consults. Reaping at the same
6h boundary means the two agree by construction rather than by coincidence.

**Why `abandoned` and not `partial`.** Migration 116 reasoned that a task-queue
status has no business in the episode enum, and that stands — `abandoned` is a
genuine episode lifecycle outcome, not a task_queue status. It carries
information `partial` would destroy:

- `partial` (116) → the run finished; we know its close-out was rejected.
- `abandoned` (117) → we do **not** know what happened to this run.

Conflating them would make the replay story lie about which traces are
trustworthy. Neither status enters `refresh_memory_outcome_utility()`, which is
correct: an abandoned episode has no outcome, so it must not grant utility.

`ended_at` is stamped at `greatest(started_at, updated_at)` — the last moment
there is evidence the run was alive — not `now()`. Using `now()` would claim the
episode ran until the reaper fired and make every duration metric derived from
`ended_at` wrong by up to 6 hours.

The reap predicate keys on `greatest(started_at, updated_at)` for the same
reason it matters upstream: `attach_episode_consults()` bumps `updated_at` on
every recall it lands, so a genuinely long-running task that is still recalling
keeps its row alive. Keying on `started_at` alone would have killed exactly the
runs working hardest.

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `EPISODE_STALE_THRESHOLD` | `6 hours` | idle time before an open episode is reaped |
| `EPISODE_OPEN_ALERT_FLOOR` | `8` | open-episode count above which "open" means "leaking" |
| `SUPABASE_ENV_FILE` | `~/azlab/services/memory-mcp-server/.env` | credential source |
