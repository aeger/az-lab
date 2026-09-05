# az-task-queue-worker

Validating ingest + Cloudflare Queue consumer for the az-lab `task_queue`.

## Why

Legacy producers POSTed straight to Supabase with
`curl -sf .../rest/v1/task_queue &>/dev/null &`, which swallowed `NOT NULL`
rejections so completely that a null-`description` bug churned the Postgres log
invisibly for an unknown time (see memory
`project_taskqueue_null_description_hook_fix_20260708`). This Worker moves task
creation behind a queue that **validates at the boundary** and makes every
failure visible instead of silently dropping it.

## Flow

```
producer --POST /enqueue (x-ingest-secret)--> [validate] --> az-task-queue
                                                               |
                              consumer <--(batch of 10)--------+
                              [strict re-validate] --> Supabase REST insert
                              on failure: retry x3 --> az-task-queue-dlq
                                                        --> Discord alert + Observability
```

- `title` and `description` are enforced non-empty (description falls back to
  title) so the DB `NOT NULL` constraints can never be hit.
- Dead-lettered tasks are surfaced to Discord + Workers Observability, never lost.

## One-time setup (needs a Workers+Queues-scoped CF token or `wrangler login`)

```sh
npm install
# create the queues (or via dashboard):
npx wrangler queues create az-task-queue
npx wrangler queues create az-task-queue-dlq
# secrets:
npx wrangler secret put SUPABASE_SERVICE_KEY   # sb_secret_... (same as memory-mcp)
npx wrangler secret put INGEST_SECRET          # shared secret producers send in x-ingest-secret
npx wrangler secret put DISCORD_WEBHOOK        # claude-code webhook (optional, for DLQ alerts)
npx wrangler deploy
```

## Validate without deploying

```sh
npm install
npm run dry-run   # wrangler deploy --dry-run: bundles + validates config offline
```

## Producer migration (phased)

Point producers at `https://az-task-queue-worker.<subdomain>.workers.dev/enqueue`
with header `x-ingest-secret: <INGEST_SECRET>` and a JSON task body
(`{title, description, target?, source?, priority?, context?, tags?, goal_id?}`)
instead of writing to Supabase `task_queue` directly. Migrate one at a time;
first candidate: `~/.claude/hooks/transcript-on-stop.sh`.
