import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

// Specific entity IDs to monitor
const WATCH_ENTITIES = [
  'update.home_assistant_core_update',
  'update.home_assistant_supervisor_update',
  'update.home_assistant_operating_system_update',
];

export function createHACollector() {
  return async (): Promise<SentinelNotification[]> => {
    const notifications: SentinelNotification[] = [];
    const headers = {
      'Authorization': `Bearer ${config.ha.accessToken}`,
      'Content-Type': 'application/json',
    };

    // Check for triggered alarms
    const alarmRes = await fetch(`${config.ha.url}/api/states`, { headers });
    if (!alarmRes.ok) throw new Error(`HA ${alarmRes.status}: ${await alarmRes.text()}`);
    const allStates: any[] = await alarmRes.json() as any[];

    for (const entity of allStates) {
      // Triggered alarms
      if (entity.entity_id.startsWith('alarm_control_panel.') && entity.state === 'triggered') {
        notifications.push({
          id: uuidv4(),
          source: 'home_assistant',
          severity: 'critical',
          urgency: 'critical',
          status: 'unread',
          title: `ALARM TRIGGERED: ${entity.attributes?.friendly_name || entity.entity_id}`,
          body: 'Security alarm has been triggered in Home Assistant!',
          category: 'ha_alarm_triggered',
          sourceId: entity.entity_id,
          metadata: { entity_id: entity.entity_id, state: entity.state },
          timestamp: entity.last_changed || new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        });
      }

      // Updates available
      if (WATCH_ENTITIES.includes(entity.entity_id) && entity.state === 'on') {
        const name = entity.attributes?.title || entity.entity_id.replace('update.', '').replace(/_/g, ' ');
        notifications.push({
          id: uuidv4(),
          source: 'home_assistant',
          severity: 'info',
          urgency: 'low',
          status: 'unread',
          title: `Update Available: ${name}`,
          body: `${name}: ${entity.attributes?.installed_version || 'current'} → ${entity.attributes?.latest_version || 'new'}`,
          category: 'ha_update_available',
          sourceId: entity.entity_id,
          metadata: entity.attributes,
          timestamp: entity.last_changed || new Date().toISOString(),
          receivedAt: new Date().toISOString(),
        });
      }
    }

    return notifications;
  };
}
