// Notification urgency levels (new unified system)
export type Urgency = 'critical' | 'high' | 'medium' | 'low';

// Legacy severity (kept for Supabase enum compatibility)
export type Severity = 'critical' | 'warning' | 'info';

// notification_source enum values in Supabase (DO NOT add new values without altering enum)
export type NotificationSource = 'task_queue' | 'home_assistant' | 'discord' | 'grafana' | 'services';

export type NotificationStatus = 'unread' | 'read' | 'dismissed';

export interface SentinelNotification {
  id: string;
  source: NotificationSource;
  severity: Severity;
  urgency: Urgency;  // derived — not stored in DB, computed in API responses
  status: NotificationStatus;
  title: string;
  body: string;
  category: string;
  sourceId: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  receivedAt: string;
  readAt?: string;
  dismissedAt?: string;
}

export interface QueryOptions {
  since?: string;
  source?: string;
  category?: string;
  status?: NotificationStatus;
  urgency?: Urgency;
  limit?: number;
  offset?: number;
}

export interface NotificationsResponse {
  notifications: SentinelNotification[];
  unreadCount: number;
  criticalCount: number;
}

export interface HistoryResponse {
  notifications: SentinelNotification[];
  total: number;
  offset: number;
}

// Map Supabase severity → urgency
export function severityToUrgency(severity: Severity, category?: string): Urgency {
  if (severity === 'critical') return 'critical';
  if (severity === 'warning') {
    // Downgrade certain warning categories to medium
    if (category?.includes('stale') || category?.includes('info')) return 'medium';
    return 'high';
  }
  // info
  if (category?.includes('down') || category?.includes('failed')) return 'high';
  if (category?.includes('degraded') || category?.includes('restarting')) return 'medium';
  return 'low';
}
