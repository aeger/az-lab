// Sentinel API client for Lumen background service worker
import { getConfig } from '../shared/config';
import type { SentinelNotification } from '../shared/types';

interface NotifResponse {
  notifications: SentinelNotification[];
  unreadCount: number;
  criticalCount: number;
}

export async function fetchSentinelNotifications(status?: string, limit = 50): Promise<NotifResponse> {
  const config = await getConfig();
  const url = config.sentinelApiUrl;
  const key = config.sentinelApiKey;

  const params = new URLSearchParams({ limit: String(limit) });
  if (status) params.set('status', status);

  const res = await fetch(`${url}/api/notifications?${params}`, {
    headers: {
      'X-Sentinel-Key': key,
    },
  });

  if (!res.ok) throw new Error(`Sentinel ${res.status}`);
  return res.json() as Promise<NotifResponse>;
}

export async function markSentinelRead(id: string): Promise<void> {
  const config = await getConfig();
  await fetch(`${config.sentinelApiUrl}/api/notifications/${id}/read`, {
    method: 'POST',
    headers: { 'X-Sentinel-Key': config.sentinelApiKey },
  });
}

export async function markAllSentinelRead(): Promise<void> {
  const config = await getConfig();
  await fetch(`${config.sentinelApiUrl}/api/notifications/read-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sentinel-Key': config.sentinelApiKey },
    body: '{}',
  });
}
