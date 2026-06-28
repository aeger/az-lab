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

export class SupabaseReporter {
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
    const payload = {
      agent: 'wren-watchdog',
      activity_type: activityType,
      content,
      metadata,
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
    severity: 'critical' | 'high' | 'warn' | 'info',
    title: string,
    body: string,
    sourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const payload = {
      source: 'wren_watchdog',
      severity,
      status: 'unread',
      title,
      body,
      category: 'agent_hang',
      source_id: sourceId,
      urgency: severity === 'critical' ? 'high' : 'normal',
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
