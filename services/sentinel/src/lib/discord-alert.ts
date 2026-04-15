import { config } from '../config';
import { SentinelNotification } from '../types';
import type { WeeklyHealthReport } from './health-report';

const DISCORD_API = 'https://discord.com/api/v10';

const SEVERITY_COLORS: Record<string, number> = {
  critical: 0xEF4444, // red
  warning:  0xF59E0B, // amber
  info:     0x3B82F6, // blue
};

const SOURCE_EMOJI: Record<string, string> = {
  task_queue:    '📋',
  home_assistant:'🏠',
  discord:       '💬',
  grafana:       '📊',
  services:      '⚙️',
  agent_health:  '🤖',
};

export interface DigestSummary {
  date: string;
  total: number;
  bySeverity: Record<string, number>;
  bySource: Record<string, number>;
  topItems: { title: string; severity: string; source: string }[];
}

export class DiscordAlerter {
  private get enabled(): boolean {
    return !!(config.discord.botToken && config.discord.alertChannelId);
  }

  async sendAlert(n: SentinelNotification): Promise<void> {
    if (!this.enabled) return;

    const emoji = SOURCE_EMOJI[n.source] ?? '🔔';
    const color = SEVERITY_COLORS[n.severity] ?? SEVERITY_COLORS.info;

    const body = {
      embeds: [{
        title: `${emoji} ${n.title}`,
        description: n.body.slice(0, 4096),
        color,
        fields: [
          { name: 'Source', value: n.source, inline: true },
          { name: 'Severity', value: n.severity.toUpperCase(), inline: true },
          { name: 'Category', value: n.category, inline: true },
        ],
        timestamp: n.timestamp,
        footer: { text: 'az-lab sentinel' },
      }],
    };

    await this.post(body);
  }

  async sendDigest(digest: DigestSummary): Promise<void> {
    if (!this.enabled) return;

    const lines: string[] = [];
    lines.push(`**Total:** ${digest.total} notifications`);
    lines.push(
      `**Critical:** ${digest.bySeverity['critical'] ?? 0}` +
      `  |  **Warnings:** ${digest.bySeverity['warning'] ?? 0}` +
      `  |  **Info:** ${digest.bySeverity['info'] ?? 0}`,
    );

    if (Object.keys(digest.bySource).length > 0) {
      lines.push('');
      lines.push('**By Source:**');
      for (const [src, count] of Object.entries(digest.bySource)) {
        const emoji = SOURCE_EMOJI[src] ?? '•';
        lines.push(`${emoji} \`${src}\`: ${count}`);
      }
    }

    if (digest.topItems.length > 0) {
      lines.push('');
      lines.push('**Notable:**');
      for (const item of digest.topItems.slice(0, 5)) {
        lines.push(`• [${item.severity.toUpperCase()}] ${item.title}`);
      }
    }

    const hasCritical = (digest.bySeverity['critical'] ?? 0) > 0;

    const body = {
      embeds: [{
        title: `📊 Daily Digest — ${digest.date}`,
        description: lines.join('\n'),
        color: hasCritical ? SEVERITY_COLORS.critical : SEVERITY_COLORS.info,
        timestamp: new Date().toISOString(),
        footer: { text: 'az-lab sentinel' },
      }],
    };

    await this.post(body);
  }

  /** Send a raw Discord message body (for Guardian and other custom embeds). */
  async sendRaw(body: unknown): Promise<void> {
    if (!this.enabled) return;
    await this.post(body);
  }

  async sendWeeklyReport(report: WeeklyHealthReport): Promise<void> {
    if (!this.enabled) return;

    const sourceEmoji: Record<string, string> = {
      task_queue: '📋', home_assistant: '🏠', discord: '💬',
      grafana: '📊', services: '⚙️', agent_health: '🤖', goals: '🎯',
    };

    const lines: string[] = [];
    lines.push(`**Week:** ${report.weekStart} → ${report.weekEnd}`);
    lines.push(`**Uptime:** ${report.uptimePercent}%  |  **Edge Sentinel:** ${report.extensionReliabilityPercent}% reliable`);
    lines.push(`**Total notifications:** ${report.totalNotifications}`);
    lines.push('');

    if (report.selfHealEvents > 0) {
      lines.push(`⚠️ **Self-heal events this week:** ${report.selfHealEvents}`);
      lines.push('');
    }

    if (Object.keys(report.bySource).length > 0) {
      lines.push('**By Source:**');
      for (const [src, count] of Object.entries(report.bySource).sort((a, b) => b[1] - a[1])) {
        lines.push(`${sourceEmoji[src] ?? '•'} \`${src}\`: ${count}`);
      }
      lines.push('');
    }

    if (report.topAlertTypes.length > 0) {
      lines.push('**Top Alert Types:**');
      for (const { category, count } of report.topAlertTypes) {
        lines.push(`• \`${category}\`: ${count}`);
      }
    }

    const fields = [];
    const critical = report.bySeverity['critical'] ?? 0;
    const warnings = report.bySeverity['warning'] ?? 0;
    const info = report.bySeverity['info'] ?? 0;
    fields.push({ name: 'Severity Breakdown', value: `🔴 Critical: ${critical}  🟡 Warning: ${warnings}  🔵 Info: ${info}`, inline: false });

    if (report.soundSuggestion) {
      fields.push({ name: '🔊 Sound Director Suggestion', value: report.soundSuggestion.slice(0, 1024), inline: false });
    }

    const color = critical > 0 ? 0xEF4444 : warnings > 0 ? 0xF59E0B : 0x10B981;

    const body = {
      embeds: [{
        title: `📋 Weekly Notification Health Report — ${report.reportDate}`,
        description: lines.join('\n'),
        color,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: 'az-lab sentinel · weekly report' },
      }],
    };

    await this.post(body);
  }

  private async post(body: unknown): Promise<void> {
    const res = await fetch(
      `${DISCORD_API}/channels/${config.discord.alertChannelId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${config.discord.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Discord send failed ${res.status}: ${text}`);
    }
  }
}
