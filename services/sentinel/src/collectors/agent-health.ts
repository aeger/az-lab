import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

export function createAgentHealthCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    const url = `${config.supabase.url}/rest/v1/agent_heartbeat?select=*`;
    const res = await fetch(url, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const agents: any[] = await res.json() as any[];

    const notifications: SentinelNotification[] = [];
    for (const agent of agents) {
      if (agent.status === 'healthy' || agent.status === 'unknown') continue;

      const name = agent.agent.charAt(0).toUpperCase() + agent.agent.slice(1);
      let severity: 'critical' | 'warning' | 'info' = 'info';
      let title = `${name} agent status: ${agent.status}`;
      let body = '';

      switch (agent.status) {
        case 'critical':
          severity = 'critical';
          title = `${name} is unresponsive`;
          body = agent.breaker_tripped
            ? `Circuit breaker tripped after ${agent.restart_count_hour} restarts/hr. Manual restart required.`
            : 'Agent is not responding to canary probes.';
          break;
        case 'degraded':
          severity = 'warning';
          title = `${name} is degraded`;
          body = `Last heartbeat: ${agent.last_heartbeat ? new Date(agent.last_heartbeat).toLocaleString() : 'never'}.`;
          break;
        case 'restarting':
          severity = 'info';
          title = `${name} is restarting`;
          body = `Auto-restart triggered (${agent.restart_count_hour} restarts/hr). Recovery in progress.`;
          break;
        case 'down':
          severity = 'critical';
          title = `${name} is down`;
          body = 'Process not running. Systemd restart pending.';
          break;
      }

      notifications.push({
        id: uuidv4(),
        source: 'services',           // 'agent_health' not in enum — map to 'services'
        severity,
        urgency: 'medium',
        status: 'unread',
        title,
        body,
        category: `agent_health_${agent.status}`,  // category distinguishes this
        sourceId: agent.agent,
        metadata: {
          agent: agent.agent,
          prompt_count: agent.prompt_count,
          restart_count_hour: agent.restart_count_hour,
          breaker_tripped: agent.breaker_tripped,
          ...agent.metadata,
        },
        timestamp: agent.updated_at,
        receivedAt: new Date().toISOString(),
      });
    }
    return notifications;
  };
}
