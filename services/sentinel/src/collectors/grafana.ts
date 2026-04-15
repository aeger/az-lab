import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

export function createGrafanaCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const auth = Buffer.from(`${config.grafana.username}:${config.grafana.password}`).toString('base64');
    const res = await fetch(`${config.grafana.url}/api/alertmanager/grafana/api/v2/alerts?silenced=false&inhibited=false`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`Grafana ${res.status}: ${await res.text()}`);
    const alerts: any[] = await res.json() as any;

    return alerts
      .filter(a => a.status?.state === 'active')
      .map(a => {
        const labels = a.labels || {};
        const severity = labels.severity === 'critical' ? 'critical'
          : labels.severity === 'warning' ? 'warning' : 'info';

        return {
          id: uuidv4(),
          source: 'grafana' as const,
          severity,
          urgency: 'medium' as const,
          status: 'unread' as const,
          title: `Alert: ${labels.alertname || 'Unknown'}`,
          body: a.annotations?.summary || a.annotations?.description || '',
          category: `grafana_alert_${severity}`,
          sourceId: `grafana:${labels.alertname}:${labels.instance || ''}`,
          metadata: { labels, annotations: a.annotations },
          timestamp: a.startsAt || new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        };
      });
  };
}
