/**
 * supabase-reporter.ts — Reports watchdog status to Supabase agent_heartbeat table
 * Never throws — falls back to local log when Supabase is unreachable
 */

import { LocalLogger } from './logger.js';

export type FetchFn = typeof fetch;

export interface SupabaseReporterConfig {
  supabaseUrl: string;
  serviceKey: string;
  /** Injectable fetch for testing */
  fetchFn?: FetchFn;
  /** Fallback log when Supabase is unreachable */
  fallbackLogFile?: string;
}

/** Members of the notification_severity enum — anything else is a 400. */
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export class SupabaseReporter {
  /** Members of the agent_activity.activity_type CHECK constraint. */
  private static readonly ACTIVITY_TYPES = new Set([
    'thinking', 'tool_call', 'result', 'status', 'error', 'progress',
  ]);

  private readonly config: SupabaseReporterConfig;
  private readonly fetchFn: FetchFn;
  private readonly fallbackLogger: LocalLogger | null;

  constructor(config: SupabaseReporterConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
    this.fallbackLogger = config.fallbackLogFile
      ? new LocalLogger(config.fallbackLogFile)
      : null;
  }

  async updateStatus(status: string, metadata: Record<string, unknown>): Promise<void> {
    const payload = {
      status,
      metadata,
      updated_at: new Date().toISOString(),
    };

    try {
      const url = `${this.config.supabaseUrl}/rest/v1/agent_heartbeat?agent=eq.wren`;
      const res = await this.fetchFn(url, {
        method: 'PATCH',
        headers: {
          'apikey': this.config.serviceKey,
          'Authorization': `Bearer ${this.config.serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        await this.writeFallback(status, metadata, `HTTP ${res.status}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.writeFallback(status, metadata, error);
    }
  }

  /**
   * Log a watchdog action to agent_activity. Used to record reasoning BEFORE
   * a restart (per wren_constitution principle 2 — agents must persist their
   * reasoning before taking action). The watchdog is not Wren itself, but it
   * acts on Wren's behalf so the audit row is filed under agent='wren-watchdog'.
   */
  async logActivity(
    activityType: string,
    content: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // agent_activity.activity_type is CHECK-constrained to this set. Callers
    // pass a semantic event name ('hang_detected', 'channel_deaf'), which the
    // database rejects with a 400 — so every audit row this method has ever
    // written for those events went to the local fallback log instead of the
    // table it was meant to reach (found 2026-09-05). Keep the caller's label
    // in metadata.event and file the row under a permitted type. Both current
    // callers report faults, hence 'error'.
    const allowed = SupabaseReporter.ACTIVITY_TYPES.has(activityType);
    const payload = {
      agent: 'wren-watchdog',
      activity_type: allowed ? activityType : 'error',
      content,
      metadata: allowed ? metadata : { ...metadata, event: activityType },
      created_at: new Date().toISOString(),
    };
    try {
      const url = `${this.config.supabaseUrl}/rest/v1/agent_activity`;
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'apikey': this.config.serviceKey,
          'Authorization': `Bearer ${this.config.serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        await this.writeFallback(`activity:${activityType}`, metadata, `HTTP ${res.status}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.writeFallback(`activity:${activityType}`, metadata, error);
    }
  }

  /**
   * Insert a sentinel_notifications row (drives the dashboard alert ribbon and
   * mirrors the path used by anomaly-heartbeat.py). Critical hang detections
   * page through this channel in addition to Discord.
   */
  async emitSentinelNotification(
    severity: NotificationSeverity,
    title: string,
    body: string,
    sourceId: string,
    metadata: Record<string, unknown>,
    category = 'agent_hang',
  ): Promise<void> {
    // Three of these fields are constrained and all three were wrong, so no
    // watchdog notification has ever reached the dashboard ribbon (2026-09-05):
    //   source   — enum notification_source, which has no 'wren_watchdog';
    //              'agent_health' is the member this belongs to
    //   severity — enum notification_severity is {info, warning, critical};
    //              the old signature also offered 'high' and 'warn'
    //   urgency  — CHECK {critical, high, medium, low}; 'normal' is not one
    const payload = {
      source: 'agent_health',
      severity,
      status: 'unread',
      title,
      body,
      category,
      source_id: sourceId,
      urgency: severity === 'critical' ? 'critical' : 'medium',
      metadata,
    };
    try {
      const url = `${this.config.supabaseUrl}/rest/v1/sentinel_notifications`;
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'apikey': this.config.serviceKey,
          'Authorization': `Bearer ${this.config.serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        await this.writeFallback(`sentinel:${severity}`, metadata, `HTTP ${res.status}`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.writeFallback(`sentinel:${severity}`, metadata, error);
    }
  }

  async updateLastRestart(restartAt: string, restartCountHour: number): Promise<void> {
    try {
      const url = `${this.config.supabaseUrl}/rest/v1/agent_heartbeat?agent=eq.wren`;
      await this.fetchFn(url, {
        method: 'PATCH',
        headers: {
          'apikey': this.config.serviceKey,
          'Authorization': `Bearer ${this.config.serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          last_restart: restartAt,
          restart_count_hour: restartCountHour,
          updated_at: new Date().toISOString(),
        }),
      });
    } catch {
      // Swallow — continue even if Supabase is down
    }
  }

  private async writeFallback(
    status: string,
    metadata: Record<string, unknown>,
    error: string
  ): Promise<void> {
    if (this.fallbackLogger) {
      const msg = `[Supabase fallback] status=${status} meta=${JSON.stringify(metadata)} (error: ${error})`;
      await this.fallbackLogger.log(msg).catch(() => {});
    }
  }
}
