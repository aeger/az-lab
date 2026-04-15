import { config } from '../config';
import type { SentinelNotification } from '../types';

const URGENCY_EMOJI: Record<string, string> = {
  critical: '🚨',
  high: '⚠️',
  medium: '🔔',
  low: 'ℹ️',
};

const URGENCY_COLOR: Record<string, number> = {
  critical: 0xFF0000,
  high: 0xFF8C00,
  medium: 0xFFD700,
  low: 0x00BFFF,
};

export class DiscordAlerter {
  async sendAlert(n: SentinelNotification): Promise<void> {
    if (!config.discord.botToken || !config.discord.alertChannelId) return;

    const emoji = URGENCY_EMOJI[n.urgency] || '🔔';
    const color = URGENCY_COLOR[n.urgency] || 0x808080;

    const embed = {
      title: `${emoji} ${n.title}`,
      description: n.body?.slice(0, 400) || undefined,
      color,
      fields: [
        { name: 'Source', value: n.category || n.source, inline: true },
        { name: 'Urgency', value: n.urgency.toUpperCase(), inline: true },
        { name: 'ID', value: n.id.slice(0, 8), inline: true },
      ],
      timestamp: n.timestamp,
      footer: { text: 'JeffSentinel v2' },
    };

    const payload = {
      embeds: [embed],
    };

    const url = `https://discord.com/api/v10/channels/${config.discord.alertChannelId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${config.discord.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }
}
