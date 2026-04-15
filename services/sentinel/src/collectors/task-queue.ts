import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

export function createTaskQueueCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    const url = `${config.supabase.url}/rest/v1/task_queue?status=in.(pending,claimed,in_progress,failed,blocked)&order=updated_at.desc&limit=30`;
    const res = await fetch(url, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const tasks: any[] = await res.json() as any[];

    return tasks.map(task => {
      let severity: 'critical' | 'warning' | 'info' = 'info';
      let category = `task_${task.status}`;
      let title = task.title;
      let body = task.description?.slice(0, 300) || '';

      if (task.status === 'failed') {
        severity = 'critical';
        title = `Failed: ${task.title}`;
        body = task.error || task.description?.slice(0, 300) || '';
      } else if (task.status === 'blocked') {
        severity = 'warning';
        title = `Blocked: ${task.title}`;
      } else if (task.status === 'pending') {
        const ageMs = Date.now() - new Date(task.created_at).getTime();
        if (ageMs > 60 * 60 * 1000) { // stale > 1hr
          severity = 'warning';
          category = 'task_stale';
        }
      } else if (task.status === 'in_progress') {
        // in_progress tasks are informational unless very overdue
        const ageMs = Date.now() - new Date(task.updated_at || task.created_at).getTime();
        if (ageMs > 4 * 60 * 60 * 1000) { // stuck > 4hr
          severity = 'warning';
          category = 'task_stuck';
          title = `Stuck: ${task.title}`;
        }
      }

      return {
        id: uuidv4(),
        source: 'task_queue' as const,
        severity,
        urgency: 'medium',
        status: 'unread' as const,
        title,
        body,
        category,
        sourceId: task.id,
        metadata: {
          priority: task.priority,
          tags: task.tags,
          target: task.target,
          source_agent: task.source,
          task_status: task.status,
        },
        timestamp: task.updated_at || task.created_at,
        receivedAt: new Date().toISOString(),
      };
    });
  };
}
