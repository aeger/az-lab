import { config } from '../config';
import { NotificationStore } from './store';
import { DiscordAlerter } from './discord-alert';
import { SoundDirector } from './sound-director';
import { Poller } from './poller';

export interface WeeklyHealthReport {
  reportDate: string;
  weekStart: string;
  weekEnd: string;
  uptimePercent: number;
  totalNotifications: number;
  bySource: Record<string, number>;
  topAlertTypes: { category: string; count: number }[];
  extensionReliabilityPercent: number;
  selfHealEvents: number;
  bySeverity: Record<string, number>;
  soundSuggestion?: string;
}

export class HealthReportScheduler {
  private timer: NodeJS.Timeout | null = null;
  private serviceStartTime = Date.now();

  constructor(
    private store: NotificationStore,
    private alerter: DiscordAlerter,
    private poller: Poller,
    private soundDirector: SoundDirector,
  ) {}

  start(): void {
    if (!config.discord.digestEnabled) return;
    this.scheduleNextSunday();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async buildReport(): Promise<WeeklyHealthReport> {
    const now = new Date();
    const weekEnd = now.toISOString().split('T')[0]!;
    const weekStartDate = new Date(now.getTime() - 7 * 86_400_000);
    const weekStart = weekStartDate.toISOString().split('T')[0]!;

    // Fetch last 7 days from Supabase
    const { notifications } = await this.store.queryHistory({ days: 7, limit: 2000 });

    // Count by source
    const bySource: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const n of notifications) {
      bySource[n.source] = (bySource[n.source] ?? 0) + 1;
      byCategory[n.category] = (byCategory[n.category] ?? 0) + 1;
      bySeverity[n.severity] = (bySeverity[n.severity] ?? 0) + 1;
    }

    // Top 3 alert types by category
    const topAlertTypes = Object.entries(byCategory)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    // Extension reliability: query guardian events from last 7 days
    const { selfHealEvents, extensionReliabilityPercent } = await this.queryGuardianStats(weekStartDate.toISOString());

    // Uptime: based on service uptime vs. 7 days
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const uptimeMs = Math.min(Date.now() - this.serviceStartTime, sevenDaysMs);
    const uptimePercent = Math.round((uptimeMs / sevenDaysMs) * 100);

    // Sound suggestion if available
    let soundSuggestion: string | undefined;
    try {
      const suggestion = await this.soundDirector.generateSuggestion();
      if (suggestion) {
        soundSuggestion = suggestion.suggestion;
        await this.soundDirector.saveSuggestion(suggestion);
      }
    } catch (err) {
      console.error('[health-report] sound suggestion failed:', (err as Error).message);
    }

    return {
      reportDate: weekEnd,
      weekStart,
      weekEnd,
      uptimePercent,
      totalNotifications: notifications.length,
      bySource,
      topAlertTypes,
      extensionReliabilityPercent,
      selfHealEvents,
      bySeverity,
      soundSuggestion,
    };
  }

  async runReport(): Promise<WeeklyHealthReport> {
    const report = await this.buildReport();
    try {
      await this.alerter.sendWeeklyReport(report);
      console.log(`[health-report] weekly report posted — ${report.totalNotifications} notifications for week of ${report.weekStart}`);
      await this.persistReport(report);
    } catch (err) {
      console.error('[health-report] failed to post to Discord:', (err as Error).message);
    }
    return report;
  }

  private scheduleNextSunday(): void {
    const now = new Date();
    const next = new Date();

    // Find next Sunday 8 AM
    const daysUntilSunday = (7 - now.getDay()) % 7;
    next.setDate(now.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
    next.setHours(config.discord.digestHour, 0, 0, 0);

    // If it's already Sunday but before 8 AM, schedule for today
    if (now.getDay() === 0 && now.getHours() < config.discord.digestHour) {
      next.setDate(now.getDate());
    }

    const msUntil = next.getTime() - now.getTime();
    const hoursUntil = Math.round(msUntil / 3_600_000);
    console.log(`[health-report] next weekly report at ${next.toISOString()} (${hoursUntil}h from now)`);

    this.timer = setTimeout(async () => {
      try {
        await this.runReport();
      } catch (err) {
        console.error('[health-report] run error:', (err as Error).message);
      }
      this.scheduleNextSunday();
    }, msUntil);
  }

  private async queryGuardianStats(since: string): Promise<{ selfHealEvents: number; extensionReliabilityPercent: number }> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) {
      return { selfHealEvents: 0, extensionReliabilityPercent: 100 };
    }

    try {
      const url = `${config.supabase.url}/rest/v1/sentinel_guardian_events`
        + `?created_at=gte.${encodeURIComponent(since)}`
        + `&select=event_type`
        + `&limit=500`;

      const res = await fetch(url, {
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
      });

      if (!res.ok) return { selfHealEvents: 0, extensionReliabilityPercent: 100 };

      const events = await res.json() as { event_type: string }[];
      const selfHealEvents = events.filter(e => e.event_type === 'self_healed').length;
      const deadEvents = events.filter(e => e.event_type === 'extension_dead').length;

      // Reliability: % of 5-min checks where extension was healthy
      // Approx: 7 days * 288 checks/day = 2016 check opportunities
      const totalChecks = Math.max(7 * 288, 1);
      const failedChecks = deadEvents;
      const extensionReliabilityPercent = Math.max(0, Math.round(((totalChecks - failedChecks) / totalChecks) * 100));

      return { selfHealEvents, extensionReliabilityPercent };
    } catch {
      return { selfHealEvents: 0, extensionReliabilityPercent: 100 };
    }
  }

  private async persistReport(report: WeeklyHealthReport): Promise<void> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return;

    const url = `${config.supabase.url}/rest/v1/sentinel_health_reports`;
    fetch(url, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        report_date: report.reportDate,
        report,
        posted_at: new Date().toISOString(),
      }),
    }).catch(err => console.warn('[health-report] persist failed:', err.message));
  }
}
