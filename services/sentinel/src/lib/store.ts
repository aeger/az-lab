import { config } from '../config';
import type { SentinelNotification, NotificationStatus, QueryOptions, NotificationsResponse, HistoryResponse } from '../types';
import { severityToUrgency } from '../types';

export interface NotificationSettings {
  sounds: Record<string, boolean>;
  thresholds: Record<string, number>;
  enabledSources: Record<string, boolean>;
  snoozeMinutes: number;
  fusionMode?: boolean;
}

export class NotificationStore {
  private notifications = new Map<string, SentinelNotification>();
  private seen = new Set<string>();
  private pruneTimer: NodeJS.Timeout | null = null;
  private onNewCallbacks: Array<(n: SentinelNotification) => void> = [];
  private persistErrors = new Map<string, number>();
  private settings: NotificationSettings | null = null;
  private snoozed = new Map<string, number>(); // key -> until timestamp

  onNew(cb: (n: SentinelNotification) => void) {
    this.onNewCallbacks.push(cb);
  }

  start() {
    this.pruneTimer = setInterval(() => this.prune(), config.store.pruneInterval);
  }

  stop() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  add(n: SentinelNotification): boolean {
    const dedupKey = `${n.source}:${n.category}:${n.sourceId}`;
    if (this.seen.has(dedupKey)) return false;
    this.seen.add(dedupKey);

    // Derive urgency
    n.urgency = severityToUrgency(n.severity, n.category);

    this.notifications.set(n.id, n);

    // Enforce max items — remove oldest
    if (this.notifications.size > config.store.maxItems) {
      const oldest = [...this.notifications.entries()]
        .sort((a, b) => new Date(a[1].receivedAt).getTime() - new Date(b[1].receivedAt).getTime());
      const toRemove = oldest.slice(0, this.notifications.size - config.store.maxItems);
      for (const [id, item] of toRemove) {
        this.notifications.delete(id);
        this.seen.delete(`${item.source}:${item.category}:${item.sourceId}`);
      }
    }

    // Persist to Supabase
    this.persistToSupabase(n).catch(err => {
      const count = (this.persistErrors.get(n.source) ?? 0) + 1;
      this.persistErrors.set(n.source, count);
      if (count === 1 || count % 50 === 0) {
        console.warn(`[store] supabase persist failed for ${n.source}/${n.category} (x${count}): ${err.message}`);
      }
    });

    for (const cb of this.onNewCallbacks) {
      try { cb(n); } catch { /* ignore */ }
    }
    return true;
  }

  markRead(id: string): boolean {
    const n = this.notifications.get(id);
    if (!n || n.status === 'read') return false;
    n.status = 'read';
    n.readAt = new Date().toISOString();
    this.updateSupabaseStatus(id, 'read').catch(() => {});
    return true;
  }

  markAllRead(filter?: { source?: string; urgency?: string }): number {
    let count = 0;
    for (const n of this.notifications.values()) {
      if (n.status !== 'unread') continue;
      if (filter?.source && n.source !== filter.source) continue;
      if (filter?.urgency && n.urgency !== filter.urgency) continue;
      n.status = 'read';
      n.readAt = new Date().toISOString();
      this.updateSupabaseStatus(n.id, 'read').catch(() => {});
      count++;
    }
    return count;
  }

  dismiss(id: string): boolean {
    const n = this.notifications.get(id);
    if (!n) return false;
    this.notifications.delete(id);
    this.updateSupabaseStatus(id, 'dismissed').catch(() => {});
    return true;
  }

  query(opts: QueryOptions = {}): NotificationsResponse {
    const { since, source, category, status, urgency, limit = 100 } = opts;
    let items = [...this.notifications.values()];

    if (since) {
      const sinceTime = new Date(since).getTime();
      items = items.filter(n => new Date(n.receivedAt).getTime() > sinceTime);
    }
    if (source) items = items.filter(n => n.source === source);
    if (category) items = items.filter(n => n.category === category);
    if (status) items = items.filter(n => n.status === status);
    if (urgency) items = items.filter(n => n.urgency === urgency);

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const all = [...this.notifications.values()];
    const unreadCount = all.filter(n => n.status === 'unread').length;
    const criticalCount = all.filter(n => n.status === 'unread' && n.urgency === 'critical').length;

    return { notifications: items.slice(0, limit), unreadCount, criticalCount };
  }

