import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

// Check goals that have been stale or blocked for too long
export function createGoalsCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const key = config.supabase.serviceKey || config.supabase.anonKey;

    // Fetch active/blocked goals
    const url = `${config.supabase.url}/rest/v1/goals?status=in.(active,blocked)&order=updated_at.asc&limit=50`;
    const res = await fetch(url, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const goals: any[] = await res.json() as any[];

    const notifications: SentinelNotification[] = [];
    const now = Date.now();

    for (const goal of goals) {
      const updatedAt = new Date(goal.updated_at).getTime();
      const staleDays = (now - updatedAt) / (1000 * 60 * 60 * 24);

      if (goal.status === 'blocked') {
        notifications.push({
          id: uuidv4(),
          source: 'services',
          severity: 'warning',
          urgency: 'medium',
          status: 'unread',
          title: `Blocked Goal: ${goal.title}`,
          body: goal.notes || `Goal "${goal.title}" has been blocked. Review and unblock.`,
          category: 'goal_blocked',
          sourceId: `goal:${goal.id}`,
          metadata: { goal_id: goal.id, title: goal.title, type: goal.type, priority: goal.priority },
          timestamp: goal.updated_at,
          receivedAt: new Date().toISOString(),
        });
      } else if (goal.status === 'active' && staleDays > 14) {
        // Active goal with no progress in 14+ days
        notifications.push({
          id: uuidv4(),
          source: 'services',
          severity: 'info',
          urgency: 'medium',
          status: 'unread',
          title: `Stale Goal: ${goal.title}`,
          body: `No progress recorded in ${Math.floor(staleDays)} days. Is this still active?`,
          category: 'goal_stale',
          sourceId: `goal:${goal.id}`,
          metadata: { goal_id: goal.id, title: goal.title, type: goal.type, stale_days: Math.floor(staleDays) },
          timestamp: goal.updated_at,
          receivedAt: new Date().toISOString(),
        });
      }
    }

    return notifications;
  };
}
