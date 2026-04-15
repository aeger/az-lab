import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

let lastMessageId: string | null = null;

export function createDiscordCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const url = lastMessageId
      ? `https://discord.com/api/v10/channels/${config.discord.channelId}/messages?after=${lastMessageId}&limit=10`
      : `https://discord.com/api/v10/channels/${config.discord.channelId}/messages?limit=5`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bot ${config.discord.botToken}` },
    });
    if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
    const messages: any[] = await res.json() as any[];
    if (!messages.length) return [];

    // Track newest message
    messages.sort((a, b) => b.id.localeCompare(a.id));
    lastMessageId = messages[0].id;

    return messages
      .filter(m => !m.author?.bot) // ignore bot messages to avoid loops
      .map(m => ({
        id: uuidv4(),
        source: 'discord' as const,
        severity: 'info' as const,
        urgency: 'low' as const,
        status: 'unread' as const,
        title: `Discord: ${m.author?.username || 'unknown'}`,
        body: m.content?.slice(0, 500) || '',
        category: 'discord_message',
        sourceId: m.id,
        sourceUrl: `https://discord.com/channels/${m.guild_id || '@me'}/${config.discord.channelId}/${m.id}`,
        metadata: { author: m.author?.username, channel: config.discord.channelId },
        timestamp: m.timestamp,
        receivedAt: new Date().toISOString(),
      }));
  };
}
