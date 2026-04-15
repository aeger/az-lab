import { config } from '../config';
import type { NotificationStore } from './store';
import { DiscordAlerter } from './discord-alert';

export class DigestScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: NotificationStore,
    private alerter: DiscordAlerter,
  ) {}

  start() {
    if (!config.discord.digestEnabled) return;
    this.scheduleNext();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(config.discord.digestHour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const msUntil = next.getTime() - now.getTime();
    console.log(`[digest] next run at ${next.toISOString()} (${Math.round(msUntil / 60000)} min from now)`);

    this.timer = setTimeout(async () => {
      await this.sendDigest();
      this.scheduleNext();
    }, msUntil);
  }

  private async sendDigest() {
    if (!config.discord.botToken || !config.discord.channelId) return;

    const { notifications, unreadCount, criticalCount } = this.store.query({ status: 'unread', limit: 200 });
    if (unreadCount === 0) return;

    const byUrgency: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    const bySource: Record<string, number> = {};

    for (const n of notifications) {
      byUrgency[n.urgency] = (byUrgency[n.urgency] || 0) + 1;
      bySource[n.category] = (bySource[n.category] || 0) + 1;
    }

    const lines = [
      `**JeffSentinel Daily Digest** — ${unreadCount} unread notifications`,
      '',
      `🚨 Critical: **${byUrgency.critical}**  ⚠️ High: **${byUrgency.high}**  🔔 Medium: **${byUrgency.medium}**  ℹ️ Low: **${byUrgency.low}**`,
      '',
      '**By category:**',
      ...Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([cat, count]) => `• ${cat}: ${count}`),
    ];

    if (criticalCount > 0) {
      lines.push('', '**Critical items:**');
      for (const n of notifications.filter(x => x.urgency === 'critical').slice(0, 3)) {
        lines.push(`• ${n.title}`);
      }
    }

    const url = `https://discord.com/api/v10/channels/${config.discord.channelId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${config.discord.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: lines.join('\n').slice(0, 2000) }),
    });
  }
}
