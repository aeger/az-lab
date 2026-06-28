# task_queue.context JSON Schema

`task_queue.context` is a freeform `jsonb` column today. This doc defines the typed shape per task type so cross-agent handoffs stay under ~500 tokens (per ICLR 2026 / multi-agent orchestration research).

## Conventions

- Top-level fields are reserved system metadata.
- Task-type-specific fields live under `payload` for forward compatibility.
- Times are ISO-8601 UTC. User-facing display happens at render time (MST per `timezone_display`).
- Memory/task references use UUIDs from the `memories` / `task_queue` tables — never inline copies.

## Reserved top-level fields

| Key              | Type     | Required | Purpose |
|------------------|----------|----------|---------|
| `task_type`      | string   | yes      | Discriminator. One of the types below. |
| `delegated_by`   | string   | yes      | Source agent (`wren`, `iris`, `atlas`, `volt`, `hermes`, `lumen`) or external system. |
| `priority_order` | string[] | no       | Ordered list of sub-step keys for multi-stage tasks. |
| `parent_task_id` | uuid     | no       | For sub-tasks created via `queue_blocked_task`. |
| `memory_refs`    | uuid[]   | no       | Memory rows the executor should consult first. |
| `expires_at`     | string   | no       | Hard deadline (ISO-8601 UTC). |
| `payload`        | object   | yes      | Task-type-specific body (schemas below). |

## Task types

### `research`
```json
{
  "task_type": "research",
  "delegated_by": "wren",
  "memory_refs": ["<uuid>"],
  "payload": {
    "topics": ["hybrid retrieval", "episodic memory"],
    "depth": "daily | weekly | one-shot",
    "output_memory_name": "Daily Self-Improvement Research - YYYY-MM-DD",
    "discord_channel": "claude-code"
  }
}
```

### `deploy`
```json
{
  "task_type": "deploy",
  "delegated_by": "wren",
  "payload": {
    "service": "memory-mcp-server",
    "version": "5.9.0",
    "host": "svc-podman-01",
    "compose_path": "~/azlab/services/memory-mcp-server",
    "diff_required": true,
    "rollback_ref": "<git sha>"
  }
}
```

### `triage`
```json
{
  "task_type": "triage",
  "delegated_by": "wren",
  "payload": {
    "source": "gmail | sentinel | discord",
    "ids": ["<external id>"],
    "rules_ref": "system_rules.email_triage_preferences"
  }
}
```

### `eval`
```json
{
  "task_type": "eval",
  "delegated_by": "wren",
  "payload": {
    "subject_task_id": "<uuid of task awaiting eval>",
    "evaluator": "iris",
    "criteria": ["correctness", "scope", "no_deception"]
  }
}
```

### `recommendation_review`
```json
{
  "task_type": "recommendation_review",
  "delegated_by": "claude-code",
  "memory_refs": ["<research memory uuid>"],
  "priority_order": ["rec-A", "rec-B", "rec-C"],
  "payload": {
    "research_memory": "Daily Self-Improvement Research - YYYY-MM-DD",
    "verify_before_implement": true
  }
}
```

### `incident`
```json
{
  "task_type": "incident",
  "delegated_by": "sentinel",
  "payload": {
    "service": "tei-reranker",
    "severity": "warn | error | critical",
    "symptom": "container unhealthy",
    "runbook_ref": "docs/runbooks/<file>.md"
  }
}
```

## Validation

- Writers SHOULD set `task_type` on every new row.
- Readers MUST treat unknown `task_type` values as `payload: opaque` — never reject.
- A future migration may add a CHECK constraint once the existing freeform rows are migrated.

## Migration plan

1. New rows from 2026-05-12 onward use this schema (writer convention).
2. Backfill freeform rows on demand via a one-shot script when their `task_type` becomes obvious.
3. After 30 days of compliant writes, consider a CHECK constraint requiring `task_type` and `payload`.