  async queryHistory(opts: QueryOptions & { days?: number } = {}): Promise<HistoryResponse> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) {
      return { notifications: [], total: 0, offset: 0 };
    }

    const { source, category, limit = 50, offset = 0, days = 30 } = opts;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    let url = `${config.supabase.url}/rest/v1/sentinel_notifications`
      + `?received_at=gte.${encodeURIComponent(since)}`
      + `&order=received_at.desc`
      + `&limit=${limit}`
      + `&offset=${offset}`;

    if (source) url += `&source=eq.${source}`;
    if (category) url += `&category=eq.${encodeURIComponent(category)}`;
    if (opts.status) url += `&status=eq.${opts.status}`;

    try {
      const res = await fetch(url, {
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Prefer': 'count=exact',
        },
      });
      if (!res.ok) throw new Error(`Supabase ${res.status}`);
      const rows: any[] = await res.json() as any[];
      const totalHeader = res.headers.get('content-range');
      const total = totalHeader ? parseInt(totalHeader.split('/')[1] || '0', 10) : rows.length;

      const notifications = rows.map(r => ({
        id: r.id,
        source: r.source,
        severity: r.severity,
        urgency: severityToUrgency(r.severity, r.category),
        status: r.status,
        title: r.title,
        body: r.body,
        category: r.category,
        sourceId: r.source_id,
        sourceUrl: r.source_url,
        metadata: r.metadata,
        timestamp: r.timestamp,
        receivedAt: r.received_at,
        readAt: r.read_at,
        dismissedAt: r.dismissed_at,
      } as SentinelNotification));

      return { notifications, total, offset };
    } catch (err: any) {
      console.error('[store] history query failed:', err.message);
      return { notifications: [], total: 0, offset };
    }
  }

  private async persistToSupabase(n: SentinelNotification): Promise<void> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return;

    const url = `${config.supabase.url}/rest/v1/sentinel_notifications`;
    const body = {
      id: n.id,
      source: n.source,           // must match notification_source enum
      severity: n.severity,
      status: n.status,
      title: n.title,
      body: n.body,
      category: n.category,       // free-form text — holds actual source type
      source_id: n.sourceId,
      source_url: n.sourceUrl ?? null,
      metadata: { ...(n.metadata ?? {}), urgency: n.urgency },
      timestamp: n.timestamp,
      received_at: n.receivedAt,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok && res.status !== 409) {
      const text = await res.text();
      throw new Error(`${res.status}: ${text}`);
    }
  }

  private async updateSupabaseStatus(id: string, status: NotificationStatus): Promise<void> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return;

    const url = `${config.supabase.url}/rest/v1/sentinel_notifications?id=eq.${id}`;
    const patch: Record<string, string> = { status };
    if (status === 'read') patch.read_at = new Date().toISOString();
    if (status === 'dismissed') patch.dismissed_at = new Date().toISOString();

    await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
  }

  private prune() {
    const cutoff = Date.now() - config.store.maxAge;
    for (const [id, n] of this.notifications) {
      if (new Date(n.receivedAt).getTime() < cutoff) {
        this.notifications.delete(id);
        this.seen.delete(`${n.source}:${n.category}:${n.sourceId}`);
      }
    }
  }

  async getSettings(): Promise<NotificationSettings | null> {
    if (this.settings) return this.settings;
    // Load from Supabase if configured
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (config.supabase.url && key) {
      try {
        const url = `${config.supabase.url}/rest/v1/sentinel_settings?select=*`;
        const res = await fetch(url, {
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
          },
        });
        if (res.ok) {
          const rows: any[] = await res.json();
          if (rows.length > 0) {
            this.settings = rows[0].settings as NotificationSettings;
            return this.settings;
          }
        }
      } catch (err) {
        console.error('[store] failed to load settings:', err);
      }
    }
    return null;
  }

  async saveSettings(settings: NotificationSettings): Promise<void> {
    this.settings = settings;
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (config.supabase.url && key) {
      try {
        const url = `${config.supabase.url}/rest/v1/sentinel_settings`;
        await fetch(url, {
          method: 'POST',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates',
          },
          body: JSON.stringify({ id: 'default', settings }),
        });
      } catch (err) {
        console.error('[store] failed to save settings:', err);
      }
    }
  }

  async setSnoozed(key: string, minutes: number): Promise<void> {
    const until = Date.now() + minutes * 60 * 1000;
    this.snoozed.set(key, until);
  }

  isSnoozed(key: string): boolean {
    const until = this.snoozed.get(key);
    if (!until) return false;
    if (Date.now() > until) {
      this.snoozed.delete(key);
      return false;
    }
    return true;
  }

  async checkExtensionHealth(extensionId: string): Promise<boolean> {
    // Check if extension has recent heartbeat
    // This is a simple check — in production, would query registered clients
    return true;
  }
}
