import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

const CRITICAL_SERVICES = ['traefik', 'authelia', 'prometheus', 'grafana', 'lldap', 'adguard', 'memory-mcp'];

export function createServicesCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const res = await fetch(`${config.prometheus.url}/api/v1/query?query=up%3D%3D0`);
    if (!res.ok) throw new Error(`Prometheus ${res.status}: ${await res.text()}`);
    const data: any = await res.json() as any[];
    if (data.status !== 'success') throw new Error(`Prometheus query failed: ${data.status}`);

    return data.data.result.map((result: any) => {
      const job = result.metric.job || 'unknown';
      const instance = result.metric.instance || 'unknown';
      const isCritical = CRITICAL_SERVICES.some(s => job.toLowerCase().includes(s) || instance.toLowerCase().includes(s));

      return {
        id: uuidv4(),
        source: 'services' as const,
        severity: isCritical ? 'critical' : 'warning',
        urgency: 'medium',
        status: 'unread' as const,
        title: `Down: ${job}`,
        body: `Target ${instance} (job: ${job}) is not responding`,
        category: 'service_down',
        sourceId: `prom:${job}:${instance}`,
        metadata: { job, instance, labels: result.metric },
        timestamp: new Date(result.value[0] * 1000).toISOString(),
        receivedAt: new Date().toISOString(),
      };
    });
  };
}
