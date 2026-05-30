import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import type { SentinelNotification } from '../types';

// Jeff does not want an alert for every message he posts — he knows he posted.
// The ONLY Discord signal worth surfacing: Wren asked Jeff a question and Jeff
// hasn't answered in 5+ minutes. So this collector watches the latest channel
// message and emits a single "waiting on your reply" nudge when that holds.

const QUESTION_NUDGE_MS = 5 * 60 * 1000; // 5 minutes

// Bot status/interim lines are not questions to Jeff — skip anything that starts
// with one of these markers even if it happens to contain a '?'.
const STATUS_PREFIXES = [
  '🔄', '🟡', '✅', '📋', '🛡️', '⏳', '🔍', '📚', '⏱️', '🙋', '🧪', '🚨', '📈', '🔧', '⚠️',
];

// We only nudge once per unanswered question. Cleared when a human replies.
let alertedQuestionId: string | null = null;

function isStatusMessage(content: string): boolean {
  return STATUS_PREFIXES.some(p => content.startsWith(p));
}

// A real question to Jeff: the message text ends with '?' (after trimming
// trailing whitespace / closing markdown). Conservative on purpose — better to
// miss an edge case than to nag on a non-question.
function looksLikeQuestion(content: string): boolean {
  const trimmed = content.replace(/[\s`*_>)\]]+$/g, '');
  return trimmed.endsWith('?');
}

export function createDiscordCollector() {
  return async (): Promise<SentinelNotification[]> => {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${config.discord.channelId}/messages?limit=10`,
      { headers: { 'Authorization': `Bot ${config.discord.botToken}` } },
    );
    if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
    const messages: any[] = await res.json() as any[];
    if (!messages.length) return [];

    // Discord returns newest-first; messages[0] is the latest message in channel.
    messages.sort((a, b) => b.id.localeCompare(a.id));
    const latest = messages[0];

    const isBot = !!latest.author?.bot;
    const content = (latest.content || '').trim();

    // Human posted most recently → Jeff is engaged / has replied. No alert; reset.
    if (!isBot) {
      alertedQuestionId = null;
      return [];
    }

    // Latest message is from Wren (bot). Only nudge if it's an unanswered question.
    const ageMs = Date.now() - new Date(latest.timestamp).getTime();
    const isUnansweredQuestion =
      looksLikeQuestion(content) &&
      !isStatusMessage(content) &&
      ageMs >= QUESTION_NUDGE_MS &&
      alertedQuestionId !== latest.id;

    if (!isUnansweredQuestion) return [];

    alertedQuestionId = latest.id;
    return [{
      id: uuidv4(),
      source: 'discord' as const,
      severity: 'warning' as const, // → high urgency; this is the one alert Jeff asked for
      urgency: 'high' as const,
      status: 'unread' as const,
      title: 'Wren is waiting on your reply',
      body: content.slice(0, 500),
      category: 'discord_needs_reply',
      sourceId: latest.id,
      sourceUrl: `https://discord.com/channels/${latest.guild_id || '@me'}/${config.discord.channelId}/${latest.id}`,
      metadata: { author: latest.author?.username, channel: config.discord.channelId, ageMinutes: Math.round(ageMs / 60000) },
      timestamp: latest.timestamp,
      receivedAt: new Date().toISOString(),
    }];
  };
}
