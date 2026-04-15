import { config } from '../config';
import { DiscordAlerter } from './discord-alert';
import { NotificationStore } from './store';
import { v4 as uuidv4 } from 'uuid';
import { SentinelNotification } from '../types';

const DEAD_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const MAX_DISCORD_ALERTS = 3; // alert Discord after 3 consecutive misses (15 min)

export interface ExtensionStatus {
  lastSeen: string | null;
  status: 'healthy' | 'stale' | 'never_seen';
  reconnectRequested: boolean;
  consecutiveMisses: number;
}

export class GuardianAgent {
  private timer: NodeJS.Timeout | null = null;
  private extensionLastSeen: Date | null = null;
  private reconnectRequested = false;
  private consecutiveMisses = 0;
  private alerter: DiscordAlerter;

  constructor(
    private store: NotificationStore,
    alerter?: DiscordAlerter,
  ) {
    this.alerter = alerter ?? new DiscordAlerter();
  }

  /** Called by extension on each heartbeat ping. */
  updateHeartbeat(extensionId: string = 'default', _userAgent?: string, _version?: string): void {
    const wasStale = this.isStale();
    this.extensionLastSeen = new Date();
    this.consecutiveMisses = 0;

    if (wasStale) {
      // Extension came back after being dead — log self-heal
      console.log('[guardian] extension reconnected after being stale');
      this.logGuardianEvent('self_healed', extensionId, { note: 'Extension reconnected' });
      this.reconnectRequested = false;
    }
  }

  /** Clear reconnect flag (called by extension after it re-initializes). */
  clearReconnect(): void {
    this.reconnectRequested = false;
  }

  getStatus(): ExtensionStatus {
    if (!this.extensionLastSeen) {
      return {
        lastSeen: null,
        status: 'never_seen',
        reconnectRequested: this.reconnectRequested,
        consecutiveMisses: this.consecutiveMisses,
      };
    }

    const stale = this.isStale();
    return {
      lastSeen: this.extensionLastSeen.toISOString(),
      status: stale ? 'stale' : 'healthy',
      reconnectRequested: this.reconnectRequested,
      consecutiveMisses: this.consecutiveMisses,
    };
  }

  start(): void {
    console.log('[guardian] starting — checking extension health every 5 min');
    this.timer = setInterval(() => this.check().catch(err =>
      console.error('[guardian] check error:', (err as Error).message),
    ), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private isStale(): boolean {
    if (!this.extensionLastSeen) return false; // never seen = different state
    return Date.now() - this.extensionLastSeen.getTime() > DEAD_THRESHOLD_MS;
  }

  private async check(): Promise<void> {
    // Extension never registered — nothing to guard yet
    if (!this.extensionLastSeen) return;

    if (!this.isStale()) {
      // Healthy — reset miss counter
      this.consecutiveMisses = 0;
      return;
    }

    this.consecutiveMisses++;
    const missedMin = Math.round((this.consecutiveMisses * CHECK_INTERVAL_MS) / 60_000);
    console.warn(`[guardian] extension listener appears dead (${missedMin}+ min since last heartbeat)`);

    // First miss: log notification + request reconnect
    if (this.consecutiveMisses === 1) {
      this.reconnectRequested = true;
      await this.logGuardianEvent('extension_dead', 'default', {
        lastSeen: this.extensionLastSeen.toISOString(),
        minutesSilent: missedMin,
      });

      // Add notification to the store so it shows in the dashboard
      const n: SentinelNotification = {
        id: uuidv4(),
        source: 'agent_health',
        severity: 'warning',
        status: 'unread',
        title: 'Extension listener was dead — restarted',
        body: `Edge Sentinel extension has not sent a heartbeat in ${missedMin}+ minutes. Reconnect requested.`,
        category: 'guardian_heal',
        sourceId: `guardian-dead-${Date.now()}`,
        timestamp: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      };
      this.store.add(n);
      await this.logGuardianEvent('reconnect_requested', 'default', { minutesSilent: missedMin });
    }

    // After MAX_DISCORD_ALERTS consecutive misses, escalate to Discord
    if (this.consecutiveMisses === MAX_DISCORD_ALERTS) {
      const minutesSilent = Math.round((Date.now() - this.extensionLastSeen.getTime()) / 60_000);
      console.error(`[guardian] extension unresponsive for ${minutesSilent} min — alerting Discord`);

      try {
        await this.alerter.sendRaw({
          embeds: [{
            title: '🛡️ Guardian Alert — Edge Sentinel Extension Unresponsive',
            description: [
              `The Edge Sentinel extension has not sent a heartbeat in **${minutesSilent} minutes**.`,
              `Last seen: <t:${Math.floor(this.extensionLastSeen.getTime() / 1000)}:R>`,
              '',
              'Reconnect has been requested. If you see this, check the extension in your browser.',
            ].join('\n'),
            color: 0xEF4444,
            timestamp: new Date().toISOString(),
            footer: { text: 'az-lab sentinel guardian' },
          }],
        });
        await this.logGuardianEvent('discord_alerted', 'default', { minutesSilent });
      } catch (err) {
        console.error('[guardian] failed to send Discord alert:', (err as Error).message);
      }
    }
  }

  private async logGuardianEvent(
    eventType: 'extension_dead' | 'reconnect_requested' | 'self_healed' | 'discord_alerted',
    extensionId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const key = config.supabase.serviceKey || config.supabase.anonKey;
    if (!config.supabase.url || !key) return;

    const url = `${config.supabase.url}/rest/v1/sentinel_guardian_events`;
    fetch(url, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ event_type: eventType, extension_id: extensionId, details }),
    }).catch(err => console.warn('[guardian] event log failed:', err.message));
  }
}
