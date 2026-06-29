import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

const TARGETS = ['atlas', 'any', 'jeff'] as const;
const STATUSES = ['ready', 'pending'] as const;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SeenEntry {
  category: string;
  emittedAt: number;
  lastStatus: string;
}

const seen = new Map<string, SeenEntry>();
let bootstrapped = false;

async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  const key = config.supabase.serviceKey || config.supabase.anonKey;
  if (!config.supabase.url || !key) return;
  const since = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const url = `${config.supabase.url}/rest/v1/sentinel_notifications`
    + `?category=like.atlas_task_%25`
    + `&received_at=gte.${encodeURIComponent(since)}`
    + `&select=source_id,category,received_at`;
  try {
    const res = await fetch(url, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return;
    const rows = await res.json() as Array<{ source_id: string; category: string; received_at: string }>;
    for (const r of rows) {
      const status = r.category.replace(/^atlas_task_/, '');
      const t = new Date(r.received_at).getTime();
      const prev = seen.get(r.source_id);
      if (!prev || prev.emittedAt < t) {
        seen.set(r.source_id, { category: r.category, emittedAt: t, lastStatus: status });
      }
    }
    console.log(`[atlas-tasks] bootstrap: loaded ${rows.length} prior notifications into seen map`);
  } catch (err: any) {
    console.warn(`[atlas-tasks] bootstrap failed: ${err.message}`);
  }
}

export function createAtlasTaskCollector() {
  return async (): Promise<SentinelNotification[]> => {
    await bootstrap();

    const key = config.supabase.serviceKey || config.supabase.anonKey;
    const url = `${config.supabase.url}/rest/v1/task_queue`
      + `?target=in.(${TARGETS.join(',')})`
      + `&status=in.(${STATUSES.join(',')})`
      + `&archived_at=is.null`
      + `&order=created_at.desc&limit=50`;

    const res = await fetch(url, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const tasks = await res.json() as any[];

    const out: SentinelNotification[] = [];
    const now = Date.now();
    const cutoff = now - DEDUP_WINDOW_MS;

    for (const task of tasks) {
      const status = String(task.status);
      const category = `atlas_task_${status}`;
      const prev = seen.get(task.id);

      // Gate: emit on first sight, or on transition into 'ready' (outside dedup window or different category)
      let shouldEmit = false;
      if (!prev) {
        shouldEmit = true;
      } else if (status === 'ready' && prev.lastStatus !== 'ready') {
        if (prev.category !== category || prev.emittedAt < cutoff) shouldEmit = true;
      }

      if (!shouldEmit) {
        if (prev) prev.lastStatus = status;
        continue;
      }

      const severity: 'critical' | 'warning' | 'info' =
        (task.priority ?? 99) <= 1 ? 'critical'
        : task.priority === 2 ? 'warning'
        : 'info';

      const body = [
        `**Task:** ${task.title}`,
        `**ID:** \`${task.id}\``,
        `**Source:** ${task.source ?? 'unknown'}`,
        `**Priority:** ${task.priority ?? 'n/a'}`,
        `**Target:** ${task.target}`,
        task.description ? '' : null,
        task.description ? String(task.description).slice(0, 300) : null,
      ].filter(Boolean).join('\n');

      out.push({
        id: uuidv4(),
        source: 'task_queue',
        severity,
        urgency: 'medium',
        status: 'unread',
        title: `Atlas task ${status}: ${task.title}`,
        body,
        category,
        sourceId: task.id,
        metadata: {
          atlas_notify: true,
          task_id: task.id,
          target_agent: task.target,
          source_agent: task.source,
          priority: task.priority,
          task_status: status,
          tags: task.tags,
        },
        timestamp: task.updated_at || task.created_at,
        receivedAt: new Date().toISOString(),
      });

      seen.set(task.id, { category, emittedAt: now, lastStatus: status });
    }

    return out;
  };
}
