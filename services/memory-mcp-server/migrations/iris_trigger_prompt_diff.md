# Iris CCR Trigger Prompt Diff — Recurring Task Upsert

After migration 031 is applied, Iris's CCR triggers (breakthrough watch, daily AI memory research, etc.) need to switch from `INSERT` to `upsert_recurring_task()` so each fire updates the same canonical task_queue row instead of creating a duplicate.

This file contains the exact text to change in each trigger prompt on the cowork (claude.ai) side.

---

## 1. Daily AI Memory Research trigger (`trig_012pickAjxmifxbhMbCe95Em`)

**Find** Step 4 in the prompt:
```sql
INSERT INTO task_queue (title, description, context, priority, source, target, tags)
VALUES (
  'Deliver Discord notification: AI Memory Research ' || to_char(now(), 'YYYY-MM-DD'),
  'Wren: POST the pre-written message ...',
  jsonb_build_object('method','POST','webhook_url','...','message','<MSG>',...),
  2, 'claude-code', 'wren',
  ARRAY['ai-memory-research','discord','notification','delegated']
);
```

**Replace with:**
```sql
SELECT public.upsert_recurring_task(
  p_recurring_key := 'daily-ai-memory-research',
  p_title         := 'Deliver Discord notification: AI Memory Research',
  p_description   := 'Wren: POST the pre-written message from context.message to Discord #claude-code via agent-bus send_discord. Just deliver as-is.',
  p_context       := jsonb_build_object(
    'discord_channel', 'claude-code',
    'message',         '<YOUR_FORMATTED_MESSAGE>',
    'delegated_by',    'claude-code',
    'research_date',   to_char(now(), 'YYYY-MM-DD')
  ),
  p_priority      := 2,
  p_target        := 'wren',
  p_source        := 'cowork',
  p_tags          := ARRAY['ai-memory-research','discord','notification','recurring']
);
```

Two key differences:
- Title is now stable (`Deliver Discord notification: AI Memory Research` — no date suffix). The date lives in `context.research_date` and `last_run_at`.
- Channel is `claude-code` (name, not ID `1012721652049657896`). This kills the Guardian DECEPTION flag at the source.

---

## 2. Tech Breakthrough Watch trigger

(if it lives in your CCR list — I couldn't find it from my side, so it's either deleted-but-still-firing-from-elsewhere or it's named differently in your account)

**Find** the INSERT into task_queue and **replace with:**
```sql
SELECT public.upsert_recurring_task(
  p_recurring_key := 'breakthrough-watch',
  p_title         := 'Send breakthrough alert to Discord',
  p_description   := 'Wren: deliver the pre-composed breakthrough alert from context.message to #claude-code via agent-bus send_discord.',
  p_context       := jsonb_build_object(
    'discord_channel', 'claude-code',
    'message',         '<YOUR_BREAKTHROUGH_ALERT>',
    'delegated_by',    'cowork'
  ),
  p_priority      := 1,
  p_target        := 'wren',
  p_source        := 'cowork',
  p_tags          := ARRAY['breakthrough-watch','discord','recurring']
);
```

Plus add a 7-day dedup gate **before** the upsert:
```
Before composing the alert, run:
  SELECT name, content FROM memories
  WHERE (tags @> ARRAY['breakthrough'] OR tags @> ARRAY['daily-research'])
    AND created_at > now() - interval '7 days'
  ORDER BY created_at DESC LIMIT 20;

Extract the model/product names already announced in those memories.
If today's findings are entirely a SUBSET of those names, post NOTHING — exit silently and skip the upsert.
Only proceed with the upsert if at least ONE finding is genuinely new in the past 7 days.
After upserting, save the alert as a memory with tags=['breakthrough','daily-research'] so the next run sees it.
```

---

## 3. Weekly RLS Audit trigger (`trig_01TkTz4WPk34iFrWvC6QD2GM`)

**Find** the Discord-notify INSERT in Step 3 of the prompt:
```sql
INSERT INTO public.task_queue (id, status, priority, assignee, title, description, source, channel, metadata) VALUES (...);
```

**Replace with:**
```sql
SELECT public.upsert_recurring_task(
  p_recurring_key := 'weekly-rls-audit',
  p_title         := 'Discord notify: weekly RLS audit',
  p_description   := 'Post to Discord #claude-code: <RESULT_MESSAGE>',
  p_context       := jsonb_build_object(
    'discord_channel', 'claude-code',
    'message',         '<RESULT_MESSAGE>'
  ),
  p_priority      := 3,
  p_target        := 'wren',
  p_source        := 'weekly-rls-audit',
  p_tags          := ARRAY['rls-audit','discord','recurring']
);
```

---

## 4. Weekly Constitution Audit trigger (`trig_01XxiAjRovaFSP5hJjYHckrj`)

**Find** Step 8 (both branches — PASS and ISSUES FOUND).

**Replace** the PASS branch INSERT with:
```sql
SELECT public.upsert_recurring_task(
  p_recurring_key := 'weekly-constitution-audit',
  p_title         := 'Discord: Weekly constitution audit',
  p_description   := 'Post the constitution audit summary to Discord #claude-code',
  p_context       := jsonb_build_object(
    'discord_channel', 'claude-code',
    'message',         '✅ **Weekly Constitution Audit — PASS** | All 7 principles verified for past 7 days. ...',
    'verdict',         'pass'
  ),
  p_priority      := 3,
  p_target        := 'wren',
  p_source        := 'wren-constitution-auditor',
  p_tags          := ARRAY['constitution','audit','discord','recurring']
);
```

**Replace** the ISSUES FOUND branch with the same `upsert_recurring_task` call but `verdict := 'fail'`, `priority := 1`, and the alert message in `message`. Same recurring_key — fail/pass states overwrite each other (the latest verdict is the canonical one; `runs[]` keeps history).

---

## Why the same `recurring_key` for pass/fail of the constitution audit?

Because the dashboard groups by `recurring_key`. If pass and fail used different keys, the UI would show them as two unrelated tasks. With one canonical row, the user sees:
- Last run: 2026-04-30 — verdict=fail
- Run history: prev fires with their verdicts in `runs[]`
- Status: `ready` if a new run hasn't been claimed yet, `completed` if it has

If a run with verdict=fail comes in, the latest entry in `runs[]` shows `'verdict':'fail'` so the UI can color it red. Status alone reflects whether the most recent fire has been processed.

---

## After applying these patches

1. Apply migration `031_task_queue_recurrence.sql` first (creates the columns + RPCs)
2. Apply migration `032_backfill_recurring_dupes.sql` (collapses existing duplicates)
3. Update each trigger prompt above
4. Wait for next fire cycle to verify
5. Smoke test in the dashboard lab page — the recurring rows should show with `↻ last run Xm ago` and a History panel listing all past fires.

If something breaks, the legacy `INSERT` path still works — `upsert_recurring_task` is just a stored function and not used elsewhere yet, so reverting any single trigger is safe.
